import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { redact, SECRET } from "../evidence/redact.ts";
import { RunLog } from "../evidence/run-log.ts";
import { ControlState } from "../executor/control.ts";
import { GuardedExecutor } from "../executor/guarded-executor.ts";
import { requestAllowed } from "../executor/policy.ts";
import type { InterventionChannel } from "../handoff/channel.ts";
import { HandoffController } from "../handoff/controller.ts";
import type { Profile, Tenant } from "../profile/schema.ts";
import { PlaywrightSurface } from "../surface/playwright/playwright-surface.ts";
import type { Surface } from "../surface/types.ts";
import type { Trace } from "../trace/schema.ts";
import { loadTrace, saveTrace } from "../trace/store.ts";
import type { DecisionProvider } from "./llm/provider.ts";
import { discover } from "./loop.ts";
import { inputValues, type CapabilityRequest } from "./request.ts";

export type RunDiscoveryOptions = {
  request: CapabilityRequest;
  profile: Profile;
  tenant: Tenant;
  secrets: Record<string, string>;
  provider: DecisionProvider;
  runsDir: string;
  headed?: boolean;
  channel?: InterventionChannel;
  handoffTimeouts?: { claimMs: number; humanMs: number };
  onSurface?: (surface: Surface) => void;
};

const DEFAULT_HANDOFF_TIMEOUTS = { claimMs: 10 * 60_000, humanMs: 30 * 60_000 };

/** Runs one discovery in a fresh browser session and writes `runs/<runId>/` with the trace. */
export async function runDiscovery(
  options: RunDiscoveryOptions,
): Promise<{ trace: Trace; runDir: string; tracePath: string }> {
  const { request, profile, tenant, secrets, channel } = options;
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const runDir = join(options.runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const inputs = inputValues(request);
  const redactedInputs = Object.fromEntries(
    Object.entries(request.inputs).map(([name, spec]) => [
      name,
      redact(spec.value, spec.sensitivity),
    ]),
  );
  const log = RunLog.toFile(join(runDir, "run.jsonl"), [
    ...Object.values(secrets).map((value) => ({ value, replacement: SECRET })),
    // Discovery's own input values are written as their templates wherever they appear in free
    // text, so a recorded answer replays and compiles without the discovery value.
    ...Object.entries(request.inputs).map(([name, spec]) => ({
      value: spec.value,
      replacement: `{{inputs.${name}}}`,
    })),
    ...Object.entries(request.verifyInputs).flatMap(([name, value]) => {
      const sensitivity = request.inputs[name]?.sensitivity ?? "pii";
      return sensitivity === "none" ? [] : [{ value, replacement: redact(value, sensitivity) }];
    }),
  ]);
  void inputs;

  const surface = await PlaywrightSurface.launch({
    entryUrl: tenant.baseUrl,
    allowRequest: (url) => requestAllowed(tenant.policy, url),
    headed: options.headed ?? channel !== undefined,
    onBlocked: (url) => log.write("request_blocked", { url }),
  });
  options.onSurface?.(surface);
  try {
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
          capability: { id: request.id, version: "discovery" },
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
    const trace = await discover({
      runId,
      runDir,
      request,
      profile,
      tenant,
      secrets,
      executor,
      provider: options.provider,
      log,
      ...(handoff ? { handoff } : {}),
    });
    const tracePath = join(runDir, "trace.json");
    await saveTrace(tracePath, trace, (text) => log.scrubText(text));
    // Callers get the trace exactly as written: scrubbed, so the CLI never echoes raw text.
    return { trace: await loadTrace(tracePath), runDir, tracePath };
  } finally {
    await surface.close();
  }
}
