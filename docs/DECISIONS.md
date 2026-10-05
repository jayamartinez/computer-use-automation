# Decisions

Short records of the decisions that shape this project. Each has the decision, the reason, and what it costs. Changing one requires a conversation with the developer and an update here and in `AGENTS.md`.

## D1. TypeScript, single process

**Decision.** One Node process, a CLI, files for storage.
**Why.** Playwright is first-class in TypeScript, Zod gives one definition for runtime validation and static types, and discriminated unions fit the result contract. A single process keeps the live browser session, the control owner and the run log in one place, which is what makes the handoff simple to reason about.
**Cost.** A replay blocks while it waits for a human. In production this becomes an async `needs_human` state; the report says so.

## D2. Replay is implemented before discovery

**Decision.** Build the replay interpreter against hand-written artifacts first.
**Why.** The artifact schema and replay contract are the centre of the evaluation. Designing the schema from the consumer's side prevents it from becoming a tidied transcript. The hand-written artifacts then act as the specification the compiler must reproduce.
**Cost.** Whether a model can drive the legacy UI is not proven until late. Mitigated by a throwaway one-hour spike right after the surface milestone.

## D3. Typed trace and a compiler between discovery and the artifact

**Decision.** Discovery emits a typed trace; a separate compiler produces the artifact; a verification replay with different inputs gates saving it.
**Why.** The PDF requires the artifact to be decoupled from the model transcript. The trace records facts captured at the moment of acting (value provenance, locator candidates tested live for uniqueness, policy decisions), so compilation is deterministic and testable. Verifying with different inputs catches locators that accidentally depend on the discovery member's data.
**Cost.** One more stage and one more schema.

## D4. Discovery takes a capability request, not a bare goal

**Decision.** The request carries the natural-language goal plus typed inputs with values, declared outputs, verification inputs and optional outcome probes.
**Why.** Parameterization by provenance is exact; inferring parameters from a transcript afterward is guesswork. The calling side decides *what* the capability's contract is; the model discovers *how*.
**Cost.** This goes slightly beyond "goal + target" in the PDF. The report states the interpretation.

## D5. Deterministic replay with no model decisions

**Decision.** Nothing on the replay path may call an LLM, including error and outcome classification.
**Why.** PDF §3.3. Determinism, cost and auditability are the product. After each action the interpreter waits for the first match among the step's expected state, a business-outcome signature and a known condition; a timeout is a hard failure with evidence.
**Cost.** An unanticipated state fails instead of being improvised around. That is the intended behavior.

## D6. Semantic targeting, three locator kinds

**Decision.** `role_name`, `anchor` and `table_cell` only. No CSS or XPath. Exactly-one-match or fail.
**Why.** The PDF says to bias toward what works without a clean DOM. These three kinds describe what an operator sees, and they map onto a desktop accessibility tree or OCR output. Refusing ambiguous matches prevents acting on the wrong control in a financial system.
**Cost.** Anchor resolution is geometric and is the hardest code in the project. It gets the most tests.

## D7. Safety policy is deterministic and outside the model

**Decision.** Risk classification comes from profile rules and reviewed step metadata. The guarded executor is the only path to the surface. The origin allowlist is also enforced at the network layer.
**Why.** A model cannot be the control on its own actions. A click's destination is unknown when the decision is made, so the network layer is the backstop.
**Cost.** The profile's safe and commit control lists are hand-authored per app. Unknown buttons require approval in discovery, which can be chatty.

## D8. Irreversible steps: approval, no retry, unknown outcome is explicit

**Decision.** Discovery always asks a human before an irreversible step. Replay proceeds unattended only for an `approved` artifact with an explicit caller flag. Irreversible steps are never retried; an undetermined result is `outcome_unknown` and goes to a human.
**Why.** Legacy UIs have no idempotency keys. Double-posting a transaction is worse than stopping.
**Cost.** More human involvement than a naive retry loop.

## D9. Login and global conditions live in an app profile

**Decision.** A small hand-authored profile per vendor product owns the login flow, global conditions (notice, session expiry, app error, supervisor override) with their dispositions, and risk rules.
**Why.** Session expiry should not be re-recorded in every capability. Discovery only sees the happy path, so the handling of exceptional states has to come from somewhere reviewable.
**Cost.** The profile is not discovered. The report says so; in production it would be discovered once per app.

## D10. Legacy banking app as the primary target

**Decision.** A local fake back-office app, built to be hostile: frameset, nested layout tables, unlabeled inputs, no IDs, opaque postback URLs, server-side fault injection.
**Why.** The PDF lists a local app and an intentionally hostile surface as good options. It avoids terms-of-service problems, makes runtime errors reproducible, and lets every evidence scenario be regenerated.
**Cost.** A reviewer may suspect the target was built to be easy. Mitigated by committing the app before any automation code, making it hostile, and never letting it import automation code.

## D11. Two core capabilities

**Decision.** `member.lookup_balance` (read) and `member.open_subaccount` (write with a confirmation step).
**Why.** One read flow proves the core loop cheaply. The write flow exercises the irreversible gate, the handoff and unknown-outcome handling. Two flows on one engine show the schema is not shaped around a single case.
**Cost.** The first four steps are duplicated across both artifacts. Composition of capabilities is a deliberate cut.

## D12. One model provider behind a narrow interface

**Decision.** One provider interface (`decide(context) → Action`), one OpenRouter implementation for real runs, one recorded-response implementation for tests and for running without a key. The model is used in exactly two places: the discovery loop, and outcome-evidence selection in the compiler.
**Why.** OpenRouter keeps the model swappable through configuration without a multi-vendor abstraction in the code. One key keeps setup simple for reviewers. The recorded provider answers the PDF's "how to run without live services".
**Cost.** Discovery quality depends on the configured model supporting image input and tool calling.

## D13. Modern web is secondary; desktop is stretch

**Decision.** `FakeSurface` proves the surface seam in the core. A modern-web variant of CoreServ is secondary and, if built, runs as a second tenant with relabeled fields and a target-override file, so one piece of work demonstrates both surface robustness and cross-tenant reuse. Desktop is stretch.
**Why.** The PDF asks for a credible design for heterogeneity and tenants, not an implementation. A second tenant variant answers §3.7 more directly than a second surface type alone.
**Cost.** Desktop support is argued in the report, not demonstrated.

## D14. No premature scaling infrastructure

**Decision.** No queues, services, databases, containers or multi-tenant plumbing.
**Why.** PDF §7: designing abstractions that could scale is valued; building the infrastructure is not. The layering of profile, capability and tenant binding is the scaling story.
**Cost.** None within this assignment.
