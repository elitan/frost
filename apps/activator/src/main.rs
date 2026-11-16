//! frost-activator: wakes sleeping (scale-to-zero) workloads on connection.
//!
//! Two modes (ACTIVATOR_MODE):
//!
//! `standby` (default): a temporary stand-in for a sleeping service. Frost
//! runs it under the service's hostname while the service sleeps. The first
//! connection triggers one wake request to Frost; connections arriving
//! meanwhile are held, then forwarded as raw TCP once Frost answers with the
//! service's addresses. After the wake, Docker resolves the hostname to both
//! this stand-in and the real containers, so the stand-in gets out of the way:
//! it exits once idle, or after lingering ACTIVATOR_MAX_LINGER_SECS (at the
//! first moment no connection is open, cutting any left after a further drain
//! period).
//!
//! `resident`: a permanent proxy in front of a database. It owns the
//! database's hostname for good and forwards to the address Frost returns
//! (the database container's name, resolved on every connection). When that
//! address stops answering (slept, stopped, recreated), it asks Frost again,
//! which wakes the database if needed. Frost coordinates sleeping through a
//! control port bound to the container's loopback (see `ctl`):
//!   pause   hold new connections; hold back client bytes on forwarded
//!           ones (any arriving marks the pause "touched")
//!   commit  if untouched, close every forwarded connection and answer ok;
//!           otherwise answer busy (Frost resumes and calls the sleep off)
//!   sleep   the database is stopped; held/new connections trigger a wake
//!   resume  forward again (sleep was called off)
//!   status  phase, connection counts and idle_secs (since the last byte or
//!           connection event; Frost's idle check uses it)
//! A pause expires after ACTIVATOR_MAX_PAUSE_SECS, in case Frost goes away.
//!
//! Traffic is never inspected, so TLS passes through untouched.
//!
//! Configuration (environment):
//!   ACTIVATOR_PORTS              comma-separated ports to listen on (required)
//!   ACTIVATOR_WAKE_URL           http://host:port/path to POST to (required)
//!   ACTIVATOR_TOKEN              bearer token for the wake request (required)
//!   ACTIVATOR_MODE               standby | resident (standby)
//!   ACTIVATOR_WAKE_TIMEOUT_SECS  max time a connection waits for a wake (120)
//!   ACTIVATOR_MAX_PENDING        max connections held while waking (1024)
//!   standby only:
//!   ACTIVATOR_IDLE_EXIT_SECS     exit after this long idle once awake (10)
//!   ACTIVATOR_MAX_LINGER_SECS    max time to keep proxying after a wake (30)
//!   resident only:
//!   ACTIVATOR_CONTROL_PORT       loopback control port (7999)
//!   ACTIVATOR_MAX_PAUSE_SECS     a pause expires after this long (60)
//!
//! `frost-activator ctl <command>` sends a command to the resident process in
//! the same container (for `docker exec`) and prints its answer.
//! `frost-activator probe <url>` exits 0 if the URL answers 200 (Frost's
//! startup check that containers can reach its wake endpoint).

use std::collections::HashMap;
use std::env;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::process;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

const CONNECT_RETRIES: u32 = 20;
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(250);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Resident mode tries the known address briefly before asking Frost again.
const QUICK_CONNECT_RETRIES: u32 = 2;
const QUICK_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const FAILED_WAKE_BACKOFF: Duration = Duration::from_secs(1);
const THREAD_STACK_BYTES: usize = 64 * 1024;
/// After the linger time, connections still open are cut after this long.
const DRAIN_HARD_CAP: Duration = Duration::from_secs(30);
const EXIT_POLL: Duration = Duration::from_millis(50);
const CONTROL_IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Standby,
    Resident,
}

#[derive(Clone)]
struct Config {
    mode: Mode,
    ports: Vec<u16>,
    wake_host: String,
    wake_port: u16,
    wake_path: String,
    token: String,
    wake_timeout: Duration,
    idle_exit: Duration,
    max_linger: Duration,
    max_pending: usize,
    control_port: u16,
    max_pause: Duration,
}

#[derive(Debug)]
enum Phase {
    Asleep,
    Waking,
    /// Hosts (IPs or names) to forward to.
    Awake(Vec<String>),
    Failed(Instant),
    /// Resident only: Frost is putting the workload to sleep; hold new
    /// connections. `hosts` is where to go if the sleep is called off.
    Paused {
        since: Instant,
        hosts: Option<Vec<String>>,
    },
}

impl Phase {
    fn name(&self) -> &'static str {
        match self {
            Phase::Asleep => "asleep",
            Phase::Waking => "waking",
            Phase::Awake(_) => "awake",
            Phase::Failed(_) => "failed",
            Phase::Paused { .. } => "paused",
        }
    }
}

/// Resident only: what a pause does to connections already forwarding.
/// Client bytes are held back while paused; any arriving marks the pause as
/// touched, which makes `commit` refuse (the sleep is called off and the
/// bytes flow on resume). `commit` closes every forwarded connection at once,
/// so no query can reach a database that is about to stop.
#[derive(Default)]
struct Gate {
    paused_since: Option<Instant>,
    touched: bool,
    committed: bool,
    next_id: u64,
    /// Forwarded connections: (client, upstream).
    conns: HashMap<u64, (TcpStream, TcpStream)>,
}

impl Gate {
    fn clear(&mut self) {
        self.paused_since = None;
        self.touched = false;
        self.committed = false;
    }
}

struct Shared {
    phase: Mutex<Phase>,
    changed: Condvar,
    gate: Mutex<Gate>,
    gate_changed: Condvar,
    max_pause: Duration,
    /// Connections accepted and not yet closed (held + forwarding).
    active: AtomicUsize,
    /// Connections waiting for the workload to be available.
    pending: AtomicUsize,
    round_robin: AtomicUsize,
    last_activity: Mutex<Instant>,
    awake_at: Mutex<Option<Instant>>,
    /// Milliseconds since `started` of the last byte or connection event.
    started: Instant,
    last_traffic_ms: AtomicU64,
}

impl Shared {
    fn new(max_pause: Duration) -> Self {
        Shared {
            phase: Mutex::new(Phase::Asleep),
            changed: Condvar::new(),
            gate: Mutex::new(Gate::default()),
            gate_changed: Condvar::new(),
            max_pause,
            active: AtomicUsize::new(0),
            pending: AtomicUsize::new(0),
            round_robin: AtomicUsize::new(0),
            last_activity: Mutex::new(Instant::now()),
            awake_at: Mutex::new(None),
            started: Instant::now(),
            last_traffic_ms: AtomicU64::new(0),
        }
    }

    fn phase(&self) -> MutexGuard<'_, Phase> {
        self.phase.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn touch(&self) {
        let ms = self.started.elapsed().as_millis() as u64;
        self.last_traffic_ms.fetch_max(ms, Ordering::Relaxed);
    }

    /// Seconds since the last byte or connection event.
    fn idle_secs(&self) -> u64 {
        let now = self.started.elapsed().as_millis() as u64;
        now.saturating_sub(self.last_traffic_ms.load(Ordering::Relaxed)) / 1000
    }

    fn gate(&self) -> MutexGuard<'_, Gate> {
        self.gate.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn log(message: &str) {
    eprintln!("[activator] {message}");
}

fn env_required(name: &str) -> String {
    match env::var(name) {
        Ok(value) if !value.is_empty() => value,
        _ => {
            log(&format!("missing required env {name}"));
            process::exit(2);
        }
    }
}

fn env_parse<T: std::str::FromStr>(name: &str, default: T) -> T {
    env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

fn env_secs(name: &str, default: u64) -> Duration {
    Duration::from_secs(env_parse(name, default))
}

/// Parses "http://host:port/path" (plain HTTP only).
fn parse_url(url: &str) -> Option<(String, u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().ok()?),
        None => (authority, 80),
    };
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port, path.to_string()))
}

fn control_port() -> u16 {
    env_parse("ACTIVATOR_CONTROL_PORT", 7999)
}

fn load_config() -> Config {
    let mode = match env::var("ACTIVATOR_MODE").unwrap_or_default().as_str() {
        "" | "standby" => Mode::Standby,
        "resident" => Mode::Resident,
        other => {
            log(&format!("unknown ACTIVATOR_MODE {other}"));
            process::exit(2);
        }
    };
    let ports: Vec<u16> = env_required("ACTIVATOR_PORTS")
        .split(',')
        .filter_map(|p| p.trim().parse().ok())
        .collect();
    if ports.is_empty() {
        log("ACTIVATOR_PORTS has no valid ports");
        process::exit(2);
    }
    let url = env_required("ACTIVATOR_WAKE_URL");
    let Some((wake_host, wake_port, wake_path)) = parse_url(&url) else {
        log("ACTIVATOR_WAKE_URL must look like http://host:port/path");
        process::exit(2);
    };
    Config {
        mode,
        ports,
        wake_host,
        wake_port,
        wake_path,
        token: env_required("ACTIVATOR_TOKEN"),
        wake_timeout: env_secs("ACTIVATOR_WAKE_TIMEOUT_SECS", 120),
        idle_exit: env_secs("ACTIVATOR_IDLE_EXIT_SECS", 10),
        max_linger: env_secs("ACTIVATOR_MAX_LINGER_SECS", 30),
        max_pending: env_parse("ACTIVATOR_MAX_PENDING", 1024),
        control_port: control_port(),
        max_pause: env_secs("ACTIVATOR_MAX_PAUSE_SECS", 60),
    }
}

/// A line of the wake response: an IP address or a DNS name.
fn is_valid_host(line: &str) -> bool {
    if line.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    !line.is_empty()
        && line.len() <= 253
        && line
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
        && line.chars().any(|c| c.is_ascii_alphabetic())
}

/// Parses Frost's wake response: status 200, a plain body with one host per
/// line. Chunked bodies are rejected (chunk sizes look like host names).
fn parse_wake_response(response: &[u8]) -> io::Result<Vec<String>> {
    let text = String::from_utf8_lossy(response);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed wake response"))?;
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or("");
    if status_line.split_whitespace().nth(1) != Some("200") {
        return Err(io::Error::other(format!("wake failed: {status_line}")));
    }
    let chunked = lines.any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value.to_ascii_lowercase().contains("chunked")
        })
    });
    if chunked {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "chunked wake response",
        ));
    }
    let hosts: Vec<String> = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect();
    if hosts.is_empty() || !hosts.iter().all(|h| is_valid_host(h)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "wake returned no valid hosts",
        ));
    }
    Ok(hosts)
}

/// POSTs to Frost and returns the hosts to forward to.
fn request_wake(config: &Config) -> io::Result<Vec<String>> {
    let addr = (config.wake_host.as_str(), config.wake_port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "wake host did not resolve"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(10))?;
    stream.set_read_timeout(Some(config.wake_timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let request = format!(
        "POST {} HTTP/1.0\r\nHost: {}:{}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        config.wake_path, config.wake_host, config.wake_port, config.token
    );
    stream.write_all(request.as_bytes())?;
    let mut response = Vec::new();
    stream.take(64 * 1024).read_to_end(&mut response)?;
    parse_wake_response(&response)
}

fn start_wake(shared: &Arc<Shared>, config: &Config) {
    let shared = Arc::clone(shared);
    let config = config.clone();
    thread::spawn(move || {
        log("waking");
        let started = Instant::now();
        let result = request_wake(&config);
        let mut phase = shared.phase();
        match result {
            Ok(hosts) => {
                log(&format!(
                    "awake in {}ms: {}",
                    started.elapsed().as_millis(),
                    hosts.join(", ")
                ));
                if let Phase::Paused { since, .. } = &*phase {
                    // Frost started a sleep after answering us. Keep holding;
                    // a resume uses these hosts, a sleep wakes again.
                    *phase = Phase::Paused {
                        since: *since,
                        hosts: Some(hosts),
                    };
                } else {
                    *shared.awake_at.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(Instant::now());
                    *phase = Phase::Awake(hosts);
                }
            }
            Err(error) => {
                log(&format!("wake failed: {error}"));
                if !matches!(&*phase, Phase::Paused { .. }) {
                    *phase = Phase::Failed(Instant::now());
                }
            }
        }
        shared.changed.notify_all();
    });
}

/// Waits until the workload is available (triggering a wake if needed) and
/// returns its hosts, or None if the wake failed or timed out.
fn wait_for_awake(shared: &Arc<Shared>, config: &Config) -> Option<Vec<String>> {
    let deadline = Instant::now() + config.wake_timeout;
    let mut phase = shared.phase();
    let mut waited = false;
    loop {
        let mut wait_until = deadline;
        match &*phase {
            Phase::Awake(hosts) => return Some(hosts.clone()),
            Phase::Asleep => {
                *phase = Phase::Waking;
                start_wake(shared, config);
                continue;
            }
            Phase::Failed(at) => {
                // A failure that happened while we waited is final for this
                // connection. A later connection retries, but not in a tight
                // loop.
                if waited || at.elapsed() < FAILED_WAKE_BACKOFF {
                    return None;
                }
                *phase = Phase::Waking;
                start_wake(shared, config);
                continue;
            }
            Phase::Paused { since, .. } => {
                let expires = *since + config.max_pause;
                if Instant::now() >= expires {
                    log("pause expired; treating workload as asleep");
                    *phase = Phase::Asleep;
                    shared.gate().clear();
                    shared.gate_changed.notify_all();
                    shared.changed.notify_all();
                    continue;
                }
                wait_until = wait_until.min(expires);
            }
            Phase::Waking => {}
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let (next, _) = shared
            .changed
            .wait_timeout(phase, wait_until.saturating_duration_since(now))
            .unwrap_or_else(|e| e.into_inner());
        phase = next;
        waited = true;
    }
}

/// Like wait_for_awake, counted as a held connection.
fn await_hosts(shared: &Arc<Shared>, config: &Config) -> Option<Vec<String>> {
    let pending = shared.pending.fetch_add(1, Ordering::SeqCst) + 1;
    let hosts = if pending > config.max_pending {
        log("too many held connections; refusing");
        None
    } else {
        wait_for_awake(shared, config)
    };
    shared.pending.fetch_sub(1, Ordering::SeqCst);
    hosts
}

/// The forwarding target stopped answering: forget it so the next
/// wait_for_awake asks Frost again. Only if nobody replaced it already.
fn forget_hosts(shared: &Shared, stale: &[String]) {
    let mut phase = shared.phase();
    if matches!(&*phase, Phase::Awake(hosts) if hosts == stale) {
        log("workload not answering; will ask Frost again");
        *phase = Phase::Asleep;
        shared.changed.notify_all();
    }
}

fn connect_upstream(
    shared: &Shared,
    hosts: &[String],
    port: u16,
    attempts: u32,
    timeout: Duration,
) -> io::Result<TcpStream> {
    let mut last_error = io::Error::new(io::ErrorKind::NotFound, "no upstream hosts");
    for attempt in 0..attempts {
        let index = shared.round_robin.fetch_add(1, Ordering::Relaxed) % hosts.len();
        let target = format!("{}:{}", hosts[index], port);
        match target.to_socket_addrs() {
            Ok(mut addrs) => {
                let addr: Option<SocketAddr> = addrs.next();
                if let Some(addr) = addr {
                    match TcpStream::connect_timeout(&addr, timeout) {
                        Ok(stream) => return Ok(stream),
                        Err(error) => last_error = error,
                    }
                }
            }
            Err(error) => last_error = error,
        }
        if attempt + 1 < attempts {
            thread::sleep(CONNECT_RETRY_DELAY);
        }
    }
    Err(last_error)
}

/// Resolves and connects to the workload. In resident mode the known address
/// gets a short try, then Frost is asked again (it may have slept or moved).
fn open_upstream(
    shared: &Arc<Shared>,
    config: &Config,
    port: u16,
) -> Option<TcpStream> {
    let hosts = await_hosts(shared, config)?;
    if config.mode == Mode::Standby {
        return match connect_upstream(shared, &hosts, port, CONNECT_RETRIES, CONNECT_TIMEOUT) {
            Ok(stream) => Some(stream),
            Err(error) => {
                log(&format!("connect failed: {error}"));
                None
            }
        };
    }
    match connect_upstream(
        shared,
        &hosts,
        port,
        QUICK_CONNECT_RETRIES,
        QUICK_CONNECT_TIMEOUT,
    ) {
        Ok(stream) => return Some(stream),
        Err(_) => forget_hosts(shared, &hosts),
    }
    let hosts = await_hosts(shared, config)?;
    match connect_upstream(shared, &hosts, port, CONNECT_RETRIES, CONNECT_TIMEOUT) {
        Ok(stream) => Some(stream),
        Err(error) => {
            log(&format!("connect failed after wake: {error}"));
            forget_hosts(shared, &hosts);
            None
        }
    }
}

/// Workload to client.
fn pipe(mut from: TcpStream, mut to: TcpStream, shared: &Shared) {
    let mut buf = [0u8; 8192];
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        shared.touch();
        if to.write_all(&buf[..n]).is_err() {
            break;
        }
    }
    let _ = to.shutdown(Shutdown::Write);
    let _ = from.shutdown(Shutdown::Read);
}

/// Called for every chunk a client sends before it is forwarded. Returns
/// false if the chunk must be dropped (the workload is going to sleep).
fn pass_gate(shared: &Shared) -> bool {
    let mut gate = shared.gate();
    loop {
        if gate.committed {
            return false;
        }
        let Some(since) = gate.paused_since else {
            return true;
        };
        gate.touched = true;
        let expires = since + shared.max_pause;
        let now = Instant::now();
        if now >= expires {
            gate.clear();
            shared.gate_changed.notify_all();
            return true;
        }
        gate = shared
            .gate_changed
            .wait_timeout(gate, expires - now)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

/// Client to workload, through the gate.
fn pipe_gated(mut from: TcpStream, mut to: TcpStream, shared: &Shared) {
    let mut buf = [0u8; 8192];
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        shared.touch();
        if !pass_gate(shared) || to.write_all(&buf[..n]).is_err() {
            break;
        }
    }
    let _ = to.shutdown(Shutdown::Write);
    let _ = from.shutdown(Shutdown::Read);
}

/// Records a forwarded connection so `commit` can close it. Returns None
/// while paused or committed; the caller then waits for the next wake.
fn register(shared: &Shared, client: &TcpStream, upstream: &TcpStream) -> Option<u64> {
    let (Ok(client), Ok(upstream)) = (client.try_clone(), upstream.try_clone()) else {
        return None;
    };
    let mut gate = shared.gate();
    // No new forwarding while paused: the connection's first bytes may still
    // be unread, where the gate can't see them. Nothing was forwarded yet, so
    // it simply waits for resume or the next wake.
    if gate.committed || gate.paused_since.is_some() {
        return None;
    }
    gate.next_id += 1;
    let id = gate.next_id;
    gate.conns.insert(id, (client, upstream));
    Some(id)
}

fn unregister(shared: &Shared, id: u64) {
    shared.gate().conns.remove(&id);
}

struct ActiveGuard<'a>(&'a Shared);

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        self.0.touch();
        self.0.active.fetch_sub(1, Ordering::SeqCst);
        *self
            .0
            .last_activity
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }
}

fn handle(client: TcpStream, port: u16, shared: Arc<Shared>, config: Config) {
    shared.active.fetch_add(1, Ordering::SeqCst);
    shared.touch();
    let _guard = ActiveGuard(&shared);

    let (upstream, id) = loop {
        let Some(upstream) = open_upstream(&shared, &config, port) else {
            let _ = client.shutdown(Shutdown::Both);
            return;
        };
        // Nothing has been forwarded yet, so a connection that lost the race
        // with a committed sleep just waits for the next wake.
        if let Some(id) = register(&shared, &client, &upstream) {
            break (upstream, id);
        }
        let _ = upstream.shutdown(Shutdown::Both);
    };
    let _ = client.set_nodelay(true);
    let _ = upstream.set_nodelay(true);
    if let (Ok(client_reader), Ok(upstream_reader)) = (client.try_clone(), upstream.try_clone()) {
        let gate_shared = Arc::clone(&shared);
        let forward = thread::Builder::new()
            .stack_size(THREAD_STACK_BYTES)
            .spawn(move || pipe_gated(client_reader, upstream, &gate_shared));
        pipe(upstream_reader, client, &shared);
        if let Ok(handle) = forward {
            let _ = handle.join();
        }
    }
    unregister(&shared, id);
}

fn listen(port: u16, shared: Arc<Shared>, config: Config) {
    let listener = match TcpListener::bind(("0.0.0.0", port)) {
        Ok(listener) => listener,
        Err(error) => {
            log(&format!("cannot listen on {port}: {error}"));
            process::exit(1);
        }
    };
    log(&format!("listening on {port} ({:?})", config.mode));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let shared = Arc::clone(&shared);
        let config = config.clone();
        let spawned = thread::Builder::new()
            .stack_size(THREAD_STACK_BYTES)
            .spawn(move || handle(stream, port, shared, config));
        if spawned.is_err() {
            log("could not spawn connection thread");
        }
    }
}

/// Applies a control command and returns the reply line.
fn apply_control(shared: &Shared, command: &str) -> String {
    let mut phase = shared.phase();
    let mut gate = shared.gate();
    let reply = match command {
        "pause" => {
            // Frost pauses again at the start of every stop, including the
            // one right after a commit; that must not reopen the gate for
            // connections that lost the race with the commit.
            let keep_commit = gate.committed && matches!(&*phase, Phase::Paused { .. });
            let hosts = match std::mem::replace(&mut *phase, Phase::Asleep) {
                Phase::Awake(hosts) => Some(hosts),
                Phase::Paused { hosts, .. } => hosts,
                _ => None,
            };
            *phase = Phase::Paused {
                since: Instant::now(),
                hosts,
            };
            gate.clear();
            gate.paused_since = Some(Instant::now());
            gate.committed = keep_commit;
            "ok".to_string()
        }
        "commit" => {
            if !matches!(&*phase, Phase::Paused { .. }) || gate.paused_since.is_none() {
                "error not paused".to_string()
            } else if gate.touched {
                "busy".to_string()
            } else {
                gate.committed = true;
                let closed = gate.conns.len();
                for (client, upstream) in gate.conns.values() {
                    let _ = client.shutdown(Shutdown::Both);
                    let _ = upstream.shutdown(Shutdown::Both);
                }
                format!("ok closed={closed}")
            }
        }
        "sleep" => {
            *phase = Phase::Asleep;
            gate.clear();
            "ok".to_string()
        }
        "resume" => {
            // Only a pause is called off; any other phase is left alone.
            if let Phase::Paused { hosts, .. } = &*phase {
                *phase = match hosts.clone() {
                    Some(hosts) => Phase::Awake(hosts),
                    None => Phase::Asleep,
                };
            }
            gate.clear();
            "ok".to_string()
        }
        "status" => "ok".to_string(),
        _ => return format!("error unknown command {command:?}"),
    };
    shared.changed.notify_all();
    shared.gate_changed.notify_all();
    let pending = shared.pending.load(Ordering::SeqCst);
    format!(
        "{reply} phase={} forwarding={} held={} touched={} idle_secs={}",
        phase.name(),
        gate.conns.len(),
        pending,
        gate.touched,
        shared.idle_secs()
    )
}

fn handle_control(stream: TcpStream, shared: &Shared) {
    let _ = stream.set_read_timeout(Some(CONTROL_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONTROL_IO_TIMEOUT));
    let Ok(reader_stream) = stream.try_clone() else {
        return;
    };
    let mut line = String::new();
    if BufReader::new(reader_stream.take(256))
        .read_line(&mut line)
        .is_err()
    {
        return;
    }
    let command = line.trim();
    let reply = apply_control(shared, command);
    if command != "status" {
        log(&format!("control: {command} -> {reply}"));
    }
    let mut stream = stream;
    let _ = stream.write_all(format!("{reply}\n").as_bytes());
}

fn serve_control(shared: Arc<Shared>, port: u16) -> ! {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(error) => {
            log(&format!("cannot listen on control port {port}: {error}"));
            process::exit(1);
        }
    };
    for stream in listener.incoming().flatten() {
        handle_control(stream, &shared);
    }
    process::exit(1);
}

/// `frost-activator ctl <command>`: talks to the resident process.
/// Status code of a plain HTTP GET (used by `probe`).
fn http_get_status(url: &str, timeout: Duration) -> io::Result<u16> {
    let (host, port, path) = parse_url(url)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad url"))?;
    let addr = (host.as_str(), port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "host did not resolve"))?;
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(
        format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n").as_bytes(),
    )?;
    let mut head = String::new();
    BufReader::new(stream.take(1024)).read_line(&mut head)?;
    head.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed response"))
}

/// `frost-activator probe <url>`: exits 0 if the URL answers 200. Frost runs
/// it in a container at startup to check the wake endpoint is reachable from
/// container networks (a host firewall can block it).
fn run_probe(url: &str) -> ! {
    match http_get_status(url, Duration::from_secs(5)) {
        Ok(200) => {
            println!("ok");
            process::exit(0);
        }
        Ok(code) => {
            eprintln!("probe got HTTP {code}");
            process::exit(1);
        }
        Err(error) => {
            eprintln!("probe failed: {error}");
            process::exit(1);
        }
    }
}

fn run_ctl(command: &str) -> ! {
    let result = (|| -> io::Result<String> {
        let addr = SocketAddr::from(([127, 0, 0, 1], control_port()));
        let mut stream = TcpStream::connect_timeout(&addr, CONTROL_IO_TIMEOUT)?;
        stream.set_read_timeout(Some(CONTROL_IO_TIMEOUT))?;
        stream.write_all(format!("{command}\n").as_bytes())?;
        let mut reply = String::new();
        stream.take(1024).read_to_string(&mut reply)?;
        Ok(reply)
    })();
    match result {
        Ok(reply) => {
            print!("{reply}");
            process::exit(if reply.starts_with("ok") { 0 } else { 1 });
        }
        Err(error) => {
            eprintln!("ctl failed: {error}");
            process::exit(1);
        }
    }
}

/// Standby mode: get out of the way once the service is awake.
fn standby_exit_loop(shared: &Shared, config: &Config) -> ! {
    loop {
        thread::sleep(EXIT_POLL);
        let Some(awake_at) = *shared.awake_at.lock().unwrap_or_else(|e| e.into_inner()) else {
            continue;
        };
        let since_wake = awake_at.elapsed();
        let active = shared.active.load(Ordering::SeqCst);
        if active == 0 {
            let idle_for = shared
                .last_activity
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .elapsed();
            if idle_for >= config.idle_exit || since_wake >= config.max_linger {
                log("service awake; handing over and exiting");
                process::exit(0);
            }
        } else if since_wake >= config.max_linger + DRAIN_HARD_CAP {
            log(&format!("exiting with {active} connection(s) still open"));
            process::exit(0);
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("probe") {
        let Some(url) = args.get(2) else {
            eprintln!("usage: frost-activator probe http://host:port/path");
            process::exit(2);
        };
        run_probe(url);
    }
    if args.get(1).map(String::as_str) == Some("ctl") {
        let Some(command) = args.get(2) else {
            eprintln!("usage: frost-activator ctl pause|commit|sleep|resume|status");
            process::exit(2);
        };
        run_ctl(command);
    }

    let config = load_config();
    let shared = Arc::new(Shared::new(config.max_pause));

    for &port in &config.ports {
        let shared = Arc::clone(&shared);
        let config = config.clone();
        thread::spawn(move || listen(port, shared, config));
    }

    match config.mode {
        Mode::Standby => standby_exit_loop(&shared, &config),
        Mode::Resident => serve_control(shared, config.control_port),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wake_urls() {
        assert_eq!(
            parse_url("http://host.docker.internal:3091/activate/svc_1"),
            Some((
                "host.docker.internal".into(),
                3091,
                "/activate/svc_1".into()
            ))
        );
        assert_eq!(
            parse_url("http://frost/x"),
            Some(("frost".into(), 80, "/x".into()))
        );
        assert_eq!(
            parse_url("http://frost"),
            Some(("frost".into(), 80, "/".into()))
        );
        assert_eq!(parse_url("https://frost/x"), None);
        assert_eq!(parse_url("http://:80/x"), None);
    }

    #[test]
    fn parses_wake_responses() {
        let ok = b"HTTP/1.1 200 OK\r\ncontent-length: 23\r\n\r\n172.18.0.4\nfrost-db-a\n";
        assert_eq!(
            parse_wake_response(ok).unwrap(),
            vec!["172.18.0.4".to_string(), "frost-db-a".to_string()]
        );
        assert!(parse_wake_response(b"HTTP/1.1 503 Service Unavailable\r\n\r\n").is_err());
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n172.18.0.4\n\r\n0\r\n\r\n";
        assert!(parse_wake_response(chunked).is_err());
        assert!(parse_wake_response(b"HTTP/1.1 200 OK\r\n\r\n").is_err());
        assert!(parse_wake_response(b"HTTP/1.1 200 OK\r\n\r\nbad host!\n").is_err());
        assert!(parse_wake_response(b"HTTP/1.1 200 OK\r\n\r\n12\n").is_err());
    }

    fn awake(shared: &Shared) -> bool {
        matches!(&*shared.phase(), Phase::Awake(_))
    }

    #[test]
    fn control_pause_resume_keeps_hosts() {
        let shared = Shared::new(Duration::from_secs(60));
        *shared.phase() = Phase::Awake(vec!["db".into()]);
        assert!(apply_control(&shared, "pause").starts_with("ok phase=paused"));
        assert!(apply_control(&shared, "status").contains("touched=false"));
        assert!(apply_control(&shared, "resume").starts_with("ok phase=awake"));
        assert!(awake(&shared));
    }

    #[test]
    fn control_pause_sleep() {
        let shared = Shared::new(Duration::from_secs(60));
        *shared.phase() = Phase::Awake(vec!["db".into()]);
        apply_control(&shared, "pause");
        assert!(apply_control(&shared, "sleep").starts_with("ok phase=asleep"));
        // Resume after sleep does nothing: it is no longer paused.
        assert!(apply_control(&shared, "resume").contains("phase=asleep"));
    }

    #[test]
    fn control_resume_without_hosts_falls_back_to_asleep() {
        let shared = Shared::new(Duration::from_secs(60));
        apply_control(&shared, "pause");
        assert!(apply_control(&shared, "resume").contains("phase=asleep"));
        assert!(apply_control(&shared, "bogus").starts_with("error"));
    }

    #[test]
    fn forget_only_replaces_matching_hosts() {
        let shared = Shared::new(Duration::from_secs(60));
        *shared.phase() = Phase::Awake(vec!["new".into()]);
        forget_hosts(&shared, &["old".to_string()]);
        assert!(awake(&shared));
        forget_hosts(&shared, &["new".to_string()]);
        assert!(matches!(&*shared.phase(), Phase::Asleep));
    }

    #[test]
    fn idle_secs_tracks_traffic() {
        let shared = Shared::new(Duration::from_secs(60));
        shared.last_traffic_ms.store(0, Ordering::Relaxed);
        thread::sleep(Duration::from_millis(1100));
        let reply = apply_control(&shared, "status");
        let idle: u64 = reply.rsplit("idle_secs=").next().unwrap().parse().unwrap();
        assert!(idle >= 1, "{reply}");
        shared.touch();
        assert_eq!(shared.idle_secs(), 0);
    }

    #[test]
    fn http_get_status_reads_the_status_line() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            for code in ["200 OK", "403 Forbidden"] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 256];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(format!("HTTP/1.1 {code}\r\n\r\n").as_bytes());
            }
        });
        let url = format!("http://127.0.0.1:{port}/healthz");
        assert_eq!(http_get_status(&url, Duration::from_secs(2)).unwrap(), 200);
        assert_eq!(http_get_status(&url, Duration::from_secs(2)).unwrap(), 403);
        server.join().unwrap();
        assert!(http_get_status("http://127.0.0.1:1/x", Duration::from_secs(1)).is_err());
    }

    #[test]
    fn valid_hosts() {
        assert!(is_valid_host("172.18.0.4"));
        assert!(is_valid_host("fd00::1"));
        assert!(is_valid_host("frost-db-abc_def.frost.internal"));
        assert!(!is_valid_host("0"));
        assert!(!is_valid_host("a b"));
        assert!(!is_valid_host(""));
    }

    fn paused_shared(max_pause: Duration) -> Arc<Shared> {
        let shared = Arc::new(Shared::new(max_pause));
        *shared.phase() = Phase::Awake(vec!["db".into()]);
        apply_control(&shared, "pause");
        shared
    }

    #[test]
    fn client_bytes_during_pause_block_commit_and_flow_on_resume() {
        let shared = paused_shared(Duration::from_secs(60));
        let worker = Arc::clone(&shared);
        let passed = thread::spawn(move || pass_gate(&worker));
        for _ in 0..200 {
            if shared.gate().touched {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(apply_control(&shared, "commit").starts_with("busy"));
        assert!(!passed.is_finished(), "bytes must be held while paused");
        apply_control(&shared, "resume");
        assert!(passed.join().unwrap());
    }

    #[test]
    fn bytes_after_commit_are_dropped_until_sleep() {
        let shared = paused_shared(Duration::from_secs(60));
        assert!(apply_control(&shared, "commit").starts_with("ok closed=0"));
        assert!(!pass_gate(&shared));
        apply_control(&shared, "sleep");
        assert!(pass_gate(&shared));
        assert!(apply_control(&shared, "commit").starts_with("error"));
    }

    #[test]
    fn pause_after_commit_keeps_the_commit() {
        let shared = paused_shared(Duration::from_secs(60));
        assert!(apply_control(&shared, "commit").starts_with("ok closed=0"));
        // stopDatabaseTargetUnlocked pauses again before stopping.
        assert!(apply_control(&shared, "pause").starts_with("ok phase=paused"));
        assert!(!pass_gate(&shared));
        apply_control(&shared, "sleep");
        assert!(pass_gate(&shared));
    }

    #[test]
    fn pause_expires_for_held_bytes() {
        let shared = paused_shared(Duration::from_millis(50));
        let started = Instant::now();
        assert!(pass_gate(&shared));
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert!(shared.gate().paused_since.is_none());
    }

    #[test]
    fn commit_closes_forwarded_connections_and_blocks_new_ones() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (mut far_end, _) = listener.accept().unwrap();
        let upstream = TcpStream::connect(addr).unwrap();
        let _upstream_far = listener.accept().unwrap();

        let shared = paused_shared(Duration::from_secs(60));
        // Registration waits out a pause...
        assert!(register(&shared, &client, &upstream).is_none());
        apply_control(&shared, "resume");
        let id = register(&shared, &client, &upstream).unwrap();
        apply_control(&shared, "pause");
        assert!(apply_control(&shared, "commit").starts_with("ok closed=1"));
        let mut buf = [0u8; 1];
        assert_eq!(far_end.read(&mut buf).unwrap(), 0, "client must see EOF");
        assert!(register(&shared, &client, &upstream).is_none());
        unregister(&shared, id);
        apply_control(&shared, "sleep");
        assert!(register(&shared, &client, &upstream).is_some());
    }
}
