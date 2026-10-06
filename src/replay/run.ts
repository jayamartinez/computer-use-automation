import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact } from "../artifact/schema.ts";
import { redact, SECRET } from "../evidence/redact.ts";
import { RunLog } from "../evidence/run-log.ts";
import { ControlState } from "../executor/control.ts";
import { GuardedExecutor } from "../executor/guarded-executor.ts";
import { requestAllowed } from "../executor/policy.ts";
import type { ReplayResult } from "../outcome/result.ts";
import type { Profile, Tenant } from "../profile/schema.ts";
import { PlaywrightSurface } from "../surface/playwright/playwright-surface.ts";
import { replay } from "./interpreter.ts";
import { outputAsText } from "./values.ts";

export type RunReplayOptions = {
  artifact: Artifact;
  inputs: Record<string, string>;
  profile: Profile;
  tenant: Tenant;
  secrets: Record<string, string>;
  runsDir: string;
  headed?: boolean;
};

/**
 * Runs one replay in a fresh browser session and writes `runs/<runId>/`. The returned result
 * carries the real outputs for the caller; the copy on disk has them masked by sensitivity.
 */
export async function runReplay(options: RunReplayOptions): Promise<ReplayResult> {
  const { artifact, inputs, profile, tenant, secrets } = options;
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const runDir = join(options.runsDir, runId);
  await mkdir(runDir, { recursive: true });
  const logPath = join(runDir, "run.jsonl");

  const log = RunLog.toFile(logPath, [
    ...Object.values(secrets).map((value) => ({ value, replacement: SECRET })),
    ...Object.entries(inputs).flatMap(([name, value]) => {
      const sensitivity = artifact.inputs[name]?.sensitivity ?? "pii";
      return sensitivity === "none" ? [] : [{ value, replacement: redact(value, sensitivity) }];
    }),
  ]);

  const surface = await PlaywrightSurface.launch({
    entryUrl: tenant.baseUrl,
    allowRequest: (url) => requestAllowed(tenant.policy, url),
    headed: options.headed ?? false,
    onBlocked: (url) => log.write("request_blocked", { url }),
  });
  try {
    const executor = new GuardedExecutor({
      surface,
      policy: tenant.policy,
      control: new ControlState(),
      log,
      masks: profile.masks,
      runDir,
    });
    const result = await replay({
      runId,
      artifact,
      inputs,
      profile,
      tenant,
      secrets,
      executor,
      log,
      logPath,
    });
    await writeFile(
      join(runDir, "result.json"),
      `${JSON.stringify(maskOutputs(result, artifact), null, 2)}\n`,
    );
    return result;
  } finally {
    await surface.close();
  }
}

function maskOutputs(result: ReplayResult, artifact: Artifact): unknown {
  if (result.status !== "success") return result;
  return {
    ...result,
    outputs: Object.fromEntries(
      Object.entries(result.outputs).map(([name, value]) => [
        name,
        redact(outputAsText(value), artifact.outputs[name]?.sensitivity ?? "pii"),
      ]),
    ),
  };
}
