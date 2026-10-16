// The verification replay: a compiled draft is replayed with the request's second input set,
// different from the discovery data, so a locator that silently depended on the discovery
// record's values fails here instead of in production. The draft is saved only on success.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArtifact, saveArtifact } from "../artifact/store.ts";
import type { Artifact } from "../artifact/schema.ts";
import type { CapabilityRequest } from "../discovery/request.ts";
import type { InterventionChannel } from "../handoff/channel.ts";
import type { ReplayResult } from "../outcome/result.ts";
import type { Profile, Tenant } from "../profile/schema.ts";
import { runReplay } from "../replay/run.ts";
import type { Trace } from "../trace/schema.ts";
import { compileTrace, type CompileReport } from "./compile.ts";

export type VerifyOptions = {
  profile: Profile;
  tenant: Tenant;
  secrets: Record<string, string>;
  runsDir: string;
  /** A draft never runs an irreversible step unattended; verification of a write capability needs an approver. */
  channel?: InterventionChannel;
};

export async function verifyArtifact(
  artifact: Artifact,
  request: CapabilityRequest,
  options: VerifyOptions,
): Promise<ReplayResult> {
  return runReplay({
    artifact: parseArtifact(artifact),
    inputs: request.verifyInputs,
    profile: options.profile,
    tenant: options.tenant,
    secrets: options.secrets,
    runsDir: options.runsDir,
    headed: options.channel !== undefined,
    ...(options.channel ? { channel: options.channel } : {}),
  });
}

export type CompileOutcome = {
  artifact: Artifact;
  report: CompileReport;
  verification: ReplayResult;
  /** Where the artifact and its report were written; absent when verification failed. */
  saved?: { artifact: string; report: string };
};

/** Compiles, verifies with different inputs, and writes only what verified. */
export async function compileAndVerify(
  trace: Trace,
  request: CapabilityRequest,
  options: VerifyOptions & { outDir: string },
): Promise<CompileOutcome> {
  const { artifact, report } = compileTrace(trace, request);
  const verification = await verifyArtifact(artifact, request, options);
  const outcome: CompileOutcome = { artifact, report, verification };
  if (verification.status !== "success") return outcome;
  const verified = {
    ...artifact,
    provenance: {
      ...artifact.provenance,
      verifiedWith: "a second input set, different from discovery",
    },
  };
  const artifactPath = join(options.outDir, `${request.id}.json`);
  const reportPath = join(options.outDir, `${request.id}.compile.json`);
  const saved = await saveArtifact(artifactPath, verified);
  await writeFile(
    reportPath,
    `${JSON.stringify({ ...report, contentHash: saved.contentHash, verification: { runId: verification.runId, status: verification.status, warnings: verification.warnings } }, null, 2)}\n`,
  );
  return { ...outcome, artifact: saved, saved: { artifact: artifactPath, report: reportPath } };
}
