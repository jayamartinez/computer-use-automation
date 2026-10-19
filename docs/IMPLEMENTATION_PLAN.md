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
- [x] Policy checks in the order given in `docs/DESIGN.md` §9; network-layer origin and path blocking; risk classification from profile rules; structured `run.jsonl`; redaction by sensitivity.

**Done.** Everything except risk classification from profile rules landed in 9766c60. Replay takes risk from the reviewed `risk` field on each step. The profile risk rules were completed with discovery (M11, commit d6c30a9) via `classifyRisk` in `src/executor/risk.ts`.

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
- [x] State machine and epoch; `InterventionChannel` with the file-and-terminal implementation; headed-browser takeover; human action capture; resync; unknown-outcome verdicts.

**Done (2026-10-05), except the run with a real person.** Unit tests (`tests/unit/handoff.test.ts`) cover every transition, timeouts, aborts, approval and epoch fencing with a scripted person on `FakeSurface`. Real-app tests (`tests/integration/handoff.test.ts`) run the full criteria with a scripted person acting on the same live session outside the executor: override authorized and resumed, Cancel then return, abort, claim timeout, approval approve and deny, and the three unknown-outcome verdicts. Not yet exercised: `TerminalChannel` and the headed window with a real person at the keyboard; that is the E7 evidence run (`pnpm replay … --operator`).

Two commits: `feat(handoff): control state machine and intervention channel` and `feat(handoff): headed takeover, human action capture, resync`.

**Done when:** a $3,000 deposit for 10077 pauses at Supervisor Override with a request containing capability, step, reason and a masked screenshot; a person enters the code in the same window and returns control; the run resumes and completes; the captured human actions are in the run log with no typed values; unit tests cover every transition, timeout, abort and a stale-epoch action using a scripted human; approval and unknown-outcome verdicts (D19) produce the results in `docs/DESIGN.md` §10. Automated tests stand in for the person by acting on the same page outside the executor; the E7 evidence run needs a real person.

### M11. Discovery — `feat(discovery): capability request, LLM loop, typed trace`
- [x] Request schema; observation rendering for the model; action vocabulary with value references; `OpenRouterProvider`; `RecordedProvider`; stuck detection; trace writer.

**Done (2026-10-15).** Real run: `discover capabilities/requests/coreserv.member.lookup_balance.json` with claude-haiku-5.5 finished in 6 decisions for $0.003 (click Member Inquiry, fill with `{input: memberId}`, Search, View by table address, extract the Savings cell by table address, finish). The trace reproduces offline with `--recording`. Unit tests cover provenance, literal rejection, recorded replay, stuck detection with and without an operator, the model's own need_human, unknown-button approval, profile conditions and the step budget; an integration test runs the same on the real app and checks the trace and dumps hold no member number, balance or password.

**Done when:** a real model run completes `lookup_balance` for 10042 and writes a valid trace in which every typed value has input provenance and every acted-on element has uniqueness-tested candidates; the same run can be reproduced offline with `RecordedProvider`; a forced stuck case raises a takeover request.

### M12. Compiler — `feat(compiler): trace to artifact with verification replay`
- [x] The deterministic steps in `docs/DESIGN.md` §7; compile report; verification replay with `verifyInputs`.

**Done (2026-10-15).** `compile <trace> --request <request>` compiles the real Haiku trace into five steps and the same targets as the hand-written fixture (`member_inquiry_link`, `member_number_field`, `search_button`, `view_link` keyed by `{{inputs.memberId}}`, `savings_balance_cell`, plus the identity read-back `member_no_cell`), verifies it with 10077, and saves `capabilities/coreserv.member.lookup_balance.json`; the saved artifact replays for 10042. The integration test checks the structural match, the verify-then-save path, the replay of the saved file, and that a locator anchored on the discovery member's name fails verification and is not written.

**Done when:** compiling the M11 trace yields an artifact structurally equivalent to the hand-written fixture (same steps, same targets with at least the same strategies, same checkpoint); verification with 10077 passes; a trace whose locator depends on the discovery member's data fails verification and is not saved.

### M13. Real discovery and evidence — `feat(evidence): discovered capabilities and evidence scenarios`
- [x] Real discovery of both capabilities; compiled artifacts saved under `capabilities/`; scenario runner script; curated `evidence/`.

**Done (2026-10-16).** `open_subaccount` discovered with claude-haiku-5.5 in 13 decisions (about $0.007), compiled to 13 steps with a synthesized pre-commit assert, verified with 10077 and saved; `lookup_balance` evidence is the M11/M12 run. `pnpm evidence` regenerates E2 to E6 (12 cases, all matching). Every scenario has its files; a scan of `evidence/` found no secret and no unmasked member data. The defects the first write discovery exposed, and how the approvals and E7 were operated, are deviation item 16.

**Done when:** every scenario in the table below has its files under `evidence/`, the discovery evidence comes from genuine model runs, and nothing in `evidence/` contains a secret or an unmasked sensitive value.

### M14. Documentation — `docs: README and REPORT`
- [x] `README.md` (setup, keys, running without a key, exact demo commands); `REPORT.md` (the seven headings, 1–3 pages, exported diagrams).

**Done (2026-10-16).** The README was followed literally on a clean copy of the branch: keyless replay, recorded discovery, tests, then a live discovery, compile and replay; the one failure (`compile --out` to a missing directory) was fixed in code. A final pass against PDF §3, §6 and §7 found nothing blocking; what it found and what was left is in item 16.

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
14. **M12 choices:**
   - **Input values are templated when a locator is recorded**, not by the compiler: `templateCandidates` writes `{{inputs.x}}` into the trace, so the trace file never holds an input value and the log's scrub (which would have turned 10042 into `***42` inside a locator) has nothing to catch. The compiler still templates and rejects by value for hand-made traces, and rejects any strategy whose text carries scrubbed markers.
   - **Locator synthesis keeps one table address per element and no anchors for elements inside tables.** An address keyed on an input value wins; a key that looks like a value but is not an input (an account number) is never used. Both came from the first compiled artifact, whose fallbacks were keyed on the member's name and account number: unique on the discovery screen, wrong for every other member.
   - **A click's expected state is the next step's target being resolvable**; the last click's is the first cited evidence. A click after which the screen fingerprint did not change is flagged `weak_expect`.
   - **Checkpoint** = identity read-back (`cellEquals` with the input template) for each input the final screen shows, and `outputParsed` per output. Cited evidence is **not** part of the checkpoint: the first compiled checkpoint required a Checking cell because the model cited one as proof, and every Savings-only member then failed as `unexpected_state`. Evidence only stands in for the expected state of a final click. No identity on the final screen is flagged.
   - **Human steps in a trace are not compiled in**; they are flagged `human_step_not_compiled` and the artifact stays a draft. The design said "compiled in, flagged"; a person's click carries no tested locator, so there is nothing sound to compile.
   - **Outcomes are empty** until probing (secondary) or a reviewer adds them; the compile test shows an unknown member is a failure, not an outcome, on a freshly compiled artifact.
   - Verification of a write capability needs `--operator`: a draft never runs Confirm unattended, and verification is a replay of a draft.
   - Step ids are `<action>_<target base>`; target names are `<label slug>_<role suffix>`; retries: fills and extracts 1, clicks 0.
15. **Findings from the multi-member test round (2026-10-15, after M12):** seven synthetic edge-case members were added to the demo seed (zero, very large and one-cent balances; no Savings account; two Savings accounts; Dormant status; names that read "Search", "View" and "Balance"). Seven more Haiku discoveries (about $0.003 each) and a replay matrix over all 12 members, odd inputs, every injected fault and deliberate UI drift found:
   - **Model free text carried `***42`** (the scrubbed discovery member) into step intents. Input values in rationales and summaries are now written as `{{inputs.x}}` at the source (`templateText`, whole values only), the discovery run's own scrub list templates them too, and the CLI prints the trace as saved rather than the in-memory copy, which had echoed the member's name and balance to the terminal.
   - **The model was offered the same thing twice**: a table cell and the link inside it, a cell and its text node. Two of four runs clicked the cell, one extracted the text node, and the compiled locator depended on the choice. The observation now lists a cell that only wraps one control as the control, and a text node that fills a cell as the cell. The compiler flags `non_interactive_click` for a click that still lands on a cell. Runs six and seven compiled to structurally identical artifacts.
   - **Checkpoint overfit** (see item 14): four of nine valid members failed. After the fix all nine replay with the correct balance, twice.
   - **Replay's `unexpected_state` now says why** when the expected target is absent or ambiguous ("matches 2 elements, so it is not used"): the two-Savings member and the no-Savings member were indistinguishable before.
   - The CLI rejects an input given twice; the later value had silently won.
   - Deliberate UI drift on a modified app copy (44 experiments): fallbacks carried a renamed View link, reordered columns, nested tables and an extra header row with a `locator_fallback` warning; a second Search button, a renamed row type, unparseable money and a too-slow screen all failed cleanly; nothing picked a first match. Fixed from that round: an anchor text that appears twice beside different controls is reported `ambiguous` rather than "not found" (two duplicate labels pointing at the same control still resolve); a tenant whose `baseUrl` origin is not in its own allowlist is rejected at load instead of crashing the first navigation; an irreversible step on a draft without an operator says the artifact is a draft.
   - Reported, not changed: the content-hash error prints the hash to paste back, and `status: approved` is outside the hash, so a hand-edited artifact can be marked approved (the approval-gating stretch goal should bind approval to the hash); a request blocked by the allowlist surfaces as `unexpected_state` with `safeToRetry: true`; the policy preflight runs after the browser has opened the login page; the app profile's login signature is the nav text "Member Inquiry", so renaming that link fails at login rather than at the artifact's fallback.
   - Not changed: an unknown or restricted member is a `failure`, not a `business_outcome`, until outcome probing (secondary) adds signatures; whitespace around an input is rejected by the declared pattern rather than trimmed.

16. **M13 findings (2026-10-16).** The first discovery of a write capability exposed gaps that the read-only one could not:
   - **The compiler never produced the pre-commit `assert`** that the schema requires before an irreversible step, so no write trace could compile. Discovery now records a `readback` on the event of an approved irreversible action: every cell on that screen equal to an input value (money compared as an amount), with tested candidates. The compiler emits `assert_before_<step>` from it, comparing money `as: "money"` (the final-screen identity checkpoint does the same), and refuses a trace whose irreversible step has nothing to read back. Item 17 tightens this to every declared input.
   - **A `below` mask reached past its table**: "Account No" masked the Open Sub-Account button beneath the Accounts table, its name joined the scrub list and the trace recorded `role_name "[masked]"`. A `below` rule now covers the width of the header's own cell.
   - **Label/value screens got junk table addresses** (headers taken from a "Member Name | <name>" row, or from `{{inputs.accountType}}`) and lost the anchor beside the label. Synthesis now treats text the masks hide as data, requires a header row of three or more labels, tries headers nearest-first (as item 13 said; the code went top-down), and anchors a value `right_of` its label. The lookup artifact's locators are unchanged.
   - **A denied approval left the handoff controller in `FAILED`**, so the next approval in the same discovery crashed ("cannot move from FAILED to PAUSING"). A deny now returns control to automation; the caller decides what it means (replay still returns `aborted_by_human`). Only a timeout fails.
   - **The model was shown the operator ID** on the banner, contrary to "the model never sees credentials". Text holding a secret value is now blacked out in the model's screenshot and replaced with `[secret]` in its element list. The committed `lookup_balance` discovery (E1) predates this fix.
   - **Outcomes were added by hand** to both compiled artifacts (version 1.1.0), copying the fixtures' signatures, as §7 of the design allows until outcome probing exists. The compile reports keep the hash of the artifact as verified (1.0.0).
   - **`--tenant` accepts a binding file** as well as a name (names are now validated). The scenario runner uses it for two E6 cases: a tenant whose `maxRisk` is `reversible` (preflight `policy_denied`) and one whose paths omit `/cs.do` (network block, surfacing as `unexpected_state` per item 15).
   - **The open_subaccount discovery's Confirm approvals were answered by the developer's coding agent**, at the developer's request, through the real `--operator` terminal channel. A pre-flight run with a scripted approver, not kept as evidence, found the defects above first.
   - **E7 was run by the developer at the keyboard** (run `20261016T041219-3844c568`): claim, override entered in the same headed window, return, approval. An earlier agent-operated E7 run (`20261016T032237-2502b1fe`) proved the path first and was replaced. The developer approved the `open_subaccount` artifact (`status: approved`), so E2 runs it unattended with `--allow-irreversible`.
   - `compile --out` now creates a missing directory (the README test on a clean copy failed on it).
   - **Approvals were given by a script**, which read each prompt and approved only the Confirm step within milliseconds, so the pre-commit assert was the only check of the Review screen. The final review noticed the timing and, behind it, a real gap: `TerminalChannel` used to answer a question with a line typed before it was asked. It now discards anything typed before the question.
   - The scenario runner replaces one case folder at a time, so a skipped case keeps its committed evidence.
   - Not done from the final pass: the diagrams in `docs/diagrams/` are design-time (M0) and partly stale (`frame`, a "committed" verdict shown as success, slow load as a recovery, outcome probing); REPORT says the text wins rather than re-exporting them. No evidence run shows slow load, discovery stuck, `outcome_unknown` or an action-type denial; tests cover them. REPORT was trimmed to about three pages on 2026-10-19.
   - Not changed: replay saves no screenshot for a recovery (§11 says it does); `result.json` evidence paths point at the original `runs/` directory.
17. **External review findings (2026-10-19).** An external review found five gaps, all fixed in code. None changes a locked decision; each brings discovery or startup in line with rules replay already followed.
   - **Discovery could repeat an irreversible action after a dispatch error**: the model was told "the action failed" and could try again. Discovery now tracks an irreversible action as dispatched once its target resolves, keyed by scope, role and name; a person's click on a commit control during a takeover counts too. A dispatch error raises an `unknown_outcome` takeover when there is an operator and otherwise stops; either way the trace ends with the new end kind `outcome_unknown`, which the compiler refuses. The model choosing an already-dispatched irreversible target is refused before any approval is asked (policy rule `irreversible_once`). A recovery that needs a restart after a dispatch also ends `outcome_unknown`.
   - **Discovery never resynced after a takeover**, so the handoff stayed in `RESYNC` and the next approval threw (`RESYNC → PAUSING`). Discovery now re-reads the screen when control returns, fails if a profile condition that is not `recover` still shows, and otherwise calls `resynced` and continues.
   - **The executor checked ownership only before resolving the target.** Resolution polls for up to the step timeout, and control can change hands meanwhile. Controller and epoch are now checked again after resolution, with nothing awaited before the dispatch.
   - **The pre-commit assert checked whatever inputs the screen happened to show.** One matching value (the member) would compile, leaving the amount unchecked. The compiler now requires every request input to be read back before each irreversible step, unless the request lists it in the new optional field `readbackExempt` (validated against declared inputs); otherwise it fails naming the missing inputs. The compile report gains `readbacks: { step, checked, exempt }[]`. The committed `open_subaccount` assert already checks all four inputs; its compile report predates the field.
   - **Startup and unexpected exceptions escaped the result contract**: a browser that failed to launch, an entry URL that did not load or a thrown error left no `result.json`. They now end in `failure` with the new category `runtime_error`. `sideEffects` is `possible` if an irreversible step was already dispatched, otherwise `none`; `safeToRetry` is true only with `none`. A launch failure has `stepId: "launch"`.
   - **A second review pass found evidence capture could still lose the failure**: `fail()` awaited the screenshot, and its callers returned the promise unawaited, so a browser dying during capture escaped the catch. Capture is now best effort (an `evidence_error` log line, the failure kept without `evidence`), and the calls are awaited.
   - **Live check of the resync fix**: a real discovery of `open_subaccount` with a $3,000.00 deposit went through a supervisor-override takeover by the developer and then a Confirm approval in one run (`evidence/E7-discovery-supervisor-override/`, run `20261019T151439-296c3ee5`). The path threw before the fix.
13. **M11 choices:**
   - **The model sees the real screen; everything it may say is scrubbed afterwards.** Masked texts on each observed screen, and every output as it is extracted, are added to the run log's scrub list, so the model's own rationales and summary cannot carry a name or a balance into the trace or log. The first real run leaked both through the summary before this.
   - **Locator candidates are synthesized and uniqueness-tested at the moment of acting** (`src/discovery/locate.ts`). Only label-like text becomes a locator: a cell's name (its content) and any text that looks like a value (money, numbers, dates, account numbers) are never used as a role name, an anchor or a header. Cells and links inside tables try the table address before an anchor, because the text beside a cell is usually another cell's data. Header candidates are tested in nearest-first order; the first unique (row header, column header) pair per row key wins. This differs from the fixed `role_name, anchor, table_cell` order in `docs/DESIGN.md` §7 for cells only.
   - **Unlabeled fields get a `label=` hint** in the model's view, from the text beside them, as the spike recommended. Resolution is unchanged.
   - **An unknown button is `reversible` with `needsApproval`**, not irreversible: a reviewer decides what it really is; a person approves it before discovery clicks it. Without an operator channel the click is denied and the model is told.
   - **Stuck** is the same action on an unchanged fingerprint three times, or three answers in a row that could not be acted on; both hand over to a person when there is one. `need_human` from the model does the same.
   - **`TakeoverResult` now carries the person's actions**, so discovery can record them as `human` trace events. The approval prompt no longer says "irreversible", since discovery also asks about unclassified buttons.
   - **Output parsing moved** from `src/replay/values.ts` to `src/outcome/values.ts`: discovery needs it and `discovery` must not depend on `replay`.
12. **M10 choices:**
   - **Timeout and abort go straight to `FAILED`**, not through `RESYNC` as the diagram in `docs/DESIGN.md` §10 draws it: the run ends without reading the screen again, so there is nothing to resynchronise.
   - **A missing control explained by an escalation** (the condition was already on screen before the step acted) runs the step after control returns. Only the step whose own action led to the escalation is never re-run (D20).
   - **Human capture** is an init script in every frame plus a page binding, installed at launch. It reports only while a takeover is active, so automation's own clicks are never attributed to the person. It reports clicks and changes; a person's form submit shows up as the click on its button.
   - **`runReplay` accepts `onSurface`**, which hands the live session to an operator surface; tests use it to act as the person. A channel opens the browser headed unless the caller says otherwise.
   - **Default handoff timeouts:** 10 minutes to claim or approve, 30 minutes in control.

## Known issues

- The scrub backstop replaces digit-only inputs anywhere in a log string, so it could alter a hash or run id that happens to contain one. Low probability; primary redaction does not depend on it.
- The run-log scrub backstop ignores values shorter than four characters, to avoid mangling ordinary text. Primary redaction does not depend on it.
- `profile.versionProbe` and the `version_mismatch` warning are validated data with no behaviour yet (M8 drift signals). `profile.risk` is used by discovery through `classifyRisk` (M11).
- An expected state that already holds before the action, on the old screen, would be matched at once. Both fixtures' expected states are absent before their action (the write path's Review is recognised by its Confirm button, which no earlier screen has). A compiled artifact must keep that property, or the race needs a "screen changed" guard.
- Each observation makes about a dozen round trips per frame (scope). Fine locally (a full replay takes about one second); revisit if the latency fault makes polling slow.

## Spike findings

**2026-10-15, pre-M11, `scripts/model-spike.mts`.** Twelve vision+tool-calling models on OpenRouter were each given one decision on two real CoreServ observations (the project's element list plus a screenshot, the M11 tool vocabulary, goal, inputs and outputs): the empty Member Inquiry form, and the member profile. Expected: `fill` the Member Number field with `{input: "memberId"}`; `extract` the Savings balance cell into `savingsBalance`. Total spend $0.05.

- **23 of 24 decisions were right**, across every price tier (gpt-6-luna, claude-haiku-5.5, gemini-3.5-flash-lite, qwen3.5-flash, deepseek-v4.1-flash, glm-5.3-flash, gpt-5.4-mini, qwen3-vl-30b, grok-4.3, claude-sonnet-5.5, gpt-6-sol). gemini-3.8-flash returned nothing on the profile screen: its 381 hidden reasoning tokens used the whole 400-token budget. M11 must give reasoning models headroom or cap reasoning effort.
- **Value provenance works as designed**: every model referenced the input by name. gpt-6-luna and gpt-5.4-mini also echoed the literal alongside it, so M11's schema must make `input` and `literal` mutually exclusive rather than rely on the prompt.
- **Observation gap**: unlabeled inputs appear as `textbox value=""` with no name, because the anchor label is only computed at resolve time. The models still chose correctly from document order and the screenshot, but that is fragile. M11 should surface the resolved label (the same "cell to the left" rule the capture script uses) as the element's name.
- **Choice**: `anthropic/claude-haiku-5.5` as the default `DISCOVERY_MODEL`: correct on both, clean arguments, about $0.0004 per decision, so a full discovery run costs well under a cent. Any of the cheap tier would do; the expensive models bought nothing here.

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
| 2026-10-05 | M9 | 4c3572e, dac0b87 | `select`/`assert`, money comparison, pre-commit rule; irreversible gate, dispatch-before-act, `outcome_unknown` |
| 2026-10-05 | M5 | 63c3b42, a59e07f | Native dialogs as the `dialog` scope; known alert as a profile condition |
| 2026-10-05 | M10 | f95d571 and the commit after it | State machine, intervention channel, human capture, resync, verdicts; real-person run outstanding (E7) |
| 2026-10-15 | — | 241040a | Human-action capture was silently dead under `tsx` (esbuild `keepNames` injects `__name` into the in-page script; vitest does not). Fixed by sending the script as wrapped source. Found during E7: operator mode exercised end to end with OS-level mouse and keyboard input (not Playwright); takeover, resync, approval and captured actions all verified. A run by the developer is still preferable for the committed evidence. |
| 2026-10-15 | M11 | d6c30a9 | Discovery loop, request, trace, providers, locator synthesis; real run finished and reproduced offline |
| 2026-10-15 | M12 | cdc254d | Compiler, verification replay, `compile` command; real trace compiled, verified with 10077, saved and replayed |
| 2026-10-16 | M13 | 9e24404, 105a416 | `open_subaccount` discovered, compiled and approved; pre-commit assert synthesis, locator and masking fixes; scenario runner; E1–E7 evidence |
| 2026-10-16 | M14 | 64b159f | README tested on a clean copy; REPORT; final pass against PDF §3, §6, §7 |
| 2026-10-19 | — | 9e24404 | External review fixes (Deviations item 17): discovery irreversible-once and `outcome_unknown`, discovery resync, executor ownership re-check, complete pre-commit read-back with `readbackExempt`, `runtime_error`; REPORT trimmed |
