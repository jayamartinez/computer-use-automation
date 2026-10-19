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
import { safeToRetry, type ReplayResult } from "../outcome/result.ts";
import type { Profile, Tenant } from "../profile/schema.ts";
import { PlaywrightSurface, type LaunchOptions } from "../surface/playwright/playwright-surface.ts";
import type { Surface } from "../surface/types.ts";
import { replay } from "./interpreter.ts";
import { outputAsText } from "../outcome/values.ts";

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
  /** Opens the session at the entry URL. Tests replace it; everything else uses Playwright. */
  launch?: (options: LaunchOptions) => Promise<Surface & { close(): Promise<void> }>;
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

  const writeResult = (result: ReplayResult): Promise<void> =>
    writeFile(
      join(runDir, "result.json"),
      `${JSON.stringify(maskOutputs(result, artifact), null, 2)}\n`,
    );

  const launch = options.launch ?? ((o: LaunchOptions) => PlaywrightSurface.launch(o));
  const started = Date.now();
  let surface: Awaited<ReturnType<typeof launch>>;
  try {
    surface = await launch({
      entryUrl: tenant.baseUrl,
      allowRequest: (url) => requestAllowed(tenant.policy, url),
      // A person can only take over a window they can see.
      headed: options.headed ?? channel !== undefined,
      onBlocked: (url) => log.write("request_blocked", { url }),
    });
  } catch (error) {
    const result = startupFailure(error, { runId, artifact, tenant, log, logPath, started });
    await writeResult(result);
    return result;
  }
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
    await writeResult(result);
    return result;
  } finally {
    await surface.close();
  }
}

/**
 * The session never opened (no browser, or the entry URL did not load), so nothing has acted
 * and the caller may retry, for example once the application is up.
 */
function startupFailure(
  error: unknown,
  ctx: {
    runId: string;
    artifact: Artifact;
    tenant: Tenant;
    log: RunLog;
    logPath: string;
    started: number;
  },
): ReplayResult {
  const { runId, artifact, tenant, log } = ctx;
  const message = log.scrubText(
    error instanceof Error ? error.message.split("\n")[0]! : String(error),
  );
  const failure = {
    category: "runtime_error" as const,
    stepId: "launch",
    intent: "Open a session at the tenant's entry URL",
    expected: "The application's entry page to load",
    observed: message,
    sideEffects: "none" as const,
    safeToRetry: safeToRetry("runtime_error", "none"),
    outputsVerified: false as const,
  };
  log.write("run_start", { runId, capability: artifact.id, version: artifact.version });
  log.write("runtime_error", { stepId: "launch", message });
  log.write("run_end", { status: "failure", failure });
  return {
    runId,
    capability: { id: artifact.id, version: artifact.version, contentHash: artifact.contentHash },
    tenant: tenant.tenant,
    durationMs: Date.now() - ctx.started,
    stepsCompleted: 0,
    recoveries: [],
    interventions: [],
    warnings: [],
    log: ctx.logPath,
    status: "failure",
    failure,
  };
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
