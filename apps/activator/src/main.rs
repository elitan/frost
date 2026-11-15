//! frost-activator: a stand-in for a sleeping (scale-to-zero) service.
//!
//! While a service sleeps, Frost runs this on the service's Docker network
//! under the service's hostname, listening on the service's port(s). The
//! first connection triggers one wake request to Frost; every connection that
//! arrives meanwhile is held. Once Frost answers with the woken service's
//! addresses, held and new connections are forwarded as raw TCP, so any
//! protocol works (HTTP, gRPC, Postgres, ...).
//!
//! After the wake, Docker resolves the hostname to both this activator and
//! the real containers, so the activator must get out of the way: it exits
//! once idle, or once it has lingered for ACTIVATOR_MAX_LINGER_SECS (at the
//! first moment no connection is open, cutting any left after a further
//! drain period). Docker (--rm) then removes it, leaving the real service as
//! the only owner of the hostname.
//!
//! Configuration (environment):
//!   ACTIVATOR_PORTS              comma-separated ports to listen on (required)
//!   ACTIVATOR_WAKE_URL           http://host:port/path to POST to (required)
//!   ACTIVATOR_TOKEN              bearer token for the wake request (required)
//!   ACTIVATOR_WAKE_TIMEOUT_SECS  max time a connection waits for a wake (120)
//!   ACTIVATOR_IDLE_EXIT_SECS     exit after this long idle once awake (10)
//!   ACTIVATOR_MAX_LINGER_SECS    max time to keep proxying after a wake (30)
//!   ACTIVATOR_MAX_PENDING        max connections held while waking (1024)

use std::env;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::process;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const CONNECT_RETRIES: u32 = 20;
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(250);
const FAILED_WAKE_BACKOFF: Duration = Duration::from_secs(1);
const THREAD_STACK_BYTES: usize = 64 * 1024;
/// After the linger time, connections still open are cut after this long.
const DRAIN_HARD_CAP: Duration = Duration::from_secs(30);
const EXIT_POLL: Duration = Duration::from_millis(50);

#[derive(Clone)]
struct Config {
    ports: Vec<u16>,
    wake_host: String,
    wake_port: u16,
    wake_path: String,
    token: String,
    wake_timeout: Duration,
    idle_exit: Duration,
    max_linger: Duration,
    max_pending: usize,
}

enum Phase {
    Asleep,
    Waking,
    /// Hosts (IPs or names) of the woken service's containers.
    Awake(Vec<String>),
    Failed(Instant),
}

struct Shared {
    phase: Mutex<Phase>,
    changed: Condvar,
    active: AtomicUsize,
    pending: AtomicUsize,
    round_robin: AtomicUsize,
    last_activity: Mutex<Instant>,
    awake_at: Mutex<Option<Instant>>,
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

fn env_secs(name: &str, default: u64) -> Duration {
    Duration::from_secs(
        env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default),
    )
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

fn load_config() -> Config {
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
        ports,
        wake_host,
        wake_port,
        wake_path,
        token: env_required("ACTIVATOR_TOKEN"),
        wake_timeout: env_secs("ACTIVATOR_WAKE_TIMEOUT_SECS", 120),
        idle_exit: env_secs("ACTIVATOR_IDLE_EXIT_SECS", 10),
        max_linger: env_secs("ACTIVATOR_MAX_LINGER_SECS", 30),
        max_pending: env::var("ACTIVATOR_MAX_PENDING")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1024),
    }
}

/// POSTs to Frost and returns the woken service's container hosts, one per
/// line of the 200 response body.
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
    let text = String::from_utf8_lossy(&response);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed wake response"))?;
    let status_line = head.lines().next().unwrap_or("");
    if !status_line
        .split_whitespace()
        .nth(1)
        .is_some_and(|code| code == "200")
    {
        return Err(io::Error::other(format!("wake failed: {status_line}")));
    }
    // Frost answers with container IPs, one per line. Anything else (e.g.
    // chunked-encoding markers from a misbehaving server) is rejected.
    let hosts: Vec<String> = body
        .lines()
        .map(str::trim)
        .filter(|line| line.parse::<std::net::IpAddr>().is_ok())
        .map(String::from)
        .collect();
    if hosts.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "wake returned no hosts",
        ));
    }
    Ok(hosts)
}

fn start_wake(shared: &Arc<Shared>, config: &Config) {
    let shared = Arc::clone(shared);
    let config = config.clone();
    thread::spawn(move || {
        log("waking service");
        let started = Instant::now();
        let result = request_wake(&config);
        let mut phase = shared.phase.lock().unwrap_or_else(|e| e.into_inner());
        *phase = match result {
            Ok(hosts) => {
                log(&format!(
                    "service awake in {}ms: {}",
                    started.elapsed().as_millis(),
                    hosts.join(", ")
                ));
                *shared.awake_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                Phase::Awake(hosts)
            }
            Err(error) => {
                log(&format!("wake failed: {error}"));
                Phase::Failed(Instant::now())
            }
        };
        shared.changed.notify_all();
    });
}

/// Waits until the service is awake (triggering the wake if needed) and
/// returns its hosts, or None if the wake failed or timed out.
fn wait_for_awake(shared: &Arc<Shared>, config: &Config) -> Option<Vec<String>> {
    let deadline = Instant::now() + config.wake_timeout;
    let mut phase = shared.phase.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        match &*phase {
            Phase::Awake(hosts) => return Some(hosts.clone()),
            Phase::Asleep => {
                *phase = Phase::Waking;
                start_wake(shared, config);
            }
            Phase::Failed(at) => {
                // A connection arriving after a failure retries the wake,
                // but not in a tight loop.
                if at.elapsed() >= FAILED_WAKE_BACKOFF {
                    *phase = Phase::Waking;
                    start_wake(shared, config);
                } else {
                    return None;
                }
            }
            Phase::Waking => {}
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let (next, timeout) = shared
            .changed
            .wait_timeout(phase, deadline - now)
            .unwrap_or_else(|e| e.into_inner());
        phase = next;
        if timeout.timed_out() {
            if let Phase::Awake(hosts) = &*phase {
                return Some(hosts.clone());
            }
            return None;
        }
        // A failure that happened while we waited is final for this
        // connection; later connections retry.
        if matches!(&*phase, Phase::Failed(_)) {
            return None;
        }
    }
}

fn connect_upstream(shared: &Shared, hosts: &[String], port: u16) -> io::Result<TcpStream> {
    let mut last_error = io::Error::new(io::ErrorKind::NotFound, "no upstream hosts");
    for attempt in 0..CONNECT_RETRIES {
        let index = shared.round_robin.fetch_add(1, Ordering::Relaxed) % hosts.len();
        let target = format!("{}:{}", hosts[index], port);
        let addr: Option<SocketAddr> = target.to_socket_addrs().ok().and_then(|mut a| a.next());
        if let Some(addr) = addr {
            match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
                Ok(stream) => return Ok(stream),
                Err(error) => last_error = error,
            }
        }
        if attempt + 1 < CONNECT_RETRIES {
            thread::sleep(CONNECT_RETRY_DELAY);
        }
    }
    Err(last_error)
}

fn pipe(mut from: TcpStream, mut to: TcpStream) {
    let _ = io::copy(&mut from, &mut to);
    let _ = to.shutdown(Shutdown::Write);
    let _ = from.shutdown(Shutdown::Read);
}

struct ActiveGuard<'a>(&'a Shared);

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
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
    let _guard = ActiveGuard(&shared);

    let pending = shared.pending.fetch_add(1, Ordering::SeqCst) + 1;
    let hosts = if pending > config.max_pending {
        None
    } else {
        wait_for_awake(&shared, &config)
    };
    shared.pending.fetch_sub(1, Ordering::SeqCst);

    let Some(hosts) = hosts else {
        let _ = client.shutdown(Shutdown::Both);
        return;
    };
    let upstream = match connect_upstream(&shared, &hosts, port) {
        Ok(stream) => stream,
        Err(error) => {
            log(&format!("connect to service failed: {error}"));
            let _ = client.shutdown(Shutdown::Both);
            return;
        }
    };
    let _ = client.set_nodelay(true);
    let _ = upstream.set_nodelay(true);
    let (Ok(client_reader), Ok(upstream_reader)) = (client.try_clone(), upstream.try_clone())
    else {
        return;
    };
    let forward = thread::Builder::new()
        .stack_size(THREAD_STACK_BYTES)
        .spawn(move || pipe(client_reader, upstream));
    pipe(upstream_reader, client);
    if let Ok(handle) = forward {
        let _ = handle.join();
    }
}

fn listen(port: u16, shared: Arc<Shared>, config: Config) {
    let listener = match TcpListener::bind(("0.0.0.0", port)) {
        Ok(listener) => listener,
        Err(error) => {
            log(&format!("cannot listen on {port}: {error}"));
            process::exit(1);
        }
    };
    log(&format!("listening on {port}"));
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

fn main() {
    let config = load_config();
    let shared = Arc::new(Shared {
        phase: Mutex::new(Phase::Asleep),
        changed: Condvar::new(),
        active: AtomicUsize::new(0),
        pending: AtomicUsize::new(0),
        round_robin: AtomicUsize::new(0),
        last_activity: Mutex::new(Instant::now()),
        awake_at: Mutex::new(None),
    });

    for &port in &config.ports {
        let shared = Arc::clone(&shared);
        let config = config.clone();
        thread::spawn(move || listen(port, shared, config));
    }

    // Get out of the way once the service is awake (see module docs).
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

#[cfg(test)]
mod tests {
    use super::parse_url;

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
}
