import { describe, expect, test } from "bun:test";
import { pathToVolumeName } from "./volumes";

describe("pathToVolumeName", () => {
  test("converts paths to volume names", () => {
    expect(pathToVolumeName("/data")).toBe("data");
    expect(pathToVolumeName("/var/lib/postgres")).toBe("var-lib-postgres");
    expect(pathToVolumeName("/app/uploads")).toBe("app-uploads");
  });

  test("preserves dots and underscores", () => {
    expect(pathToVolumeName("/root/.antigravity_tools")).toBe(
      "root-.antigravity_tools",
    );
    expect(pathToVolumeName("/var/my_data")).toBe("var-my_data");
    expect(pathToVolumeName("/home/user/.config/my_app")).toBe(
      "home-user-.config-my_app",
    );
  });
});
