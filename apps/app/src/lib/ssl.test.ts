import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_SSL_PATH = join(tmpdir(), "frost-ssl-test");
process.env.FROST_SSL_PATH = TEST_SSL_PATH;

import {
  generateSelfSignedCert,
  getSSLDir,
  getSSLPaths,
  removeSSLCerts,
  sslCertsExist,
} from "./ssl";

const TEST_SERVICE_ID = "test-ssl-service-12345";

describe("ssl", () => {
  beforeAll(() => {
    if (existsSync(TEST_SSL_PATH)) {
      rmSync(TEST_SSL_PATH, { recursive: true, force: true });
    }
    mkdirSync(TEST_SSL_PATH, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_SSL_PATH)) {
      rmSync(TEST_SSL_PATH, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await removeSSLCerts(TEST_SERVICE_ID);
  });

  test("sslCertsExist returns false when certs do not exist", () => {
    const exists = sslCertsExist(TEST_SERVICE_ID);
    expect(exists).toBe(false);
  });

  test("sslCertsExist returns true when certs exist", () => {
    const dir = getSSLDir(TEST_SERVICE_ID);
    mkdirSync(dir, { recursive: true });
    const paths = getSSLPaths(TEST_SERVICE_ID);
    writeFileSync(paths.cert, "test cert");
    writeFileSync(paths.key, "test key");

    const exists = sslCertsExist(TEST_SERVICE_ID);
    expect(exists).toBe(true);
  });

  test("generateSelfSignedCert creates cert and key files", async () => {
    await generateSelfSignedCert(TEST_SERVICE_ID);

    const paths = getSSLPaths(TEST_SERVICE_ID);
    expect(existsSync(paths.cert)).toBe(true);
    expect(existsSync(paths.key)).toBe(true);
  });

  test("generateSelfSignedCert is idempotent", async () => {
    await generateSelfSignedCert(TEST_SERVICE_ID);
    const paths = getSSLPaths(TEST_SERVICE_ID);
    const firstMtime = statSync(paths.cert).mtimeMs;

    await new Promise((r) => setTimeout(r, 100));

    await generateSelfSignedCert(TEST_SERVICE_ID);
    const secondMtime = statSync(paths.cert).mtimeMs;

    expect(firstMtime).toBe(secondMtime);
  });

  test("removeSSLCerts deletes cert and key files", async () => {
    await generateSelfSignedCert(TEST_SERVICE_ID);
    expect(sslCertsExist(TEST_SERVICE_ID)).toBe(true);

    await removeSSLCerts(TEST_SERVICE_ID);
    expect(sslCertsExist(TEST_SERVICE_ID)).toBe(false);
    expect(existsSync(getSSLDir(TEST_SERVICE_ID))).toBe(false);
  });

  test("removeSSLCerts does not throw when certs do not exist", async () => {
    await removeSSLCerts(TEST_SERVICE_ID);
    expect(sslCertsExist(TEST_SERVICE_ID)).toBe(false);
  });
});
