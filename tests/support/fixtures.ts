import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact } from "../../src/artifact/schema.ts";
import { loadArtifact } from "../../src/artifact/store.ts";
import { loadProfile, loadTenant } from "../../src/profile/load.ts";
import type { Tenant } from "../../src/profile/schema.ts";

export const FIXTURE_PATH = "tests/fixtures/coreserv.member.lookup_balance.json";

export const lookupArtifact = (): Promise<Artifact> => loadArtifact(FIXTURE_PATH);
export const coreservProfile = () => loadProfile("profiles/coreserv/profile.json");
export const lakeside = () => loadTenant("profiles/coreserv/tenants/lakeside.json");

/** The lakeside binding pointed at a test instance of the demo app. */
export async function lakesideAt(url: string): Promise<Tenant> {
  const tenant = await lakeside();
  return { ...tenant, baseUrl: url, policy: { ...tenant.policy, origins: [url] } };
}

/** Failure-path tests should not sit through production timeouts. */
export function withTimeouts(artifact: Artifact, timeoutMs: number): Artifact {
  return { ...artifact, steps: artifact.steps.map((step) => ({ ...step, timeoutMs })) };
}

export const tempDir = (): string => mkdtempSync(join(tmpdir(), "cua-test-"));
