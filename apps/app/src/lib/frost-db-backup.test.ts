import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadSnapshotOffsite } from "./frost-db-backup";
import { formatSnapshotName } from "./frost-db-snapshot";

const DAY = 24 * 60 * 60 * 1000;
const BUCKET = "test-bucket";

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

const objects = new Map<string, number>();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname).replace(`/${BUCKET}`, "");
    if (req.method === "PUT") {
      await req.arrayBuffer();
      objects.set(path.replace(/^\//, ""), Date.now());
      return new Response("", { headers: { ETag: '"etag"' } });
    }
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map(
          (key) =>
            `<Contents><Key>${escapeXml(key)}</Key><Size>1</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`,
        )
        .join("");
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>${escapeXml(prefix)}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        { headers: { "Content-Type": "application/xml" } },
      );
    }
    if (req.method === "POST" && url.searchParams.has("delete")) {
      const body = await req.text();
      for (const match of body.matchAll(/<Key>([^<]+)<\/Key>/g)) {
        objects.delete(match[1]);
      }
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>',
        { headers: { "Content-Type": "application/xml" } },
      );
    }
    return new Response("unsupported", { status: 400 });
  },
});

const dir = mkdtempSync(join(tmpdir(), "frost-offsite-test-"));

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("uploadSnapshotOffsite", () => {
  test("uploads under frost-system/ and expires old snapshots only", async () => {
    const now = Date.UTC(2026, 10, 14, 12);
    const keyPrefix = "frost-backups/frost-system";
    const oldKey = `${keyPrefix}/${formatSnapshotName("daily", new Date(now - 20 * DAY))}`;
    const recentKey = `${keyPrefix}/${formatSnapshotName("daily", new Date(now - 3 * DAY))}`;
    const pgKey = "frost-backups/db_123/2026/dump.pgdump";
    objects.set(oldKey, now);
    objects.set(recentKey, now);
    objects.set(pgKey, now);

    const snapshotName = formatSnapshotName("daily", new Date(now));
    const snapshotPath = join(dir, snapshotName);
    writeFileSync(snapshotPath, "sqlite bytes");

    const result = await uploadSnapshotOffsite(
      snapshotPath,
      {
        databaseId: "db_123",
        bucket: BUCKET,
        keyPrefix,
        s3: {
          provider: "custom",
          endpoint: `http://127.0.0.1:${server.port}`,
          region: "us-east-1",
          bucket: BUCKET,
          prefix: "frost-backups",
          accessKeyId: "test",
          secretAccessKey: "test",
          forcePathStyle: true,
        },
      },
      now,
    );

    expect(result).toEqual({ key: `${keyPrefix}/${snapshotName}`, deleted: 1 });
    expect([...objects.keys()].sort()).toEqual(
      [pgKey, recentKey, `${keyPrefix}/${snapshotName}`].sort(),
    );
  });
});
