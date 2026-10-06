# Implementation plan

Work the milestones in order. Do not start one until the previous one meets its acceptance criteria. Tick the box and add the commit hash when a milestone is done. Rules and rationale are in `AGENTS.md` and `docs/DECISIONS.md`; detailed design is in `docs/DESIGN.md`.

## Locked scope

**Core (must ship):**
- CoreServ legacy demo app with seed data and fault settings.
- Zod schemas: artifact, app profile, tenant binding, trace, capability request, result contract.
- `Surface` interface, `PlaywrightSurface` with three locator kinds, `FakeSurface`.
- Guarded executor: policy, network allowlist, controller epoch, redaction, structured log.
- Replay interpreter: outcomes, recoveries, hard failures with evidence, risk gate, unknown-outcome handling.
- Handoff: state machine, file-and-terminal intervention channel, human action capture, resync.
- Discovery loop on one OpenRouter model, typed trace, recorded-response provider.
- Compiler with verification replay.
- Both capabilities discovered for real; the seven evidence scenarios.
- `README.md`, `REPORT.md`, tests where judgment lives.

**Secondary (only when core is complete, in this order):**
1. Outcome probing in the compiler.
2. Unknown-outcome evidence scenario.

**Stretch: exactly these two (PDF §8 caps stretch goals at one or two; chosen by the developer on 2026-10-05):**
1. **Approval gating** (PDF "Confidence & approval", gating part only): unattended replay runs only an `approved` artifact; a `draft` needs an explicit caller override and says so in the result. Confidence scoring is not included.
2. **Second-tenant variant** (PDF "Canonicalization / cross-tenant reuse"): a modern-web CoreServ variant run as a second tenant with a target-override file. One artifact, two tenants. Its screens need Paper mockups approved first.

**Dropped:** capability catalog (`list` / `invoke`), LLM-assisted fallback on replay failure, multi-run stability report, code generation, desktop surface. The report lists them as cuts.

## Architecture summary

```
Capability request ─► Discovery loop (LLM) ─► Trace ─► Compiler ─► Artifact ─► verification replay
Artifact + inputs  ─► Replay interpreter (no LLM) ─► ReplayResult

Both loops ─► Guarded executor (policy · controller epoch · log · redaction)
                    │                         ▲
                    ▼                         │
             Surface interface         Handoff controller ◄─► operator (terminal + same browser window)
              │            │
   PlaywrightSurface   FakeSurface
              │
        CoreServ demo app
```

Data read by several components: app profile, tenant binding.

## Milestones

### M0. Design and handoff documents
- [x] `AGENTS.md`, `docs/DESIGN.md`, `docs/DECISIONS.md`, this plan, repo skeleton, Paper diagrams.

### M1. Scaffold — `chore: scaffold TypeScript project`
- [x] `package.json`, strict `tsconfig`, test runner, lint/format, Playwright with Chromium, pnpm scripts (`app`, `test`, `lint`, `typecheck`).

**Done when:** a clean clone installs, and `typecheck`, `lint` and an empty test run pass on macOS.

### M2. Demo app, read path — `feat(app): CoreServ shell, inquiry and member profile`
- [x] Login, frameset shell, Main Menu, Member Inquiry, Results, Member Profile; seed data; reset endpoint.

**Done when:** a person can log in and look up 10042 and 10077 by hand; 99999 shows "No members match"; 10200 shows "Access restricted"; the markup has no IDs, labels or test IDs; URLs do not reveal state; `demo-app/` imports nothing from `src/`.

### M3. Demo app, write path and faults — `feat(app): sub-account flow, supervisor override, fault injection`
- [x] Sub-Account Form, Review, Confirmation; insufficient-funds rule; supervisor override above $2,500; System Notice, Session Expired, Application Error; fault endpoint including `commitThen500` and `dialog`.

**Done (2026-10-05).** The interruption screens and their faults came first (3554a52). The rest is built from the mockups approved on 2026-10-05 (artboards 10 to 16) in one commit rather than the three proposed: the override is a branch inside Continue and both new faults hook into the same request handler, so the split commits would have recorded states that never existed. The supervisor code comes from `CORESERV_SUPERVISOR_CODE`.

**Done when:** every screen and branch in `docs/DESIGN.md` §1–2 is reachable by hand, each fault can be switched on and observed, and no text from the Paper notes artboards appears in any rendered page.

### M4. Schemas — `feat(schema): artifact, profile, tenant binding and result contract`
- [x] Zod schemas and derived types; artifact load/save with content hash; templating; the CoreServ profile and `lakeside` binding as data; a **hand-written** `lookup_balance` artifact in `tests/fixtures/`.

**Done when:** the fixture and profile validate; invalid artifacts are rejected with useful messages (unknown target reference, undeclared input in a template, irreversible step with retries, output with no source step); schema tests pass.

### M5. Surface — `feat(surface): Surface interface, PlaywrightSurface, FakeSurface`
- [x] Observation across frames; `resolve` for `role_name`, `anchor`, `table_cell`; `act`; `matches`; masked screenshots; native dialog reporting; `FakeSurface`.

**Done (2026-10-05).** acd90eb, then native dialogs (D17) after M9. An open dialog blocks every frame (evaluation and screenshots hang until it is answered), so the surface races its frame reads against a dialog opening and reports only the dialog while one is open. Evidence for a failure under a dialog has the observation dump but no screenshot (`evidence.screenshot` is optional for this reason). `tests/integration/dialog.test.ts` covers the surface, the known alert on both capabilities and an unknown dialog.

**Before:** everything except native dialog reporting. The 300 ms latency criterion is now covered by the M8 replay test under the `latencyMs` fault. Dialogs are required by PDF §3.3 ("an unexpected dialog"): with no listener, Playwright silently dismisses them. They need a demo-app screen with a dialog, so they come after M3 and M9 (D17): `feat(surface): native dialogs as a dialog scope`, then `feat(replay): known dialogs as profile conditions`. Dialog handling is done when the `dialog` fault on the profile is recovered by `password_expiry_alert` during a real-app replay, and an unknown dialog fails as `unexpected_state` without being accepted.

**Done when:** integration tests against the demo app resolve every target in the lookup fixture uniquely, report `ambiguous` and `none` correctly, and resolve the same targets with 300 ms of injected latency.

**Spike before M6 (not committed):** spend about an hour giving a model the M5 observation of the search form and the profile page and asking for the next action. If it cannot pick sensible elements, fix the observation format now. Record the finding in this file.

### M6. Guarded executor — `feat(executor): policy engine, controller epoch, run log, redaction`
- [ ] Policy checks in the order given in `docs/DESIGN.md` §9; network-layer origin and path blocking; risk classification from profile rules; structured `run.jsonl`; redaction by sensitivity.

**Partly done (9766c60).** Everything except risk classification from profile rules, which only discovery uses. Replay takes risk from the reviewed `risk` field on each step.

**Done when:** tests show an action outside the allowlist is denied before reaching the surface; a request to another origin, to an unlisted path or to `/__admin/` is blocked; a stale epoch is refused; no input marked sensitive and no secret appears unmasked in any log line.

### M7. Replay, happy path — `feat(replay): interpreter for lookup_balance`
- [x] Input validation, preflight against policy, profile login, step loop, checkpoint, typed outputs, `ReplayResult`.

**Done when:** `replay coreserv.member.lookup_balance --input memberId=10077` returns `success` with the correct balance, and `memberId=10042` returns that member's balance from the same artifact. No model code is importable from `src/replay/`.

### M8. Replay, exceptional states — `feat(replay): outcomes, recoveries and failure evidence`
- [x] State race; outcome signatures; profile conditions with dispositions and bounded recovery; failure evidence.

**Done (2026-10-05).** Every criterion below passes against the real app (`tests/integration/replay.test.ts`), and every condition is also covered on `FakeSurface`.

**Done when**, against the real app:
- 99999 returns `business_outcome: MEMBER_NOT_FOUND`; 10200 returns `PERMISSION_DENIED`.
- With `notice` on, the run succeeds and reports one recovery.
- With `expireSession` armed (replacing the planned `sessionTtl`), the run re-logs in, restarts and succeeds.
- With `latencyMs` set, the run succeeds with a `slow_load` warning.
- With `error500`, the run returns `failure: app_error` with step, expected, observed and a masked screenshot.
- With a target's label changed in a test copy, the run returns `target_unresolved`, or succeeds with `locator_fallback` when a second strategy exists.

### M9. Replay, write path — `feat(replay): open_subaccount, risk gate, unknown outcome`
- [x] Hand-written `open_subaccount` fixture; `select` and `assert` actions; irreversible gate; `outcome_unknown`.

**Done (2026-10-05).** Every criterion below passes against the real app (`tests/integration/write-path.test.ts`). The `commitThen500` test also reads the member's Savings afterwards with `lookup_balance`, proving the app committed although the run could not see it. Session expiry on Confirm is `outcome_unknown` without a restart.

Two commits: `feat(schema): select and assert steps, typed comparison, pre-commit rule` and `feat(replay): open_subaccount, risk gate, unknown outcome`.

**Done when:** the flow opens a sub-account for 10077 and returns both outputs; an over-balance deposit returns `INSUFFICIENT_FUNDS`; without approval the run stops at Confirm with `policy_denied` when run non-interactively (the approval request arrives with M10's channel); with `commitThen500` the Confirm click is not repeated and the result is `outcome_unknown` with `sideEffects: "possible"`; a Review that does not match the inputs stops before Confirm.

### M10. Handoff — `feat(handoff): control state machine, intervention channel, human capture`
- [ ] State machine and epoch; `InterventionChannel` with the file-and-terminal implementation; headed-browser takeover; human action capture; resync; unknown-outcome verdicts.

Two commits: `feat(handoff): control state machine and intervention channel` and `feat(handoff): headed takeover, human action capture, resync`.

**Done when:** a $3,000 deposit for 10077 pauses at Supervisor Override with a request containing capability, step, reason and a masked screenshot; a person enters the code in the same window and returns control; the run resumes and completes; the captured human actions are in the run log with no typed values; unit tests cover every transition, timeout, abort and a stale-epoch action using a scripted human; approval and unknown-outcome verdicts (D19) produce the results in `docs/DESIGN.md` §10. Automated tests stand in for the person by acting on the same page outside the executor; the E7 evidence run needs a real person.

### M11. Discovery — `feat(discovery): capability request, LLM loop, typed trace`
- [ ] Request schema; observation rendering for the model; action vocabulary with value references; `OpenRouterProvider`; `RecordedProvider`; stuck detection; trace writer.

**Done when:** a real model run completes `lookup_balance` for 10042 and writes a valid trace in which every typed value has input provenance and every acted-on element has uniqueness-tested candidates; the same run can be reproduced offline with `RecordedProvider`; a forced stuck case raises a takeover request.

### M12. Compiler — `feat(compiler): trace to artifact with verification replay`
- [ ] The deterministic steps in `docs/DESIGN.md` §7; compile report; verification replay with `verifyInputs`.

**Done when:** compiling the M11 trace yields an artifact structurally equivalent to the hand-written fixture (same steps, same targets with at least the same strategies, same checkpoint); verification with 10077 passes; a trace whose locator depends on the discovery member's data fails verification and is not saved.

### M13. Real discovery and evidence — `feat(evidence): discovered capabilities and evidence scenarios`
- [ ] Real discovery of both capabilities; compiled artifacts saved under `capabilities/`; scenario runner script; curated `evidence/`.

**Done when:** every scenario in the table below has its files under `evidence/`, the discovery evidence comes from genuine model runs, and nothing in `evidence/` contains a secret or an unmasked sensitive value.

### M14. Documentation — `docs: README and REPORT`
- [ ] `README.md` (setup, keys, running without a key, exact demo commands); `REPORT.md` (the seven headings, 1–3 pages, exported diagrams).

**Done when:** a fresh clone can follow the README to run a replay without any key and a discovery with one; `REPORT.md` states every cut and every mocked seam; a final pass against PDF §3, §6 and §7 finds nothing missing.

### Secondary and stretch
One commit each, only after M14, in the order listed under Locked scope.

## Required evidence scenarios

| # | Scenario | How it is produced | Proves |
|---|---|---|---|
| E1 | Discovery succeeds | Real model run of `lookup_balance` (10042) and `open_subaccount`; trace, log, screenshots, compiled artifacts | PDF §3.1, §3.2, the non-negotiable real run |
| E2 | Replay succeeds | `lookup_balance` with 10077; `open_subaccount` with approval | §3.3, parameterization, typed outputs |
| E3 | Business outcome | 99999 → `MEMBER_NOT_FOUND`; 10200 → `PERMISSION_DENIED`; over-balance deposit → `INSUFFICIENT_FUNDS` | Outcome is not a failure |
| E4 | Recoverable condition | System Notice dismissed; session expired, re-login, restart | Bounded recovery |
| E5 | Hard failure | Injected Application Error; result with step, expected, observed, screenshot | Debuggable failure, richer signal |
| E6 | Safety block | Off-allowlist request blocked; Confirm refused without approval | §3.4 |
| E7 | Human handoff | Supervisor override: request, takeover in the same window, captured actions, resume | §3.6 |

Layout:

```
evidence/
  artifacts/                    the two compiled capability artifacts
  E1-discovery-lookup_balance/  trace.json, run.jsonl, screenshots/
  E1-discovery-open_subaccount/
  E2-replay-success/            result.json, run.jsonl
  E3-business-outcome/
  E4-recoverable/
  E5-hard-failure/              result.json, run.jsonl, screenshots/, observations/
  E6-safety-block/
  E7-human-handoff/             result.json, run.jsonl, interventions/
  README.md                     one line per scenario and the command that produced it
```

E7 needs a person at the keyboard; a short screen recording is welcome. Everything except E1 and E7 is regenerated by the scenario runner.

## Deviations from the plan

Items 1 to 8 were recorded at the first checkpoint (M1, M2, M4, M7 complete; M5 and M6 partly). Items 9 and 10 were added with M8. None changes a locked decision in `AGENTS.md`.

1. **M3 was skipped for now.** The checkpoint needed only the read path, so the write path and fault injection were deferred. M3 must be finished before M8, which depends on the faults. It also unblocks the M5 latency test.
2. **The assignment PDF arrived after the code was written.** The pass against PDF §3, §6 and §7 was done afterwards (2026-10-05) and found no drift in what is built. Three things it sharpened for later milestones:
   - §3.3 names "an unexpected dialog" as a runtime condition replay must handle, so native dialog reporting (outstanding from M5) is required, not optional.
   - §11 requires a **public** GitHub repo at submission. The repo is private today.
   - §8 caps stretch goals at one or two. The developer chose approval gating and the second-tenant variant; everything else in §8 is a cut (see Locked scope).
3. **`table_cell` is resolved geometrically from visible text**, not from DOM table structure, and all three locator kinds are resolved by one pure function over the observation (`src/surface/resolve.ts`). Both surfaces share it. This follows `docs/DESIGN.md` §3 and makes the desktop argument concrete; the cost is that a column is found by horizontal overlap with its header text.
4. **`right_of` and `below` mean the nearest control in that direction.** A tie is ambiguous. "Exactly one or fail" still holds; nothing is narrowed by document order.
5. **Accessible names in observations are simplified** (aria-label, then `<label>`, then the element's own content). Roles come from Playwright's ARIA implementation.
6. **Step schema has `click`, `fill` and `extract` only.** `select` and `assert` are in the policy vocabulary but are added to the step union in M9, with the capability that uses them, so no untested action exists.
7. **Schema shapes that differ from the `DESIGN.md` examples:**
   - Tenant `policy` has `scopes` (then `frames`; required by `AGENTS.md`, missing from the example) and does not yet have `irreversible`; the executor always requires an approval for an irreversible action. M9 adds the field.
   - Profile `masks` entries are `{ label, where: "below" | "right_of" }`. A bare label could not say whether the value sits under a column header or beside a form label, and guessing masked the neighbouring header.
   - Profile has no `formats`. Money is parsed as `$#,##0.00` in `src/replay/values.ts`; an uninterpreted format string would be a false promise.
   - Login values are `{{secrets.operatorId}}` and `{{secrets.password}}`, resolved from the tenant's `credentials` references.
   - `failure.evidence` is optional: a run rejected for invalid input or at preflight never had a screen.
   - `contentHash` excludes `status`, so approving an artifact does not change the hash of what was approved.
   - A money output is `{ amount: "15902.66", currency: "USD" }`.
8. **`result.json` on disk has outputs masked by sensitivity.** The caller (and the CLI's stdout) gets the real values. Evidence must hold no unmasked sensitive value, and this file is copied into `evidence/` later.
9. **M8 was done before M3 was finished**, at the developer's request. The parts of M3 that M8 needs were built first: three interruption screens from approved mockups, and their faults.
10. **M8 design choices:**
   - **State race order:** profile conditions, then the step's outcomes, then its expected state, all checked against one observation. `Surface` gained `firstMatch(signatures)` for this; separate `matches` calls would compare different moments of the screen.
   - **Profile conditions are a union by disposition.** `session_expired` recovers by clicking "Sign in again" and then `restart_if_no_side_effects`, which signs in through the profile and starts from step 1. The design's `handler: "login"` could not work: after expiry the nav frame still shows "Member Inquiry", so the authenticated check passes and login is skipped. `maxAttempts` defaults to 2. The profile gained `timeouts.slowLoadMs` (3000).
   - **`escalate` without an operator channel returns `failure: escalation_timeout`** (no operator answered within the time allowed, which is zero here). M10 routes it to the intervention channel instead.
   - **A `fail` condition returns `app_error`.** When a target cannot be resolved, replay first checks the profile conditions, so an error page reads as `app_error`, not drift.
   - **`safeToRetry` means retrying cannot duplicate a side effect *and* might succeed.** It is false for `invalid_input`, `policy_denied`, `target_unresolved`, `target_ambiguous` and `extraction_invalid`. The table is in `src/outcome/result.ts`.
   - **`observed` on `unexpected_state` lists the states that were checked**, never screen content.
   - After a handler click, replay waits up to `slowLoadMs` for the condition to clear before waiting for the step's state again. Otherwise the old notice, still on screen while the next page loads, is matched again. A condition that is still there is counted as a repeat. The real-app notice test found this; the fake surface changes state instantly.
   - **Faults are armed on a screen and fire once** (`{"notice": "search"}`), instead of the planned time-based `sessionTtl`. Every scenario then reproduces exactly.
   - A step's `retry` budget applies only to failures from the step itself (unresolved, ambiguous, unexpected state, extraction). A disposition's decision is final.
11. **Write-path design approved (2026-10-05)**, recorded as D16 (update) to D21: dialogs as a `dialog` scope; `assert` before every irreversible step; marking dispatch before acting; no tenant `irreversible` field; the "committed" verdict as a failure with `outputsVerified: false`; no re-run of an escalated step; member numbers and the operator ID masked; Paper notes kept out of the app. Work continues on `feat/write-path-handoff`, branched from the M8 head, in this order: M3, masking, M9, dialog handling, M10.

## Known issues

- The scrub backstop replaces digit-only inputs anywhere in a log string, so it could alter a hash or run id that happens to contain one. Low probability; primary redaction does not depend on it.
- The run-log scrub backstop ignores values shorter than four characters, to avoid mangling ordinary text. Primary redaction does not depend on it.
- `profile.risk`, `profile.versionProbe` and the `version_mismatch` warning are validated data with no behaviour yet (M11, M8 drift signals).
- An expected state that already holds before the action, on the old screen, would be matched at once. Both fixtures' expected states are absent before their action (the write path's Review is recognised by its Confirm button, which no earlier screen has). A compiled artifact must keep that property, or the race needs a "screen changed" guard.
- Each observation makes about a dozen round trips per frame (scope). Fine locally (a full replay takes about one second); revisit if the latency fault makes polling slow.

## Spike findings

(Record the result of the pre-M6 model spike here.)

## Progress log

| Date | Milestone | Commit | Notes |
|---|---|---|---|
| 2026-10-05 | M0 | ca7133a | Design documents, diagrams and skeleton |
| 2026-10-05 | M1 | 81aeeb9 | Scaffold: pnpm, tsx, Vitest, ESLint, Prettier, Playwright Chromium |
| 2026-10-05 | M2 | e755b24 | CoreServ read path |
| 2026-10-05 | M4 | 85e87e4 | Schemas, profile and binding data, hand-written `lookup_balance` fixture |
| 2026-10-05 | M5 (partial) | acd90eb | Surface, PlaywrightSurface, FakeSurface; dialogs and latency test outstanding |
| 2026-10-05 | M6 (partial) | 9766c60 | Executor, policy, epoch, run log, redaction; profile risk rules outstanding |
| 2026-10-05 | M7 | 9aa6396 | Replay happy path; 10077 and 10042 from one artifact. M3 deferred, see Deviations |
| 2026-10-05 | M8 | ae8065d, 466d2e7, 3554a52 | Outcomes, recoveries, failure evidence; real-app scenarios after the three interruption screens |
| 2026-10-05 | M3 (partial) | 3554a52 | System Notice, Session Expired, Application Error; notice, expireSession, error500 and latencyMs faults |
| 2026-10-05 | — | 6adc113, 9a24d74, f4f95e0 | `frame` renamed to `scope` (D15); path allowlist; names and balances masked in evidence (D16) |
| 2026-10-05 | — | d98f498 | Write-path, dialog and handoff design approved (D16 update, D17–D21); branch `feat/write-path-handoff` |
| 2026-10-05 | M3 | 9c62ca4 | Sub-account flow, supervisor override, `commitThen500` and `dialog` faults |
| 2026-10-05 | — | 46ac5c4 | Member numbers, amounts and the operator id masked in evidence (D16 update) |
| 2026-10-05 | M9 | 4c3572e and the replay commit after it | `select`/`assert`, money comparison, pre-commit rule; irreversible gate, dispatch-before-act, `outcome_unknown` |
