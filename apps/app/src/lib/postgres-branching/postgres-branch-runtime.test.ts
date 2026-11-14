import { describe, expect, test } from "bun:test";
import {
  buildPostgresCheckpointArgs,
  createRollbackStack,
} from "./postgres-branch-runtime";

describe("createRollbackStack", () => {
  test("runs rollback steps in reverse order", async () => {
    const calls: string[] = [];
    const rollback = createRollbackStack();

    rollback.add(async () => {
      calls.push("storage");
    });
    rollback.add(async () => {
      calls.push("container");
    });

    await rollback.run();

    expect(calls).toEqual(["container", "storage"]);
  });
});

describe("buildPostgresCheckpointArgs", () => {
  test("builds docker exec psql checkpoint args without password", () => {
    const args = buildPostgresCheckpointArgs({
      containerName: "pg-main",
      username: "frost",
      password: "secret",
      database: "frost",
    });

    expect(args[0]).toBe("exec");
    expect(args).toContain("CHECKPOINT;");
    expect(args).toContain("pg-main");
    expect(args).toContain("PGPASSWORD");
    expect(args.join(" ")).not.toContain("secret");
  });
});
