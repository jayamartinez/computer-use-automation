// App profile (per vendor product) and tenant binding (per deployment). Reviewable data.

import { z } from "zod";
import { ActionTypeSchema, RiskSchema } from "../artifact/schema.ts";
import { ScopePathSchema, TargetSchema } from "../surface/target.ts";

const TextSignatureSchema = z.strictObject({
  scope: ScopePathSchema.optional(),
  textPresent: z.string().min(1),
});

const LoginStepSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("fill"), target: TargetSchema, value: z.string() }),
  z.strictObject({ action: z.literal("click"), target: TargetSchema }),
]);

// A screen state any capability of this app can run into, and what replay does about it.
const conditionCommon = {
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  signature: TextSignatureSchema,
};

const ConditionSchema = z.discriminatedUnion("disposition", [
  z.strictObject({
    ...conditionCommon,
    disposition: z.literal("recover"),
    // The control that clears the condition. Without one, resuming is enough.
    handler: z.strictObject({ click: TargetSchema }).optional(),
    // `continue` re-waits for the interrupted step's expected state. A restart signs in again
    // and starts from the first step, and only while no irreversible step has been dispatched.
    resume: z.enum(["continue", "restart_if_no_side_effects"]),
    // Per condition per run; one more match is `recovery_exhausted`.
    maxAttempts: z.number().int().positive().default(2),
  }),
  z.strictObject({ ...conditionCommon, disposition: z.literal("escalate") }),
  z.strictObject({ ...conditionCommon, disposition: z.literal("fail") }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const ProfileSchema = z.strictObject({
  product: z.string(),
  versions: z.string(),
  surface: z.literal("web"),
  scopes: z.array(z.string()),
  versionProbe: z.strictObject({ scope: ScopePathSchema, pattern: z.string() }),
  // Login belongs to the app, not to any capability. Values are `{{secrets.*}}` references.
  login: z.strictObject({
    steps: z.array(LoginStepSchema).min(1),
    authenticated: TextSignatureSchema,
  }),
  conditions: z.array(ConditionSchema),
  timeouts: z.strictObject({
    // Waiting for a state is built in; taking longer than this adds a `slow_load` warning.
    slowLoadMs: z.number().int().positive(),
  }),
  risk: z.strictObject({
    safeControls: z.array(z.string()),
    commitControls: z.array(z.string()),
  }),
  // Visible labels whose values are masked in screenshots and saved observations.
  masks: z.array(
    z.strictObject({ label: z.string().min(1), where: z.enum(["below", "right_of"]) }),
  ),
});
export type Profile = z.infer<typeof ProfileSchema>;

const PolicySchema = z.strictObject({
  origins: z.array(z.url()).min(1),
  // Exact paths, or a prefix when the entry ends in `*`. Anything not listed is blocked.
  paths: z.array(z.string().regex(/^\/[^*]*\*?$/, "A path starts with / and may end in *")).min(1),
  scopes: z.array(z.string()),
  actions: z.array(ActionTypeSchema),
  maxRisk: RiskSchema,
});
export type Policy = z.infer<typeof PolicySchema>;

export const TenantSchema = z.strictObject({
  tenant: z.string(),
  product: z.string(),
  deployedVersion: z.string(),
  baseUrl: z.url(),
  // References only. A credential value never appears in a file.
  credentials: z.record(z.string(), z.string().regex(/^env:[A-Z][A-Z0-9_]*$/)),
  policy: PolicySchema,
});
export type Tenant = z.infer<typeof TenantSchema>;
