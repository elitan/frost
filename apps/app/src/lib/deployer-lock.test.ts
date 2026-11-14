import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildServiceImageName,
  formatEnvFileContent,
  withServiceDeploymentLock,
  writeEnvFileSafely,
} from "./deployer";

function sleep(ms: number): Promise<void> {
  return new Promise(function onCreate(resolve) {
    setTimeout(resolve, ms);
  });
}

describe("withServiceDeploymentLock", function describeLock() {
  test("serializes tasks for same service", async function testSerialize() {
    const events: string[] = [];

    await Promise.all([
      withServiceDeploymentLock("service-a", async function firstTask() {
        events.push("first:start");
        await sleep(40);
        events.push("first:end");
      }),
      withServiceDeploymentLock("service-a", async function secondTask() {
        events.push("second:start");
        events.push("second:end");
      }),
    ]);

    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("allows parallel tasks for different services", async function testParallel() {
    let running = 0;
    let peak = 0;

    await Promise.all([
      withServiceDeploymentLock("service-a", async function taskA() {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(40);
        running -= 1;
      }),
      withServiceDeploymentLock("service-b", async function taskB() {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(40);
        running -= 1;
      }),
    ]);

    expect(peak).toBe(2);
  });

  test("releases lock after failure", async function testFailure() {
    await expect(
      withServiceDeploymentLock("service-a", async function failingTask() {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    let ran = false;
    await withServiceDeploymentLock("service-a", async function nextTask() {
      ran = true;
    });

    expect(ran).toBe(true);
  });
});

describe("formatEnvFileContent", function describeEnvFileFormatting() {
  test("escapes newline values to one line", function testEscapesNewline() {
    const content = formatEnvFileContent([
      { key: "SAFE", value: "line-1\nMALICIOUS=1" },
      { key: "OTHER", value: "ok" },
    ]);

    expect(content).toBe(
      `SAFE=${JSON.stringify("line-1\nMALICIOUS=1")}\nOTHER=${JSON.stringify("ok")}`,
    );
  });

  test("escapes quotes and backslashes", function testEscapesSpecialChars() {
    const value = 'x"y\\z';
    const content = formatEnvFileContent([{ key: "SAFE", value }]);

    expect(content).toBe(`SAFE=${JSON.stringify(value)}`);
  });

  test("throws on unsafe key", function testUnsafeKey() {
    expect(() =>
      formatEnvFileContent([{ key: "BAD\nKEY", value: "value" }]),
    ).toThrow("Invalid environment variable key");
  });
});

describe("buildServiceImageName", function describeImageName() {
  test("names images per service id", function testPerService() {
    expect(buildServiceImageName("svc_abc123", "1234567")).toBe(
      "frost-svc-abc123:1234567",
    );
    expect(buildServiceImageName("svc_one", "abc")).not.toBe(
      buildServiceImageName("svc_two", "abc"),
    );
  });
});

describe("writeEnvFileSafely", function describeWriteEnv() {
  test("does not follow a .env symlink out of the repo", function testSymlink() {
    const root = mkdtempSync(join(tmpdir(), "frost-env-"));
    try {
      const repo = join(root, "repo");
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "original");
      mkdirSync(repo);
      symlinkSync(outside, join(repo, ".env"));

      writeEnvFileSafely(repo, "A=1");

      expect(readFileSync(outside, "utf-8")).toBe("original");
      expect(readFileSync(join(repo, ".env"), "utf-8")).toBe("A=1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
