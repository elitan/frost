import { describe, expect, test } from "bun:test";
import {
  parseEnvVarList,
  resolveDeploymentEnvVars,
  selectClonedServiceEnvVars,
} from "./preview-env-vars";

const project = [
  { key: "DATABASE_URL", value: "postgres://prod" },
  { key: "SHARED", value: "project" },
];
const preview = [
  { key: "DATABASE_URL", value: "postgres://preview" },
  { key: "PREVIEW_ONLY", value: "1" },
];
const service = [
  { key: "PORT", value: "3000" },
  { key: "SHARED", value: "service" },
];

describe("selectClonedServiceEnvVars", () => {
  const source = [
    { key: "PORT", value: "3000" },
    { key: "API_SECRET", value: "s3cret" },
  ];

  test("copies everything when inheriting", () => {
    expect(selectClonedServiceEnvVars(source, true)).toEqual(source);
  });

  test("keeps only system vars like PORT when not inheriting", () => {
    expect(selectClonedServiceEnvVars(source, false)).toEqual([
      { key: "PORT", value: "3000" },
    ]);
  });
});

describe("resolveDeploymentEnvVars", () => {
  test("production merges project then service vars, ignoring preview vars", () => {
    expect(
      resolveDeploymentEnvVars({
        environmentType: "production",
        projectEnvVars: project,
        previewEnvVars: preview,
        previewInheritEnvVars: false,
        serviceEnvVars: service,
      }),
    ).toEqual({
      DATABASE_URL: "postgres://prod",
      SHARED: "service",
      PORT: "3000",
    });
  });

  test("manual environments behave like production", () => {
    expect(
      resolveDeploymentEnvVars({
        environmentType: "manual",
        projectEnvVars: project,
        previewEnvVars: preview,
        previewInheritEnvVars: 0,
        serviceEnvVars: [],
      }),
    ).toEqual({ DATABASE_URL: "postgres://prod", SHARED: "project" });
  });

  test("preview without inheritance gets only preview and service vars", () => {
    expect(
      resolveDeploymentEnvVars({
        environmentType: "preview",
        projectEnvVars: project,
        previewEnvVars: preview,
        previewInheritEnvVars: 0,
        serviceEnvVars: [{ key: "PORT", value: "3000" }],
      }),
    ).toEqual({
      DATABASE_URL: "postgres://preview",
      PREVIEW_ONLY: "1",
      PORT: "3000",
    });
  });

  test("preview without inheritance and no preview vars gets no project vars", () => {
    expect(
      resolveDeploymentEnvVars({
        environmentType: "preview",
        projectEnvVars: project,
        previewEnvVars: [],
        previewInheritEnvVars: false,
        serviceEnvVars: [],
      }),
    ).toEqual({});
  });

  test("preview with inheritance layers project < preview < service", () => {
    expect(
      resolveDeploymentEnvVars({
        environmentType: "preview",
        projectEnvVars: project,
        previewEnvVars: preview,
        previewInheritEnvVars: 1,
        serviceEnvVars: service,
      }),
    ).toEqual({
      DATABASE_URL: "postgres://preview",
      SHARED: "service",
      PREVIEW_ONLY: "1",
      PORT: "3000",
    });
  });
});

describe("parseEnvVarList", () => {
  test("handles empty and invalid shapes", () => {
    expect(parseEnvVarList(null)).toEqual([]);
    expect(parseEnvVarList("")).toEqual([]);
    expect(parseEnvVarList("{}")).toEqual([]);
    expect(parseEnvVarList('[{"key":"A","value":"1"}]')).toEqual([
      { key: "A", value: "1" },
    ]);
  });
});
