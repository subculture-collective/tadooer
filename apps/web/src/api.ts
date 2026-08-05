import {
  buildResponseSchema,
  healthResponseSchema,
  readinessResponseSchema,
  type BuildResponse,
  type HealthResponse,
  type ReadinessResponse,
} from "@suite/contracts";
import type { z } from "zod";

const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`Request failed with status ${String(response.status)}`);
  }
  return schema.parse(body);
};

export interface FoundationStatus {
  readonly health: HealthResponse;
  readonly readiness: ReadinessResponse;
  readonly build: BuildResponse;
}

export const loadFoundationStatus = async (): Promise<FoundationStatus> => {
  const [health, readiness, build] = await Promise.all([
    get("/api/health", healthResponseSchema),
    get("/api/ready", readinessResponseSchema),
    get("/api/build", buildResponseSchema),
  ]);

  return { health, readiness, build };
};
