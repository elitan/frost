import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildGarageConfigContent } from "./garage-runtime";
import { GARAGE_REGION } from "./object-storage/config";
import {
  allowGarageKey,
  createGarageBucket,
  createGarageKey,
  waitForGarageReady,
} from "./object-storage/garage-admin";
import { shellEscape } from "./shell-escape";

const execAsync = promisify(exec);

const GARAGE_TEST_IMAGE = "dxflrs/garage:v2.3.0";

export interface TestS3Server {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  stop(): Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createBucketWithRetry(
  containerName: string,
  bucket: string,
): Promise<{ id: string }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      return await createGarageBucket(containerName, bucket);
    } catch (error) {
      lastError = error;
      await new Promise(function wait(resolve) {
        setTimeout(resolve, 1000);
      });
    }
  }
  throw new Error(
    `Garage did not accept bucket creation: ${getErrorMessage(lastError)}`,
  );
}

export async function startGarageTestS3Server(input: {
  containerName: string;
  port: number;
  bucket: string;
}): Promise<TestS3Server | null> {
  const configDir = await mkdtemp(join(tmpdir(), "frost-test-garage-"));

  async function stop(): Promise<void> {
    await execAsync(`docker rm -f ${shellEscape(input.containerName)}`).catch(
      function ignore() {},
    );
    await rm(configDir, { recursive: true, force: true });
  }

  try {
    const configPath = join(configDir, "garage.toml");
    await writeFile(
      configPath,
      buildGarageConfigContent({
        rpcSecret: randomBytes(32).toString("hex"),
      }),
    );
    await chmod(configPath, 0o644);

    await execAsync(`docker rm -f ${shellEscape(input.containerName)}`).catch(
      function ignore() {},
    );
    await execAsync(
      `docker run -d --name ${shellEscape(input.containerName)} -p ${input.port}:3900 ` +
        `-v ${shellEscape(`${configPath}:/etc/garage.toml:ro`)} ` +
        `${GARAGE_TEST_IMAGE} /garage server --single-node`,
    );

    await waitForGarageReady(input.containerName);
    const bucket = await createBucketWithRetry(
      input.containerName,
      input.bucket,
    );
    const key = await createGarageKey(input.containerName, "frost-test");
    if (!key.secretAccessKey) {
      throw new Error("Garage did not return a secret access key");
    }
    await allowGarageKey({
      containerId: input.containerName,
      bucketId: bucket.id,
      accessKeyId: key.accessKeyId,
      permissions: "full",
    });

    return {
      endpoint: `http://127.0.0.1:${input.port}`,
      region: GARAGE_REGION,
      bucket: input.bucket,
      accessKeyId: key.accessKeyId,
      secretAccessKey: key.secretAccessKey,
      stop,
    };
  } catch (error) {
    console.warn(
      `[test] Garage S3 server unavailable, skipping: ${getErrorMessage(error)}`,
    );
    await stop();
    return null;
  }
}
