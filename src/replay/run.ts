import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact } from "../artifact/schema.ts";
import { redact, SECRET } from "../evidence/redact.ts";
import { RunLog } from "../evidence/run-log.ts";
import { ControlState } from "../executor/control.ts";
import { GuardedExecutor } from "../executor/guarded-executor.ts";
import { requestAllowed } from "../executor/policy.ts";
import type { InterventionChannel } from "../handoff/channel.ts";
import { HandoffController } from "../handoff/controller.ts";
import type { ReplayResult } from "../outcome/result.ts";
import type { Profile, Tenant } from "../profile/schema.ts";
import { PlaywrightSurface } from "../surface/playwright/playwright-surface.ts";
import type { Surface } from "../surface/types.ts";
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
  /** Run irreversible steps unattended; honoured only for an `approved` artifact. */
  allowIrreversible?: boolean;
  /**
   * Where intervention requests go. With one, escalations, approvals and unknown outcomes are
   * put to a person working in the same browser window, which is then opened headed.
   */
  channel?: InterventionChannel;
  handoffTimeouts?: { claimMs: number; humanMs: number };
  /**
   * Receives the live session once it is open. An operator surface needs it to show the
   * session; tests use it to act as the person in it.
   */
  onSurface?: (surface: Surface) => void;
};

const DEFAULT_HANDOFF_TIMEOUTS = { claimMs: 10 * 60_000, humanMs: 30 * 60_000 };

/**
 * Runs one replay in a fresh browser session and writes `runs/<runId>/`. The returned result
 * carries the real outputs for the caller; the copy on disk has them masked by sensitivity.
 */
export async function runReplay(options: RunReplayOptions): Promise<ReplayResult> {
  const { artifact, inputs, profile, tenant, secrets, channel } = options;
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const runDir = join(options.runsDir, runId);
  await mkdir(runDir, { recursive: true });
  const logPath = join(runDir, "run.jsonl");

  const redactedInputs = Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [
      name,
      redact(value, artifact.inputs[name]?.sensitivity ?? "pii"),
    ]),
  );
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
    // A person can only take over a window they can see.
    headed: options.headed ?? channel !== undefined,
    onBlocked: (url) => log.write("request_blocked", { url }),
  });
  options.onSurface?.(surface);
  try {
    // One owner of the session for both the executor and the handoff, so a transfer of
    // control fences every action planned before it.
    const control = new ControlState();
    const executor = new GuardedExecutor({
      surface,
      policy: tenant.policy,
      control,
      log,
      masks: profile.masks,
      runDir,
    });
    const timeouts = options.handoffTimeouts ?? DEFAULT_HANDOFF_TIMEOUTS;
    const handoff = channel
      ? new HandoffController({
          runId,
          runDir,
          capability: { id: artifact.id, version: artifact.version },
          inputs: redactedInputs,
          surface,
          control,
          channel,
          log,
          masks: profile.masks,
          commitControls: profile.risk.commitControls,
          settleMs: profile.timeouts.slowLoadMs,
          claimTimeoutMs: timeouts.claimMs,
          humanTimeoutMs: timeouts.humanMs,
        })
      : undefined;
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
      allowIrreversible: options.allowIrreversible ?? false,
      ...(handoff ? { handoff } : {}),
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
