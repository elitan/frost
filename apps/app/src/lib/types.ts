export interface EnvVar {
  key: string;
  value: string;
  buildTime?: boolean;
}

export type DeployType = "repo" | "image";
