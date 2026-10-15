// The replay result contract. `status` is exactly one of three; recoveries, interventions and
// warnings annotate any of them.

import { z } from "zod";

export const FailureCategorySchema = z.enum([
  "invalid_input",
  "policy_denied",
  "target_unresolved",
  "target_ambiguous",
  "unexpected_state",
  "app_error",
  "extraction_invalid",
  "recovery_exhausted",
  "outcome_unknown",
  "aborted_by_human",
  "escalation_timeout",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

/**
 * Whether a failure with no side effects could go differently on a second try with the same
 * inputs. Failures fixed by the inputs, the policy, the artifact or a human decision cannot.
 * `outcome_unknown` qualifies only once a human has confirmed nothing was committed.
 */
const TRANSIENT: Record<FailureCategory, boolean> = {
  invalid_input: false,
  policy_denied: false,
  target_unresolved: false,
  target_ambiguous: false,
  unexpected_state: true,
  app_error: true,
  extraction_invalid: false,
  recovery_exhausted: true,
  outcome_unknown: true,
  aborted_by_human: false,
  escalation_timeout: true,
};

/** `safeToRetry` tells a calling agent both that retrying cannot duplicate work and that it may help. */
export function safeToRetry(
  category: FailureCategory,
  sideEffects: Failure["sideEffects"],
): boolean {
  return sideEffects === "none" && TRANSIENT[category];
}

const OutputValueSchema = z.union([
  z.string(),
  z.number(),
  z.strictObject({ amount: z.string().regex(/^-?\d+\.\d{2}$/), currency: z.string() }),
]);
export type OutputValue = z.infer<typeof OutputValueSchema>;

const common = {
  runId: z.string(),
  capability: z.strictObject({ id: z.string(), version: z.string(), contentHash: z.string() }),
  tenant: z.string(),
  durationMs: z.number(),
  stepsCompleted: z.number().int(),
  recoveries: z.array(
    z.strictObject({ condition: z.string(), atStep: z.string(), attempts: z.number().int() }),
  ),
  interventions: z.array(
    z.strictObject({ id: z.string(), kind: z.string(), resolution: z.string() }),
  ),
  warnings: z.array(
    z.strictObject({
      kind: z.enum(["locator_fallback", "slow_load", "version_mismatch"]),
      stepId: z.string().optional(),
    }),
  ),
  log: z.string(),
};

const FailureSchema = z.strictObject({
  category: FailureCategorySchema,
  stepId: z.string(),
  intent: z.string(),
  expected: z.string(),
  // Never contains screen content; the masked evidence files carry that.
  observed: z.string(),
  sideEffects: z.enum(["none", "possible", "committed"]),
  safeToRetry: z.boolean(),
  // A failure never returns outputs read from a checkpointed screen. Stated explicitly so a
  // human-confirmed commit (sideEffects "committed") is not mistaken for a verified success.
  outputsVerified: z.literal(false),
  // Absent when the run failed before a screen existed (invalid input, preflight denial).
  // The screenshot is absent while a native dialog blocks the page; the observation holds it.
  evidence: z
    .strictObject({ screenshot: z.string().optional(), observation: z.string() })
    .optional(),
});
export type Failure = z.infer<typeof FailureSchema>;

export const ReplayResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...common,
    status: z.literal("success"),
    outputs: z.record(z.string(), OutputValueSchema),
  }),
  z.strictObject({
    ...common,
    status: z.literal("business_outcome"),
    outcome: z.strictObject({
      code: z.string(),
      atStep: z.string(),
      message: z.string().optional(),
    }),
  }),
  z.strictObject({ ...common, status: z.literal("failure"), failure: FailureSchema }),
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;
