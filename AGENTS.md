# AGENTS.md

Durable context for any coding agent working in this repository. Read this file, the assignment PDF, and `docs/IMPLEMENTATION_PLAN.md` before changing anything, then continue from the next incomplete milestone.

## What this is

A take-home project for interface.ai ("Assignment A — Computer-Use Automation System"). interface.ai builds AI agents for banks and credit unions. This system gives those agents hands inside legacy back-office apps that have no API:

1. An LLM drives a real UI once to accomplish a goal (**discovery**).
2. What it learned is compiled into a typed, versioned, reviewable **capability artifact**.
3. The artifact is **replayed deterministically, with no LLM**, with input parameters, typed outputs and explicit error handling. This is the production path.
4. When automation cannot safely proceed, a human takes over the same live session and hands control back.

The assignment grades judgment, not breadth: the artifact schema, locator robustness, the error taxonomy, the control-transfer model and how coherently the pieces fit.

## Source of truth

| Document | Role |
|---|---|
| Assignment PDF (`docs/assignment.pdf`, gitignored; ask the developer if missing) | Final authority. Wins over everything here. |
| `AGENTS.md` (this file) | Locked decisions and rules. |
| `docs/DESIGN.md` | Detailed spec: workflows, schemas, contracts, state machines. |
| `docs/IMPLEMENTATION_PLAN.md` | Milestones, acceptance criteria, progress. |
| `docs/DECISIONS.md` | Why each decision was made. |

**Check work against the PDF continuously.** Before finishing a milestone, re-read the PDF sections it touches (§3 requirements, §6 deliverables, §7 criteria) and confirm nothing drifted. If these documents disagree with each other or with the PDF, stop and tell the developer.

## Assignment requirements (digest of PDF §3 and §6)

- **3.1 Agent loop.** Goal + target in; LLM-driven observe → decide → act against a real UI until done or a stopping condition (max steps, timeout, dead-end). Bias toward a mechanism that works without a clean DOM.
- **3.2 Artifact.** Typed, serializable, versioned, reviewable: ordered steps, how each control is identified (with robustness reasoning), typed inputs, typed outputs, checkpoint. A contract an agent can call, not a step list.
- **3.3 Replay.** No LLM decisions. Stable targeting, checkpoint verified, outputs returned. Must distinguish **business outcomes**, **recoverable conditions** and **hard failures**, and report step / expected / observed on failure.
- **3.4 Safety.** Configurable allowlist (domains/routes, action types). Risky/irreversible actions handled conservatively. No secrets or raw sensitive data in artifacts or logs.
- **3.5 Evidence.** Structured log of what and why, plus a richer signal on failure.
- **3.6 Handoff.** Detect stuck; raise an intervention request with context; human operates the *same* live session; record what they did; resume; always know who is in control.
- **3.7 Design only.** Surface abstraction (legacy web, desktop) and multi-tenant reuse. Do not build multi-tenant or desktop infrastructure.
- **Deliverables.** `/README.md` (setup, running without live services, exact demo commands), `/REPORT.md` (1–3 pages, the seven exact headings already in the skeleton), `/evidence/` (saved artifact, logs from a real discovery run and a replay run, ideally an error replay).
- **Not negotiable.** At least one genuine LLM-driven discovery run against a live surface, with evidence.

## Locked architecture

Single-process TypeScript CLI. No services, queues, databases or containers. Artifacts and evidence are files.

```
Capability request ─► Discovery loop (LLM) ─► Trace ─► Compiler ─► Artifact ─► verification replay
Artifact + inputs  ─► Replay interpreter (no LLM) ─► ReplayResult

Discovery and Replay both act only through:
  Guarded executor (policy · control ownership · log · redaction) ─► Surface interface ─► PlaywrightSurface ─► CoreServ demo app
```

### Lifecycle

1. **Capability request**: natural-language goal, target, typed inputs with values, declared outputs, a second input set for verification, optional outcome probes.
2. **Discovery**: the model sees an observation (element list with refs + screenshot) and picks one typed action. Output is a typed **trace**.
3. **Compiler**: turns the trace into an artifact. Deterministic except outcome probing.
4. **Verification replay**: the draft is replayed with *different* inputs than discovery used. It is saved only if that succeeds.
5. Artifact starts as `draft`; a human sets `approved`.

### Hard rules

- **Replay never calls an LLM.** No model import may be reachable from `src/replay/`. Outcome and error classification on replay is signature matching, never model judgment.
- **The artifact is never built from the raw model transcript**, only from the typed trace.
- **Parameter provenance.** The model emits value references (`{"input": "memberId"}`), not retyped literals. The compiler templates them as `{{inputs.memberId}}`. A literal with no input provenance stays a constant and is flagged for review. Locator text that contains an input value must be templated or the strategy rejected.
- **Login is not part of any capability.** The app profile owns it. The model never sees credentials.
- **Semantic targeting only.** Three locator kinds: `role_name`, `anchor` (geometric relation to visible text), `table_cell` (header + row key). No CSS or XPath, not even as fallback. A strategy must resolve to exactly one element; zero or many is a failure, never "pick the first". If a fallback strategy is used, the run continues and records a `locator_fallback` warning.
- **State is recognized by content, not URL.** The demo app uses opaque postback URLs on purpose.
- **Safety is deterministic and outside the model.** Risk class comes from policy rules in the app profile (discovery) or the reviewed `risk` field on each step (replay). The model can never lower risk.
- **Every action goes through the guarded executor.** Nothing else may touch the surface.
- **Irreversible steps are never auto-retried.** If the outcome of a dispatched irreversible step cannot be determined, the result is `outcome_unknown` and a human decides.

### Surface abstraction

`Surface` exposes `observe()`, `resolve(target)` (unique | ambiguous | none), `act()`, `matches(signature)`, `screenshot()`. Implementations: `PlaywrightSurface` (primary, legacy web with framesets) and `FakeSurface` (in-memory, for tests; proves the seam). A modern-web variant is secondary scope. Desktop is stretch and should not be started.

### Policy

- Allowlist in the tenant binding: origins (also enforced at the network layer), frames, action types, maximum risk.
- Risk classes: `read`, `reversible`, `irreversible`. Profile lists safe and commit controls; an unknown button requires human approval during discovery.
- Irreversible in discovery: always human approval. In replay: proceeds unattended only if the artifact is `approved` and the caller passes an explicit allow flag; otherwise an approval request is raised.
- Artifacts declare `requires` (actions, max risk, frames) so policy can reject them before anything runs.
- Redaction: secrets never reach the model, trace, artifact or logs. Outputs are returned to the caller but logged masked by sensitivity. Sensitive regions are masked in screenshots. Human-typed values are never recorded.
- Discovery sends screen content to a model provider, so it only ever runs against synthetic data.

### Result taxonomy

`ReplayResult.status` is exactly one of `success`, `business_outcome`, `failure`. Recoveries, interventions and warnings are annotations on any status. Every observed condition has one disposition:

| Disposition | Example | Effect |
|---|---|---|
| outcome | member not found | return `business_outcome` |
| recover | system notice, session expired | bounded handler, then continue |
| escalate | supervisor override | hand off to a human |
| fail | application error, unknown state | return `failure` with step / expected / observed / evidence |

`failure` carries `sideEffects` (`none` / `possible` / `committed`) and `safeToRetry` for the calling agent. Full contract in `docs/DESIGN.md`.

### Human handoff

One `controller` field (`automation` | `human` | `none`) plus an epoch that increments on every transfer; the executor refuses actions planned under an old epoch. States: `AUTOMATION_ACTIVE → PAUSING → AWAITING_HUMAN → HUMAN_ACTIVE → RESYNC → AUTOMATION_ACTIVE` (or `FAILED`). The operator surface is deliberately minimal: a JSON intervention request, a terminal prompt and the same headed browser window. Human actions are captured (role and name, no typed values). On resume the interpreter re-observes and resynchronizes; it never assumes where it is.

### Layering

| Layer | Owns |
|---|---|
| App profile (per vendor product + version) | frames, login flow, global conditions and dispositions, risk rules, value formats, timeouts, screenshot masks |
| Capability artifact | contract (inputs, outputs, outcomes), named targets, steps, expects, checkpoint, `requires`, provenance |
| Tenant binding | base URL, credential references, policy/allowlist, deployed version |
| Tenant overrides (secondary) | patches to named targets, signatures, timeouts only; never steps or contract |

## Demo target and capabilities

**CoreServ 7.2**: a local fake legacy banking app (frameset, nested tables, unlabeled inputs, no IDs, opaque URLs, server-side fault injection). It lives in `demo-app/` and must never import from `src/`.

1. `coreserv.member.lookup_balance`: `memberId` → `savingsBalance`. Read-only.
2. `coreserv.member.open_subaccount`: `memberId`, `accountType`, `nickname`, `openingDeposit` → `newAccountNumber`, `confirmationRef`. Contains one irreversible step and the handoff scenario.

Screen-by-screen flows, seed data and fault settings are in `docs/DESIGN.md`.

## Repository layout

```
AGENTS.md  CLAUDE.md          this file; CLAUDE.md only imports it
README.md  REPORT.md          required deliverables (skeletons until M14)
docs/                         DESIGN, IMPLEMENTATION_PLAN, DECISIONS, diagrams/, assignment.pdf (gitignored)
src/
  cli/                        entry point, commands, run ids and run directories
  artifact/                   artifact schema, load/save, content hash, templating
  profile/                    app profile and tenant binding schemas and loader
  trace/                      trace schema, writer, reader
  discovery/                  capability request, agent loop, stuck detection
    llm/                      provider interface, OpenRouter and recorded providers
  compiler/                   trace → artifact, verification replay, outcome probes
  replay/                     interpreter, step loop, state race (no LLM imports)
  outcome/                    result contract, failure categories, dispositions, recovery handlers
  executor/                   guarded executor, policy engine, risk rules
  surface/                    Surface interface, target, observation and signature types
    playwright/               PlaywrightSurface
    fake/                     FakeSurface
  handoff/                    control state machine, intervention channel, human capture
  evidence/                   run log, redaction, masked screenshots
demo-app/                     CoreServ fake bank; standalone, never imports src/
profiles/coreserv/            profile.json and tenants/<tenant>.json (data, not code)
capabilities/                 compiled artifacts; requests/ holds capability requests
tests/                        unit/, integration/ (against the demo app), fixtures/ (hand-written artifacts)
scripts/                      evidence scenario runner
evidence/                     curated, committed evidence (required deliverable)
runs/                         per-run output, gitignored
```

`outcome/` is separate from `replay/` because discovery and the handoff also handle conditions and build results. `profiles/` and `capabilities/` sit outside `src/` because they are reviewable data.

## Scope

**Core:** demo app; schemas; surface + Playwright + fake; guarded executor and policy; replay with outcomes, recoveries, failures, risk gate, unknown-outcome handling; handoff; discovery; compiler with verification replay; both capabilities discovered for real; the seven evidence scenarios; README and REPORT.

**Secondary (only when core is solid, in order):** outcome probing in the compiler; capability catalog (`list` / `invoke`); modern-web CoreServ variant run as a second tenant with target overrides; unknown-outcome evidence scenario.

**Stretch (probably never):** bounded single-step LLM-assisted fallback on replay failure (opt-in, policy-checked, never open-ended); approval workflow beyond the status field; multi-run stability; desktop surface. The PDF caps stretch goals at one or two.

**Out of scope:** real bank systems or public sites, real credentials or PII, microservices, queues, databases, multi-tenant plumbing, a co-browsing operator console, multi-vendor LLM frameworks, CSS/XPath locators.

## Working rules

- **Do not add infrastructure or features for the sake of complexity.** The PDF explicitly does not reward breadth, framework name-dropping or scaling infrastructure. A small, correct, well-argued system is the goal.
- **Do not silently change a locked decision.** If implementation shows a decision is wrong, stop, explain the conflict and options, and let the developer decide. Then update `docs/DECISIONS.md` and this file.
- **Follow the milestone order** in `docs/IMPLEMENTATION_PLAN.md`. Replay is built before discovery on purpose. Do not start a milestone until the previous one meets its acceptance criteria. Tick milestones off in that file as they complete.
- **One logical commit per milestone** (a few more if a milestone is large). Never commit, push or open a PR without the developer's explicit request.
- **Evidence is real.** Never fabricate or hand-edit logs, traces or results in `/evidence/`. Discovery evidence must come from a genuine model run.
- Keep secrets out of the repo. Configuration comes from `.env` (see `.env.example`).

## Code and style

- TypeScript, `strict`, ES modules, Node 22+. No `any` at module boundaries.
- Zod schemas are the single source of truth for artifact, trace, profile, tenant binding and result; derive types from them.
- Discriminated unions for results, actions, locator strategies and dispositions; exhaustive `switch` with a `never` check.
- Small modules with one job. Dependencies point down the diagram above: `cli` → `discovery` / `compiler` / `replay` → `executor` → `surface`. `replay` must not import `discovery`.
- Minimal dependencies: Playwright, Zod, a test runner, a TS runner. Justify anything else.
- Comments explain why, not what. No dead code or speculative options.

## Testing

Test where judgment lives, not for coverage:

- Schema validation and versioning rules.
- Locator resolution (unique / ambiguous / none, anchor geometry, table cells, frames) against the demo app.
- Replay taxonomy: each disposition produces the right result, using `FakeSurface` for speed and the real app for integration.
- Policy decisions and the risk gate.
- Handoff state machine transitions and epoch fencing, with a scripted human.
- Compiler: the compiled artifact matches the hand-written fixture structurally.
- No test calls a live model. Discovery tests use a recorded-response provider.
