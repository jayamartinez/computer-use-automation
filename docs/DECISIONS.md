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
**Update (2026-10-05).** The path rule is an allowlist (`paths`), replacing the earlier deny list (`denyPaths`). A deny list fails open for any path nobody thought of; PDF §3.4 asks for permitted routes. With opaque postback URLs the CoreServ list is short: `/` and `/cs.do`.
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

## D13. Modern web is a stretch goal; desktop is design only

**Decision.** `FakeSurface` proves the surface seam in the core. A modern-web variant of CoreServ is one of the two stretch goals (the other is approval gating; chosen 2026-10-05). If built, it runs as a second tenant with relabeled fields and a target-override file, so one piece of work demonstrates both surface robustness and cross-tenant reuse. Desktop is not built.
**Why.** The PDF asks for a credible design for heterogeneity and tenants, not an implementation. A second tenant variant answers §3.7 more directly than a second surface type alone.
**Cost.** Desktop support is argued in the report, not demonstrated.

## D14. No premature scaling infrastructure

**Decision.** No queues, services, databases, containers or multi-tenant plumbing.
**Why.** PDF §7: designing abstractions that could scale is valued; building the infrastructure is not. The layering of profile, capability and tenant binding is the scaling story.
**Cost.** None within this assignment.

## D15. Targets name a surface scope, not a frame

**Decision.** Targets, signatures, `requires`, the profile and tenant policy use `scope`: an ordered path of named containers that the surface defines. This replaced `frame` on 2026-10-05.
**Why.** The artifact is meant to be surface-independent (PDF §3.7). The value was already a generic path; only the name was web vocabulary. A desktop surface maps the same field to window then pane, and a modern web page to `[]`, with no schema change. A typed union per surface kind was rejected, because it would put surface kinds into the artifact.
**Cost.** A surface must produce stable container names. `PlaywrightSurface` uses frame names, so an unnamed iframe has no stable scope yet.

## D16. Saved evidence masks names, account numbers and balances

**Decision.** The profile's mask rules hide member names, account numbers and balances in every saved screenshot and observation dump. A rule names a visible label, the direction of its values (`below` a column header, `right_of` a form label), and optionally a `when` signature that limits it to one screen.
**Why.** PDF §3.4 forbids persisting raw sensitive data. Evidence is copied into the repository, and even synthetic data should be handled the way real data would be. Without `when`, a label rule over-reaches: masking below "Name" on the profile also hides the Accounts table under it.
**Cost.** Masks are geometric and hand-written per screen; a relabeled screen needs its rule updated. The caller always receives unmasked outputs.
**Update (2026-10-05).** Member numbers are masked too, along with deposits, the available balance, the override amount, the Supervisor ID and the operator ID. Evidence is told apart by scenario folder and run id instead, and logs keep the `***77` form. A third mask position, `self`, hides a whole text element whose label and value share it ("Operator: teller01"); otherwise the operator ID, a credential reference, would sit in every screenshot and, from discovery on, be sent to the model.

## D17. A native dialog is a container named `dialog`

**Decision.** While a browser `alert`/`confirm`/`prompt` is open, the surface reports only the dialog, in scope `["dialog"]`: its message as text, its buttons as buttons. Clicking `OK` accepts and `Cancel` dismisses. Known dialogs are profile conditions with a click handler; any other one is `unexpected_state`. The demo fault raises a password-expiry `alert()` on a chosen screen.
**Why.** PDF §3.3 names unexpected dialogs. Treating the dialog as one more container reuses targets, signatures, handlers and policy scopes with no schema change, and a desktop modal window maps onto it the same way. A `confirm()` on the Confirm button was rejected: it would split the irreversible step in two and test nothing unexpected.
**Cost.** While a dialog is open the page behind it cannot be observed (it is blocked, as it is for a person). The tenant allowlist must list the `dialog` scope.

## D18. Irreversible steps: read back, then dispatch once

**Decision.** An irreversible step must follow an `assert` step, which runs again after any transfer of control. The step is marked dispatched before the surface acts. After dispatch, anything but the expected state or a listed outcome is `outcome_unknown`; the click is never repeated and the run never restarts. The tenant `irreversible` setting planned in the design was dropped: `maxRisk` already says whether a tenant allows writes.
**Why.** Legacy apps have no idempotency key, and a confirmation that appears slowly is indistinguishable from one that never comes. Marking before acting means an exception mid-click cannot hide a commit.
**Cost.** A transient error after Confirm always needs a person, even when retrying would have been harmless.

## D19. A human "committed" verdict is still a failure

**Decision.** When a person confirms that an action committed but the confirmation screen was never checkpointed, the result is `failure` with the category that triggered the request, `sideEffects: "committed"`, `safeToRetry: false` and `outputsVerified: false`. Every failure carries `outputsVerified: false`.
**Why.** The capability's contract is outputs read from a checkpointed screen. A human verdict proves the side effect, not the outputs. The three fields together keep "definitely committed" distinguishable from "unknown" and "not committed" for the calling agent.
**Cost.** The caller must look up the new account number itself.

## D20. An escalated step is never run again after the handoff

**Decision.** On return of control, resync accepts the step's expected state, one of its outcomes or a profile condition. It never re-runs the step whose result escalated.
**Why.** Re-running Continue after a person cancelled the override would only show the override again, in a loop. The person's choice not to finish is respected, and the result says where the run stopped.
**Cost.** A person who cancels by accident has to start a new run.

## D21. Paper notes never reach the application

**Decision.** Design notes live in separate "Notes (Paper only)" artboards under each mockup. The demo app renders only what is on the screen artboards, and a test checks that no note text appears in any rendered page.
**Why.** Evidence is captured from rendered pages. Note text in the app would leak design reasoning into screenshots and give the model hints a real legacy app would never give.
**Cost.** None.
