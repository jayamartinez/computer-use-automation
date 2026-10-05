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
2. Capability catalog: `list` and `invoke` with tool schemas generated from inputs.
3. Modern-web CoreServ variant run as a second tenant with a target-override file.
4. Unknown-outcome evidence scenario.

**Stretch (separate from required work; the PDF caps stretch goals at one or two):**
- Bounded single-step LLM-assisted fallback on replay failure (opt-in, policy-checked, never open-ended).
- Approval workflow beyond the status field.
- Multi-run stability report.
- Desktop surface.

Items 2 and 3 of the secondary list are themselves stretch goals in the PDF's terms. If both are built, do nothing from the stretch list.

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
- [ ] Sub-Account Form, Review, Confirmation; insufficient-funds rule; supervisor override above $2,500; System Notice, Session Expired, Application Error; fault endpoint including `commitThen500`.

**Done when:** every screen and branch in `docs/DESIGN.md` §1–2 is reachable by hand, and each fault can be switched on and observed.

### M4. Schemas — `feat(schema): artifact, profile, tenant binding and result contract`
- [x] Zod schemas and derived types; artifact load/save with content hash; templating; the CoreServ profile and `lakeside` binding as data; a **hand-written** `lookup_balance` artifact in `tests/fixtures/`.

**Done when:** the fixture and profile validate; invalid artifacts are rejected with useful messages (unknown target reference, undeclared input in a template, irreversible step with retries, output with no source step); schema tests pass.

### M5. Surface — `feat(surface): Surface interface, PlaywrightSurface, FakeSurface`
- [ ] Observation across frames; `resolve` for `role_name`, `anchor`, `table_cell`; `act`; `matches`; masked screenshots; native dialog reporting; `FakeSurface`.

**Partly done (acd90eb).** Everything except native dialog reporting and the 300 ms latency test, which needs the `latencyMs` fault from M3.

**Done when:** integration tests against the demo app resolve every target in the lookup fixture uniquely, report `ambiguous` and `none` correctly, and resolve the same targets with 300 ms of injected latency.

**Spike before M6 (not committed):** spend about an hour giving a model the M5 observation of the search form and the profile page and asking for the next action. If it cannot pick sensible elements, fix the observation format now. Record the finding in this file.

### M6. Guarded executor — `feat(executor): policy engine, controller epoch, run log, redaction`
- [ ] Policy checks in the order given in `docs/DESIGN.md` §9; network-layer origin and path blocking; risk classification from profile rules; structured `run.jsonl`; redaction by sensitivity.

**Partly done (9766c60).** Everything except risk classification from profile rules, which only discovery uses. Replay takes risk from the reviewed `risk` field on each step.

**Done when:** tests show an action outside the allowlist is denied before reaching the surface; a request to another origin or to `/__admin/` is blocked; a stale epoch is refused; no input marked sensitive and no secret appears unmasked in any log line.

### M7. Replay, happy path — `feat(replay): interpreter for lookup_balance`
- [x] Input validation, preflight against policy, profile login, step loop, checkpoint, typed outputs, `ReplayResult`.

**Done when:** `replay coreserv.member.lookup_balance --input memberId=10077` returns `success` with the correct balance, and `memberId=10042` returns that member's balance from the same artifact. No model code is importable from `src/replay/`.

### M8. Replay, exceptional states — `feat(replay): outcomes, recoveries and failure evidence`
- [ ] State race; outcome signatures; profile conditions with dispositions and bounded recovery; failure evidence.

**Done when**, against the real app:
- 99999 returns `business_outcome: MEMBER_NOT_FOUND`; 10200 returns `PERMISSION_DENIED`.
- With `notice` on, the run succeeds and reports one recovery.
- With a short `sessionTtl`, the run re-logs in, restarts and succeeds.
- With `latencyMs` set, the run succeeds with a `slow_load` warning.
- With `error500`, the run returns `failure: app_error` with step, expected, observed and a masked screenshot.
- With a target's label changed in a test copy, the run returns `target_unresolved`, or succeeds with `locator_fallback` when a second strategy exists.

### M9. Replay, write path — `feat(replay): open_subaccount, risk gate, unknown outcome`
- [ ] Hand-written `open_subaccount` fixture; `select` and `assert` actions; irreversible gate; `outcome_unknown`.

**Done when:** the flow opens a sub-account for 10077 and returns both outputs; an over-balance deposit returns `INSUFFICIENT_FUNDS`; without approval the run stops at Confirm with an approval request (or `policy_denied` when run non-interactively); with `commitThen500` the Confirm click is not repeated and the result is `outcome_unknown` with `sideEffects: "possible"`.

### M10. Handoff — `feat(handoff): control state machine, intervention channel, human capture`
- [ ] State machine and epoch; `InterventionChannel` with the file-and-terminal implementation; headed-browser takeover; human action capture; resync; unknown-outcome verdicts.

**Done when:** a $3,000 deposit for 10077 pauses at Supervisor Override with a request containing capability, step, reason and a masked screenshot; a person enters the code in the same window and returns control; the run resumes and completes; the captured human actions are in the run log with no typed values; unit tests cover every transition, timeout, abort and a stale-epoch action using a scripted human.

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

Recorded at the first checkpoint (M1, M2, M4, M7 complete; M5 and M6 partly). None changes a locked decision in `AGENTS.md`.

1. **M3 was skipped for now.** The checkpoint needed only the read path, so the write path and fault injection were deferred. M3 must be finished before M8, which depends on the faults. It also unblocks the M5 latency test.
2. **The assignment PDF arrived after the code was written.** The pass against PDF §3, §6 and §7 was done afterwards (2026-10-05) and found no drift in what is built. Three things it sharpened for later milestones:
   - §3.3 names "an unexpected dialog" as a runtime condition replay must handle, so native dialog reporting (outstanding from M5) is required, not optional.
   - §11 requires a **public** GitHub repo at submission. The repo is private today.
   - §8 lists "gate unattended replay on an approval state (draft → approved)" as a stretch goal. The core design already has that gate for irreversible steps, and the plan also counts the catalog and the second-tenant variant as stretch. The PDF caps stretch at one or two, so decide which to keep before starting the secondary list.
3. **`table_cell` is resolved geometrically from visible text**, not from DOM table structure, and all three locator kinds are resolved by one pure function over the observation (`src/surface/resolve.ts`). Both surfaces share it. This follows `docs/DESIGN.md` §3 and makes the desktop argument concrete; the cost is that a column is found by horizontal overlap with its header text.
4. **`right_of` and `below` mean the nearest control in that direction.** A tie is ambiguous. "Exactly one or fail" still holds; nothing is narrowed by document order.
5. **Accessible names in observations are simplified** (aria-label, then `<label>`, then the element's own content). Roles come from Playwright's ARIA implementation.
6. **Step schema has `click`, `fill` and `extract` only.** `select` and `assert` are in the policy vocabulary but are added to the step union in M9, with the capability that uses them, so no untested action exists.
7. **Schema shapes that differ from the `DESIGN.md` examples:**
   - Tenant `policy` has `frames` (required by `AGENTS.md`, missing from the example) and does not yet have `irreversible`; the executor always requires an approval for an irreversible action. M9 adds the field.
   - Profile `masks` entries are `{ label, where: "below" | "right_of" }`. A bare label could not say whether the value sits under a column header or beside a form label, and guessing masked the neighbouring header.
   - Profile has no `formats`. Money is parsed as `$#,##0.00` in `src/replay/values.ts`; an uninterpreted format string would be a false promise.
   - Login values are `{{secrets.operatorId}}` and `{{secrets.password}}`, resolved from the tenant's `credentials` references.
   - `failure.evidence` is optional: a run rejected for invalid input or at preflight never had a screen.
   - `contentHash` excludes `status`, so approving an artifact does not change the hash of what was approved.
   - A money output is `{ amount: "15902.66", currency: "USD" }`.
8. **`result.json` on disk has outputs masked by sensitivity.** The caller (and the CLI's stdout) gets the real values. Evidence must hold no unmasked sensitive value, and this file is copied into `evidence/` later.
9. **Outcome signatures are in the fixture but not yet matched.** Until M8, `memberId=99999` returns `failure: unexpected_state` at `search` instead of `business_outcome: MEMBER_NOT_FOUND`.

## Known issues

- Balances are visible in failure screenshots and observation dumps. The profile masks only Account No and SSN, as designed. Decide in M8 whether `financial` values should be masked in evidence.
- The run-log scrub backstop ignores values shorter than four characters, to avoid mangling ordinary text. Primary redaction does not depend on it.
- `profile.conditions`, `profile.risk`, `profile.versionProbe` and the `version_mismatch` and `slow_load` warnings are validated data with no behaviour yet (M8, M11).
- Each observation makes about a dozen round trips per frame. Fine locally (a full replay takes about one second); revisit if the latency fault makes polling slow.

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
