import { z } from "zod";
import { deploymentsSchema, servicesSchema } from "@/lib/db-schemas";

export const envVarSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(
      /^[^=\s\0]+$/,
      "Env var key must not contain '=', whitespace or NUL",
    ),
  value: z.string(),
  buildTime: z
    .boolean()
    .optional()
    .describe(
      "Also pass this variable to `docker build` (as --build-arg and in the build-context .env). Build-time values are visible in the image, so leave secrets runtime-only. Keys with a public prefix (NEXT_PUBLIC_, VITE_, PUBLIC_, REACT_APP_, NUXT_PUBLIC_, EXPO_PUBLIC_, GATSBY_) are always build-time. All variables are available at runtime.",
    ),
});

export const volumeConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9._-]+$/),
  path: z.string().startsWith("/"),
});

export const serviceRuntimeStatusSchema = z.enum([
  "not-deployed",
  "starting",
  "online",
  "offline",
]);

export const serviceAttentionStatusSchema = z
  .enum(["updating", "last-deploy-failed"])
  .nullable();

export const serviceWithDeploymentSchema = servicesSchema.extend({
  latestDeployment: deploymentsSchema.nullable(),
  runtimeStatus: serviceRuntimeStatusSchema,
  attentionStatus: serviceAttentionStatusSchema,
});
