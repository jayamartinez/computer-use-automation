import { render } from "../artifact/template.ts";
import type { Profile } from "../profile/schema.ts";
import type { GuardedExecutor } from "./guarded-executor.ts";

const LOGIN_TIMEOUT_MS = 10_000;

export type LoginResult = { ok: true } | { ok: false; denied: boolean; reason: string };

/**
 * Signs in using the app profile. Login is not part of any capability, and credential values
 * exist only in memory here: the log records the `{{secrets.*}}` reference, never the value.
 */
export async function ensureAuthenticated(
  executor: GuardedExecutor,
  profile: Profile,
  secrets: Record<string, string>,
): Promise<LoginResult> {
  if (await executor.waitFor(profile.login.authenticated, 0)) return { ok: true };
  for (const [index, step] of profile.login.steps.entries()) {
    const result = await executor.perform({
      epoch: executor.epoch,
      stepId: `login_${index + 1}`,
      intent: "Sign in (app profile)",
      action: step.action,
      targetName: `login.steps[${index}]`,
      target: step.target,
      risk: step.action === "fill" ? "reversible" : "read",
      ...(step.action === "fill"
        ? { value: { actual: render(step.value, { secrets }), logged: step.value } }
        : {}),
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    if (result.status === "denied") return { ok: false, denied: true, reason: result.reason };
    if (result.status === "unresolved") {
      return { ok: false, denied: false, reason: `Login control ${index + 1} was not found` };
    }
  }
  if (await executor.waitFor(profile.login.authenticated, LOGIN_TIMEOUT_MS)) return { ok: true };
  return {
    ok: false,
    denied: false,
    reason: "The authenticated screen did not appear after sign-in",
  };
}
