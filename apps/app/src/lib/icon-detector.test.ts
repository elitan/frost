import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectIcon, detectIconFromImage } from "./icon-detector";

const TEST_DIR = join(process.cwd(), "test-icon-detector-tmp");

describe("detectIconFromImage", () => {
  test("detects postgres from image url", () => {
    expect(detectIconFromImage("postgres:17-alpine")).toBe("postgresql");
    expect(detectIconFromImage("postgres:latest")).toBe("postgresql");
  });

  test("detects redis from image url", () => {
    expect(detectIconFromImage("redis:7-alpine")).toBe("redis");
  });

  test("detects Garage from image url", () => {
    expect(detectIconFromImage("dxflrs/garage:v2.3.0")).toBe("garage");
  });

  test("returns null for unknown images", () => {
    expect(detectIconFromImage("someunknown/image:latest")).toBeNull();
  });

  test("case insensitive matching", () => {
    expect(detectIconFromImage("POSTGRES:17")).toBe("postgresql");
    expect(detectIconFromImage("Redis:7")).toBe("redis");
  });

  test("detects from full registry path", () => {
    expect(detectIconFromImage("ghcr.io/org/postgres-custom:v1")).toBe(
      "postgresql",
    );
    expect(detectIconFromImage("docker.io/library/redis:7")).toBe("redis");
  });
});

describe("detectIcon", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("from package.json", () => {
    test("detects Next.js", async () => {
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({ dependencies: { next: "14.0.0" } }),
      );
      expect(await detectIcon(TEST_DIR)).toBe("nextdotjs");
    });

    test("detects Remix from @remix-run/node", async () => {
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({ dependencies: { "@remix-run/node": "2.0.0" } }),
      );
      expect(await detectIcon(TEST_DIR)).toBe("remix");
    });

    test("detects React", async () => {
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({ dependencies: { react: "18.0.0" } }),
      );
      expect(await detectIcon(TEST_DIR)).toBe("react");
    });

    test("detects from devDependencies", async () => {
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({ devDependencies: { next: "14.0.0" } }),
      );
      expect(await detectIcon(TEST_DIR)).toBe("nextdotjs");
    });

    test("prioritizes framework over runtime", async () => {
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({
          dependencies: { next: "14.0.0", react: "18.0.0" },
        }),
      );
      expect(await detectIcon(TEST_DIR)).toBe("nextdotjs");
    });

    test("falls back to node for plain node projects", async () => {
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({ dependencies: { lodash: "4.0.0" } }),
      );
      expect(await detectIcon(TEST_DIR)).toBe("nodedotjs");
    });
  });

  describe("from Dockerfile", () => {
    test("detects python from base image", async () => {
      writeFileSync(join(TEST_DIR, "Dockerfile"), "FROM python:3.12-slim\n");
      expect(await detectIcon(TEST_DIR)).toBe("python");
    });

    test("detects go from base image", async () => {
      writeFileSync(join(TEST_DIR, "Dockerfile"), "FROM golang:1.22\n");
      expect(await detectIcon(TEST_DIR)).toBe("go");
    });

    test("detects rust from base image", async () => {
      writeFileSync(join(TEST_DIR, "Dockerfile"), "FROM rust:1.75\n");
      expect(await detectIcon(TEST_DIR)).toBe("rust");
    });

    test("detects ruby from base image", async () => {
      writeFileSync(join(TEST_DIR, "Dockerfile"), "FROM ruby:3.3\n");
      expect(await detectIcon(TEST_DIR)).toBe("ruby");
    });

    test("detects java from openjdk image", async () => {
      writeFileSync(join(TEST_DIR, "Dockerfile"), "FROM openjdk:21\n");
      expect(await detectIcon(TEST_DIR)).toBe("openjdk");
    });

    test("detects node from base image", async () => {
      writeFileSync(join(TEST_DIR, "Dockerfile"), "FROM node:20-alpine\n");
      expect(await detectIcon(TEST_DIR)).toBe("nodedotjs");
    });

    test("detects bun from base image", async () => {
      writeFileSync(join(TEST_DIR, "Dockerfile"), "FROM oven/bun:1.0\n");
      expect(await detectIcon(TEST_DIR)).toBe("bun");
    });

    test("handles multi-stage builds (uses first FROM)", async () => {
      writeFileSync(
        join(TEST_DIR, "Dockerfile"),
        "FROM node:20 AS builder\nRUN npm build\nFROM nginx:alpine\nCOPY --from=builder /app/dist /usr/share/nginx/html\n",
      );
      expect(await detectIcon(TEST_DIR)).toBe("nodedotjs");
    });
  });

  describe("priority", () => {
    test("package.json takes priority over Dockerfile", async () => {
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({ dependencies: { next: "14.0.0" } }),
      );
      writeFileSync(join(TEST_DIR, "Dockerfile"), "FROM python:3.12\n");
      expect(await detectIcon(TEST_DIR)).toBe("nextdotjs");
    });
  });

  test("returns null for empty repo", async () => {
    expect(await detectIcon(TEST_DIR)).toBeNull();
  });

  describe("with dockerfile path (monorepo)", () => {
    test("detects Next.js from subdirectory package.json", async () => {
      mkdirSync(join(TEST_DIR, "apps", "web"), { recursive: true });
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({ devDependencies: { typescript: "5.0.0" } }),
      );
      writeFileSync(
        join(TEST_DIR, "apps", "web", "package.json"),
        JSON.stringify({ dependencies: { next: "14.0.0" } }),
      );
      writeFileSync(
        join(TEST_DIR, "apps", "web", "Dockerfile"),
        "FROM node:20\n",
      );
      expect(await detectIcon(TEST_DIR, "apps/web/Dockerfile")).toBe(
        "nextdotjs",
      );
    });

    test("falls back to Dockerfile when no package.json in subdir", async () => {
      mkdirSync(join(TEST_DIR, "apps", "api"), { recursive: true });
      writeFileSync(
        join(TEST_DIR, "apps", "api", "Dockerfile"),
        "FROM python:3.12\n",
      );
      expect(await detectIcon(TEST_DIR, "apps/api/Dockerfile")).toBe("python");
    });
  });

  test("returns null for non-existent path", async () => {
    expect(await detectIcon("/non/existent/path")).toBeNull();
  });

  test("handles malformed package.json gracefully", async () => {
    writeFileSync(join(TEST_DIR, "package.json"), "not valid json");
    writeFileSync(join(TEST_DIR, "Dockerfile"), "FROM python:3.12\n");
    expect(await detectIcon(TEST_DIR)).toBe("python");
  });
});
