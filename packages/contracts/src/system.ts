import { z } from "zod";

export const HealthResponse = z.object({
  status: z.literal("ok"),
  serverTime: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const DependencyStatus = z.enum(["ok", "degraded", "down"]);

export const StatusResponse = z.object({
  status: DependencyStatus,
  version: z.string(),
  environment: z.string(),
  serverTime: z.iso.datetime(),
  checks: z.object({
    d1: z.object({ status: DependencyStatus, latencyMs: z.number().nonnegative() }),
  }),
});
export type StatusResponse = z.infer<typeof StatusResponse>;
