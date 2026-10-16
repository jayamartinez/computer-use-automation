// Risk classification during discovery: deterministic rules from the app profile. The model is
// never asked, and nothing it says can lower a class.

import type { ActionType, Risk } from "../artifact/schema.ts";
import type { Profile } from "../profile/schema.ts";
import { normalize } from "../surface/resolve.ts";

export type RiskDecision = {
  risk: Risk;
  rule: string;
  /** A person must approve this action before it runs. */
  needsApproval: boolean;
};

export function classifyRisk(
  rules: Profile["risk"],
  action: ActionType,
  element: { role: string; name: string },
): RiskDecision {
  switch (action) {
    case "extract":
    case "assert":
      return { risk: "read", rule: `${action}:read`, needsApproval: false };
    case "fill":
    case "select":
      return { risk: "reversible", rule: `${action}:reversible`, needsApproval: false };
    case "click": {
      const name = normalize(element.name);
      if (rules.commitControls.some((c) => normalize(c) === name)) {
        return { risk: "irreversible", rule: "commit_control", needsApproval: true };
      }
      if (rules.safeControls.some((c) => normalize(c) === name)) {
        return { risk: "read", rule: "safe_control", needsApproval: false };
      }
      if (element.role === "link")
        return { risk: "read", rule: "link:default", needsApproval: false };
      // A button nobody has classified could post something. It stays reversible in the
      // artifact (a reviewer decides), but a person approves it before discovery clicks it.
      return { risk: "reversible", rule: "button:unknown", needsApproval: true };
    }
    default:
      return action satisfies never;
  }
}
