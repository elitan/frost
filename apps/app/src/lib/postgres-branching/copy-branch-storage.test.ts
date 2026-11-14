import { describe, expect, test } from "bun:test";
import {
  buildCopyCloneHelperArgs,
  buildCopyRemoveHelperArgs,
} from "./copy-branch-storage";

describe("buildCopyCloneHelperArgs", () => {
  test("builds docker helper clone args", () => {
    expect(
      buildCopyCloneHelperArgs({
        sourcePath: "/a/source",
        targetPath: "/b/target",
        helperImage: "postgres:17",
      }),
    ).toEqual([
      "run",
      "--rm",
      "--user",
      "0:0",
      "-v",
      "/a/source:/from:ro",
      "-v",
      "/b/target:/to",
      "postgres:17",
      "cp",
      "-a",
      "/from/.",
      "/to",
    ]);
  });
});

describe("buildCopyRemoveHelperArgs", () => {
  test("builds docker helper remove args", () => {
    expect(
      buildCopyRemoveHelperArgs({
        path: "/b/target",
        helperImage: "postgres:17",
      }),
    ).toEqual([
      "run",
      "--rm",
      "--user",
      "0:0",
      "-v",
      "/b:/parent",
      "postgres:17",
      "rm",
      "-rf",
      "/parent/target",
    ]);
  });
});
