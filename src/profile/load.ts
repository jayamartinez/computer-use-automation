import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ProfileSchema, TenantSchema, type Profile, type Tenant } from "./schema.ts";

async function load<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${path}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export const loadProfile = (path: string): Promise<Profile> => load(path, ProfileSchema);
export const loadTenant = (path: string): Promise<Tenant> => load(path, TenantSchema);

/** Resolves credential references at the edge of the process. Values are never persisted. */
export function resolveSecrets(
  tenant: Tenant,
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tenant.credentials).map(([name, reference]) => {
      const variable = reference.slice("env:".length);
      const value = env[variable];
      if (!value) throw new Error(`Environment variable ${variable} is not set (see .env.example)`);
      return [name, value];
    }),
  );
}
