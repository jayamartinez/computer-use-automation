// Deterministic policy decisions. Nothing here consults a model, and nothing can lower a risk.

import { riskRank, type ActionType, type Artifact, type Risk } from "../artifact/schema.ts";
import type { Policy } from "../profile/schema.ts";

export type PolicyDecision =
  { decision: "allow"; rule: string } | { decision: "deny"; rule: string; reason: string };

export type PolicyRequest = { action: ActionType; frame: string[]; risk: Risk; approved: boolean };

const deny = (rule: string, reason: string): PolicyDecision => ({ decision: "deny", rule, reason });

export function checkAction(policy: Policy, request: PolicyRequest): PolicyDecision {
  if (!policy.actions.includes(request.action)) {
    return deny("action_type", `Action "${request.action}" is not allowed for this tenant`);
  }
  // The top-level document has an empty frame path and is always in scope.
  const frame = request.frame.find((name) => !policy.frames.includes(name));
  if (frame !== undefined) return deny("frame", `Frame "${frame}" is not allowed for this tenant`);
  if (riskRank(request.risk) > riskRank(policy.maxRisk)) {
    return deny(
      "max_risk",
      `Risk "${request.risk}" exceeds the tenant maximum "${policy.maxRisk}"`,
    );
  }
  if (request.risk === "irreversible" && !request.approved) {
    return deny("irreversible_unapproved", "An irreversible action needs an explicit approval");
  }
  return { decision: "allow", rule: `${request.action}:${request.risk}` };
}

/** Rejects an artifact from its declared needs, before anything touches the application. */
export function checkRequires(policy: Policy, requires: Artifact["requires"]): PolicyDecision {
  const action = requires.actions.find((a) => !policy.actions.includes(a));
  if (action) return deny("action_type", `Capability requires disallowed action "${action}"`);
  const frame = requires.frames.find((f) => !policy.frames.includes(f));
  if (frame) return deny("frame", `Capability requires disallowed frame "${frame}"`);
  if (riskRank(requires.maxRisk) > riskRank(policy.maxRisk)) {
    return deny(
      "max_risk",
      `Capability requires risk "${requires.maxRisk}" above the tenant maximum`,
    );
  }
  return { decision: "allow", rule: "requires" };
}
