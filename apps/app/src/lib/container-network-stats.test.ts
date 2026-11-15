import { describe, expect, test } from "bun:test";
import {
  resolveDockerSocketPath,
  sumNetworkBytes,
} from "./container-network-stats";

describe("sumNetworkBytes", () => {
  test("adds rx and tx over every interface", () => {
    expect(
      sumNetworkBytes({
        networks: {
          eth0: { rx_bytes: 100, tx_bytes: 50 },
          eth1: { rx_bytes: 7, tx_bytes: 3 },
        },
      }),
    ).toBe(160);
  });

  test("treats missing or malformed stats as zero", () => {
    expect(sumNetworkBytes(null)).toBe(0);
    expect(sumNetworkBytes({})).toBe(0);
    expect(sumNetworkBytes({ networks: { eth0: { rx_bytes: "x" } } })).toBe(0);
  });
});

describe("resolveDockerSocketPath", () => {
  test("uses a unix DOCKER_HOST", () => {
    expect(
      resolveDockerSocketPath(
        { DOCKER_HOST: "unix:///tmp/docker.sock" },
        () => false,
      ),
    ).toBe("/tmp/docker.sock");
  });

  test("returns null for a non-unix DOCKER_HOST", () => {
    expect(
      resolveDockerSocketPath(
        { DOCKER_HOST: "tcp://10.0.0.1:2375" },
        () => true,
      ),
    ).toBeNull();
  });

  test("falls back to the first socket that exists", () => {
    expect(
      resolveDockerSocketPath({}, (path) => path === "/var/run/docker.sock"),
    ).toBe("/var/run/docker.sock");
    expect(
      resolveDockerSocketPath({}, (path) =>
        path.endsWith(".docker/run/docker.sock"),
      ),
    ).toMatch(/\.docker\/run\/docker\.sock$/);
    expect(resolveDockerSocketPath({}, () => false)).toBeNull();
  });
});
