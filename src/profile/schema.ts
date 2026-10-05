// App profile (per vendor product) and tenant binding (per deployment). Reviewable data.

import { z } from "zod";
import { ActionTypeSchema, RiskSchema } from "../artifact/schema.ts";
import { FramePathSchema, TargetSchema } from "../surface/target.ts";

const TextSignatureSchema = z.strictObject({
  frame: FramePathSchema.optional(),
  textPresent: z.string().min(1),
});

const LoginStepSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("fill"), target: TargetSchema, value: z.string() }),
  z.strictObject({ action: z.literal("click"), target: TargetSchema }),
]);

const ConditionSchema = z.strictObject({
  id: z.string(),
  disposition: z.enum(["recover", "escalate", "fail"]),
  signature: TextSignatureSchema,
  handler: z.union([z.literal("login"), z.strictObject({ click: TargetSchema })]).optional(),
  resume: z.enum(["continue", "restart_if_no_side_effects"]).optional(),
  maxAttempts: z.number().int().positive().optional(),
});

export const ProfileSchema = z.strictObject({
  product: z.string(),
  versions: z.string(),
  surface: z.literal("web"),
  frames: z.array(z.string()),
  versionProbe: z.strictObject({ frame: FramePathSchema, pattern: z.string() }),
  // Login belongs to the app, not to any capability. Values are `{{secrets.*}}` references.
  login: z.strictObject({
    steps: z.array(LoginStepSchema).min(1),
    authenticated: TextSignatureSchema,
  }),
  conditions: z.array(ConditionSchema),
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
  denyPaths: z.array(z.string()),
  frames: z.array(z.string()),
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
