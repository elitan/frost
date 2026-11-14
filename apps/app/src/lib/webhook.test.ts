import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  buildPRCommentBody,
  groupServicesByProject,
  isSameRepoPullRequest,
  previewEnvironmentName,
  serviceMatchesPush,
  verifyWebhookSignature,
} from "./webhook";

const STATUS_ICON_BASE_URL = "https://frost.build/static/status";
const SERVICE_DASHBOARD_URL =
  "https://demo.frost.build/projects/proj_123/environments/env_123/services/svc_123";

function buildCommentBodyForTest(
  status: string,
  previewUrl: string | null = null,
  frostDomain: string | null = "demo.frost.build",
): string {
  return buildPRCommentBody({
    services: [
      {
        id: "svc_123",
        name: "frost",
        hostname: "frost",
        status,
        url: previewUrl,
      },
    ],
    projectId: "proj_123",
    environmentId: "env_123",
    frostDomain,
  });
}

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";

  test("accepts valid signature", () => {
    const payload = '{"test": true}';
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
  });

  test("rejects invalid signature", () => {
    const payload = '{"test": true}';
    const signature = "sha256=invalid";

    expect(verifyWebhookSignature(payload, signature, secret)).toBe(false);
  });

  test("rejects tampered payload", () => {
    const originalPayload = '{"test": true}';
    const tamperedPayload = '{"test": false}';
    const signature = `sha256=${createHmac("sha256", secret).update(originalPayload).digest("hex")}`;

    expect(verifyWebhookSignature(tamperedPayload, signature, secret)).toBe(
      false,
    );
  });

  test("rejects wrong secret", () => {
    const payload = '{"test": true}';
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

    expect(verifyWebhookSignature(payload, signature, "wrong-secret")).toBe(
      false,
    );
  });
});

describe("buildPRCommentBody", () => {
  test("renders ready status with plain circle and linked text", () => {
    const body = buildCommentBodyForTest(
      "running",
      "https://preview.example.com",
    );

    expect(body).toContain(
      `![](${STATUS_ICON_BASE_URL}/ready-dot.svg) [Ready](${SERVICE_DASHBOARD_URL})`,
    );
    expect(body).toContain("[Visit](https://preview.example.com)");
  });

  test("renders failed status with linked text", () => {
    const body = buildCommentBodyForTest("failed");

    expect(body).toContain(
      `![](${STATUS_ICON_BASE_URL}/failed-dot.svg) [Failed](${SERVICE_DASHBOARD_URL})`,
    );
  });

  test("renders building status with linked text", () => {
    const body = buildCommentBodyForTest("pending");

    expect(body).toContain(
      `![](${STATUS_ICON_BASE_URL}/building-dot.svg) [Building](${SERVICE_DASHBOARD_URL})`,
    );
  });

  test("renders plain status text when dashboard url is missing", () => {
    const body = buildCommentBodyForTest("running", null, null);

    expect(body).toContain(
      `| frost | ![](${STATUS_ICON_BASE_URL}/ready-dot.svg) Ready | - |`,
    );
    expect(body).not.toContain("[Ready](");
  });
});

describe("serviceMatchesPush", () => {
  const push = {
    repoUrl: "https://github.com/Elitan/Frost.git",
    branch: "main",
    defaultBranch: "main",
  };

  test("matches same repo and branch, ignoring case and .git", () => {
    expect(
      serviceMatchesPush(
        { repoUrl: "https://github.com/elitan/frost/", branch: "main" },
        push,
      ),
    ).toBe(true);
  });

  test("does not match a different branch", () => {
    expect(
      serviceMatchesPush(
        { repoUrl: "https://github.com/elitan/frost", branch: "staging" },
        push,
      ),
    ).toBe(false);
  });

  test("matches non-default branch pushes for services on that branch", () => {
    expect(
      serviceMatchesPush(
        { repoUrl: "git@github.com:elitan/frost.git", branch: "staging" },
        { ...push, branch: "staging" },
      ),
    ).toBe(true);
  });

  test("falls back to default branch when service branch is unset", () => {
    expect(
      serviceMatchesPush(
        { repoUrl: "https://github.com/elitan/frost", branch: null },
        push,
      ),
    ).toBe(true);
    expect(
      serviceMatchesPush(
        { repoUrl: "https://github.com/elitan/frost", branch: null },
        { ...push, branch: "feature" },
      ),
    ).toBe(false);
  });

  test("does not match a different repo", () => {
    expect(
      serviceMatchesPush(
        { repoUrl: "https://github.com/elitan/other", branch: "main" },
        push,
      ),
    ).toBe(false);
    expect(serviceMatchesPush({ repoUrl: null, branch: "main" }, push)).toBe(
      false,
    );
  });
});

describe("previewEnvironmentName", () => {
  test("prefixes with PR number", () => {
    expect(previewEnvironmentName(12, "Add login page")).toBe(
      "pr-12-add-login-page",
    );
  });

  test("handles empty slug", () => {
    expect(previewEnvironmentName(7, "!!!")).toBe("pr-7");
    expect(previewEnvironmentName(7, "")).toBe("pr-7");
  });

  test("truncates and keeps PR-number uniqueness", () => {
    const title = "a very long pull request title ".repeat(5);
    const a = previewEnvironmentName(1, title);
    const b = previewEnvironmentName(2, title);
    expect(a.length).toBeLessThanOrEqual(50);
    expect(a).not.toBe(b);
    expect(a.endsWith("-")).toBe(false);
  });
});

describe("isSameRepoPullRequest", () => {
  test("accepts same repo", () => {
    expect(isSameRepoPullRequest("Elitan/frost", "elitan/frost")).toBe(true);
  });

  test("rejects forks and missing head repo", () => {
    expect(isSameRepoPullRequest("attacker/frost", "elitan/frost")).toBe(false);
    expect(isSameRepoPullRequest(null, "elitan/frost")).toBe(false);
    expect(isSameRepoPullRequest(undefined, "elitan/frost")).toBe(false);
  });
});

describe("groupServicesByProject", () => {
  test("groups by projectId preserving order", () => {
    const groups = groupServicesByProject([
      { id: "a", projectId: "p1" },
      { id: "b", projectId: "p2" },
      { id: "c", projectId: "p1" },
    ]);
    expect(Array.from(groups.keys())).toEqual(["p1", "p2"]);
    expect(groups.get("p1")?.map((s) => s.id)).toEqual(["a", "c"]);
  });
});
