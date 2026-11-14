import { afterAll, describe, expect, test } from "bun:test";
import {
  createPostgresBackupS3Client,
  deleteS3Object,
  deleteS3Objects,
  downloadS3ObjectToFile,
  getTextFromS3,
  joinS3Key,
  listS3Objects,
  putTextToS3,
  testS3Connection,
} from "./postgres-backup-s3";
import { startGarageTestS3Server } from "./postgres-backup-test-s3-server";

const S3_CONTAINER = "frost-test-postgres-backup-s3";
const S3_PORT = 19995;
const S3_BUCKET = "frost-test-backups";

const s3Server = await startGarageTestS3Server({
  containerName: S3_CONTAINER,
  port: S3_PORT,
  bucket: S3_BUCKET,
});

describe.skipIf(s3Server === null)("postgres backup s3 integration", () => {
  const server = s3Server as NonNullable<typeof s3Server>;
  const client = createPostgresBackupS3Client({
    provider: "custom",
    endpoint: server.endpoint,
    region: server.region,
    bucket: S3_BUCKET,
    prefix: "frost-tests",
    accessKeyId: server.accessKeyId,
    secretAccessKey: server.secretAccessKey,
    forcePathStyle: true,
  });

  afterAll(async () => {
    await server.stop();
  });

  test("put/get/list/delete object", async () => {
    const key = joinS3Key("frost-tests", "sample", "value.txt");
    await putTextToS3({
      client,
      bucket: S3_BUCKET,
      key,
      text: "hello",
      contentType: "text/plain",
    });

    const loaded = await getTextFromS3({
      client,
      bucket: S3_BUCKET,
      key,
    });
    expect(loaded).toBe("hello");

    const objects = await listS3Objects({
      client,
      bucket: S3_BUCKET,
      prefix: "frost-tests/sample",
    });
    expect(
      objects.some(function hasKey(item) {
        return item.key === key;
      }),
    ).toBe(true);

    await deleteS3Object({
      client,
      bucket: S3_BUCKET,
      key,
    });
  });

  test("streams object to file and batch deletes", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const key = joinS3Key("frost-tests", "stream", "dump.bin");
    await putTextToS3({ client, bucket: S3_BUCKET, key, text: "streamed" });

    const dir = await mkdtemp(join(tmpdir(), "frost-s3-test-"));
    try {
      const filePath = join(dir, "dump.bin");
      await downloadS3ObjectToFile({
        client,
        bucket: S3_BUCKET,
        key,
        filePath,
      });
      expect(await readFile(filePath, "utf8")).toBe("streamed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const deleted = await deleteS3Objects({
      client,
      bucket: S3_BUCKET,
      keys: [key],
    });
    expect(deleted).toBe(1);
  });

  test("testS3Connection probe succeeds", async () => {
    await testS3Connection({
      client,
      bucket: S3_BUCKET,
      prefix: "frost-tests/probe",
    });
  });
});
