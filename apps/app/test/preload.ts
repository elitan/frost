import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests share one SQLite database per run. Point it at a fresh temp dir so
// `bun test` never reads or mutates a developer's local Frost data
// (apps/app/data), e.g. global reconcilers marking real deployments stopped.
if (!process.env.FROST_TEST_KEEP_DATA_DIR) {
  const dataDir = mkdtempSync(join(tmpdir(), "frost-test-"));
  process.env.FROST_DATA_DIR = dataDir;
  delete process.env.FROST_DB_PATH;
}
