// The capability artifact: a typed, versioned contract an agent can call, not a step list.
// This schema is the single source of truth; types are derived from it.

import { z } from "zod";
import { ScopePathSchema, TargetSchema } from "../surface/target.ts";
import { collectStrings, templateRefs } from "./template.ts";

export const RiskSchema = z.enum(["read", "reversible", "irreversible"]);
export type Risk = z.infer<typeof RiskSchema>;
export const riskRank = (risk: Risk): number => RiskSchema.options.indexOf(risk);

// The full vocabulary policy can allow.
export const ActionTypeSchema = z.enum(["click", "fill", "select", "extract", "assert"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const SensitivitySchema = z.enum([
  "none",
  "identifier",
  "financial",
  "account_number",
  "pii",
]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

const ValueTypeSchema = z.enum(["string", "integer", "money", "date", "enum"]);

const valueSpec = {
  type: ValueTypeSchema,
  sensitivity: SensitivitySchema,
  description: z.string().optional(),
  currency: z.string().length(3).optional(),
  values: z.array(z.string()).min(1).optional(),
};

const InputSchema = z.strictObject({
  ...valueSpec,
  pattern: z.string().optional(),
  example: z.string().optional(),
});
export type InputSpec = z.infer<typeof InputSchema>;

const OutputSchema = z.strictObject({
  ...valueSpec,
  // The extracted text must match, so a value that merely parses cannot pass as an output.
  pattern: z.string().optional(),
  fromStep: z.string(),
});
export type OutputSpec = z.infer<typeof OutputSchema>;

// Content predicates. Targets are referenced by name; values may be templated.
export type ArtifactSignature =
  | { textPresent: string; scope?: string[] }
  | { resolvable: string }
  | { cellEquals: { target: string; value: string; as?: "money" } }
  | { all: ArtifactSignature[] }
  | { any: ArtifactSignature[] };

export const SignatureSchema: z.ZodType<ArtifactSignature> = z.lazy(() =>
  z.union([
    z.strictObject({ textPresent: z.string().min(1), scope: ScopePathSchema.optional() }),
    z.strictObject({ resolvable: z.string() }),
    z.strictObject({
      // `as: "money"` compares amounts, so an input of 500.00 equals a screen's $500.00.
      cellEquals: z.strictObject({
        target: z.string(),
        value: z.string(),
        as: z.literal("money").optional(),
      }),
    }),
    z.strictObject({ all: z.array(SignatureSchema).min(1) }),
    z.strictObject({ any: z.array(SignatureSchema).min(1) }),
  ]),
);

// `valueEquals` reads back the step's own target.
const ExpectSchema = z.union([z.strictObject({ valueEquals: z.string() }), SignatureSchema]);
export type Expect = z.infer<typeof ExpectSchema>;

const stepBase = {
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  intent: z.string().min(1),
  risk: RiskSchema,
  timeoutMs: z.number().int().positive(),
  retry: z.strictObject({ max: z.number().int().min(0) }),
  onTimeout: z.literal("outcome_unknown").optional(),
};
const stepCommon = { ...stepBase, target: z.string() };

// Every state-changing step states what the screen must look like afterwards. An `assert`
// acts on nothing: it reads the screen and stops the run if the check does not hold.
const StepSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...stepCommon, action: z.literal("click"), expect: ExpectSchema }),
  z.strictObject({
    ...stepCommon,
    action: z.literal("fill"),
    value: z.string(),
    expect: ExpectSchema,
  }),
  z.strictObject({
    ...stepCommon,
    action: z.literal("select"),
    value: z.string(),
    expect: ExpectSchema,
  }),
  z.strictObject({ ...stepCommon, action: z.literal("extract"), output: z.string() }),
  z.strictObject({ ...stepBase, action: z.literal("assert"), check: SignatureSchema }),
]);
export type Step = z.infer<typeof StepSchema>;

const CheckpointSchema = z.strictObject({
  all: z.array(z.union([z.strictObject({ outputParsed: z.string() }), SignatureSchema])).min(1),
});

const ArtifactShape = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/),
  // major = contract change; minor = steps or targets; patch = rationale or description.
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: z.enum(["draft", "approved"]),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  description: z.string().min(1),
  app: z.strictObject({
    product: z.string(),
    recordedVersion: z.string(),
    surface: z.literal("web"),
  }),
  inputs: z.record(z.string(), InputSchema),
  outputs: z.record(z.string(), OutputSchema),
  targets: z.record(z.string(), TargetSchema),
  steps: z.array(StepSchema).min(1),
  outcomes: z.array(
    z.strictObject({
      code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      afterSteps: z.array(z.string()).min(1),
      signature: SignatureSchema,
    }),
  ),
  // All app-profile conditions apply; none are copied into the artifact.
  conditions: z.literal("profile"),
  checkpoint: CheckpointSchema,
  requires: z.strictObject({
    actions: z.array(ActionTypeSchema),
    maxRisk: RiskSchema,
    scopes: z.array(z.string()),
  }),
  provenance: z.strictObject({
    traceId: z.string().optional(),
    model: z.string().optional(),
    discoveredAt: z.string().optional(),
    compilerVersion: z.string().optional(),
    verifiedWith: z.string().optional(),
    author: z.string().optional(),
  }),
});

type Shape = z.infer<typeof ArtifactShape>;

function signatureTargets(signature: unknown): string[] {
  if (signature === null || typeof signature !== "object") return [];
  if ("resolvable" in signature) return [signature.resolvable as string];
  if ("cellEquals" in signature) return [(signature.cellEquals as { target: string }).target];
  if ("all" in signature) return (signature.all as unknown[]).flatMap(signatureTargets);
  if ("any" in signature) return (signature.any as unknown[]).flatMap(signatureTargets);
  return [];
}

/** Cross-reference rules a field-level schema cannot express. */
function checkReferences(artifact: Shape, ctx: z.RefinementCtx): void {
  const issue = (path: PropertyKey[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const targetExists = (name: string, path: PropertyKey[]) => {
    if (!(name in artifact.targets)) issue(path, `Unknown target reference "${name}"`);
  };

  const stepIds = new Set<string>();
  artifact.steps.forEach((step, i) => {
    if (stepIds.has(step.id)) issue(["steps", i, "id"], `Duplicate step id "${step.id}"`);
    stepIds.add(step.id);
    if ("target" in step) targetExists(step.target, ["steps", i, "target"]);
    if ("expect" in step) {
      for (const name of signatureTargets(step.expect)) targetExists(name, ["steps", i, "expect"]);
    }
    if (step.action === "assert") {
      for (const name of signatureTargets(step.check)) targetExists(name, ["steps", i, "check"]);
    }
    if (step.action === "extract" && !(step.output in artifact.outputs)) {
      issue(["steps", i, "output"], `Step extracts undeclared output "${step.output}"`);
    }
    if (step.risk === "irreversible") {
      if (step.retry.max !== 0) {
        issue(["steps", i, "retry"], "An irreversible step must never be retried (retry.max: 0)");
      }
      if (step.onTimeout !== "outcome_unknown") {
        issue(
          ["steps", i, "onTimeout"],
          'An irreversible step must set onTimeout: "outcome_unknown"',
        );
      }
      // The pre-commit read-back: the screen must be checked against the inputs right before.
      if (artifact.steps[i - 1]?.action !== "assert") {
        issue(["steps", i], "An irreversible step must come immediately after an assert step");
      }
    }
  });

  for (const [name, output] of Object.entries(artifact.outputs)) {
    const source = artifact.steps.find((step) => step.id === output.fromStep);
    if (source?.action !== "extract" || source.output !== name) {
      issue(["outputs", name, "fromStep"], `Output "${name}" has no extract step that produces it`);
    }
  }

  artifact.outcomes.forEach((outcome, i) => {
    for (const id of outcome.afterSteps) {
      if (!stepIds.has(id)) issue(["outcomes", i, "afterSteps"], `Unknown step "${id}"`);
    }
    for (const name of signatureTargets(outcome.signature)) {
      targetExists(name, ["outcomes", i, "signature"]);
    }
  });

  artifact.checkpoint.all.forEach((predicate, i) => {
    if ("outputParsed" in predicate) {
      if (!(predicate.outputParsed in artifact.outputs)) {
        issue(["checkpoint", "all", i], `Unknown output "${predicate.outputParsed}"`);
      }
    } else {
      for (const name of signatureTargets(predicate)) targetExists(name, ["checkpoint", "all", i]);
    }
  });

  // Values come only from declared inputs. A secret can never be named in an artifact.
  for (const section of ["targets", "steps", "outcomes", "checkpoint"] as const) {
    for (const text of collectStrings(artifact[section])) {
      for (const ref of templateRefs(text)) {
        if (ref.scope !== "inputs" || !(ref.name in artifact.inputs)) {
          issue([section], `Template {{${ref.scope}.${ref.name}}} is not a declared input`);
        }
      }
    }
  }

  // `requires` is what policy reads before anything runs, so it has to be honest.
  const { requires } = artifact;
  artifact.steps.forEach((step, i) => {
    if (!requires.actions.includes(step.action)) {
      issue(["requires", "actions"], `Step "${step.id}" uses undeclared action "${step.action}"`);
    }
    if (riskRank(step.risk) > riskRank(requires.maxRisk)) {
      issue(["requires", "maxRisk"], `Step "${step.id}" exceeds declared maxRisk`);
    }
    const scopes = "target" in step ? (artifact.targets[step.target]?.scope ?? []) : [];
    for (const scope of scopes) {
      if (!requires.scopes.includes(scope)) {
        issue(["steps", i, "target"], `Step "${step.id}" acts in undeclared scope "${scope}"`);
      }
    }
  });
}

export const ArtifactSchema = ArtifactShape.superRefine(checkReferences);
export type Artifact = z.infer<typeof ArtifactSchema>;
