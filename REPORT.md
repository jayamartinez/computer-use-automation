# Report

## 1. Architecture

A single-process TypeScript CLI; artifacts and evidence are files ([diagram](docs/diagrams/01-system-architecture.png)). Discovery (LLM) writes a typed trace, a compiler turns it into an artifact, replay (no LLM) runs it; both act only through a guarded executor over a `Surface`. One process keeps session, control owner and log together; replay blocks while it waits for a person. The diagrams predate implementation; where they differ, this text and the code are current.

- **Discovery takes a capability request**: goal, typed inputs with values, declared outputs, verification inputs. The caller defines the contract; the model finds the way, referencing inputs (`{"input": "memberId"}`) instead of retyping them.
- **The artifact is compiled from the typed trace, never the transcript**: value provenance, locator candidates tested live for uniqueness, risk decisions. A draft is saved only if a **verification replay with different inputs** succeeds.
- **Target: CoreServ 7.2, a local fake core bank, hostile on purpose**: frameset, layout tables, unlabeled inputs, no IDs, opaque URLs, fault injection.
- **Perception: Playwright, read as a person would**: per frame, elements (role, name, text, bounds, scope) plus a screenshot. Coordinates do not replay; legacy markup has no stable CSS or XPath.
- **Model: `claude-haiku-5.5` through OpenRouter**, behind a one-method interface. A twelve-model test found the cheap tier as accurate as the expensive one; a discovery costs under one cent. A recorded provider covers tests and keyless runs.

Evidence: `evidence/E1-discovery-lookup_balance`, `evidence/E1-discovery-open_subaccount`, `evidence/artifacts`.

## 2. Artifact schema

Trimmed from the discovered `capabilities/coreserv.member.lookup_balance.json` ([anatomy](docs/diagrams/04-artifact-anatomy.png)):

```jsonc
{ "id": "coreserv.member.lookup_balance", "version": "1.1.0", "status": "draft",
  "contentHash": "sha256:45a8…",   // excludes status
  "inputs":  { "memberId": { "type": "string", "pattern": "^\\d{5}$", "sensitivity": "identifier" } },
  "outputs": { "savingsBalance": { "type": "money", "sensitivity": "financial", "fromStep": "extract_savings_balance" } },
  "targets": { "view_link": { "scope": ["workarea"], "role": "link",
      "strategies": [ { "kind": "role_name", "name": "View" },
                      { "kind": "table_cell", "headers": ["Member No", "Action"], "column": "Action",
                        "row": { "column": "Member No", "equals": "{{inputs.memberId}}" } } ] } },
  "steps": [ { "id": "click_view", "action": "click", "target": "view_link", "risk": "read",
               "expect": { "resolvable": "savings_balance_cell" }, "retry": { "max": 0 } } ],
  "outcomes": [ { "code": "PERMISSION_DENIED", "afterSteps": ["click_view"],
                  "signature": { "scope": ["workarea"], "textPresent": "Access restricted" } } ],
  "checkpoint": { "all": [ { "cellEquals": { "target": "member_no_cell", "value": "{{inputs.memberId}}" } },
                           { "outputParsed": "savingsBalance" } ] },
  "requires": { "actions": ["click", "fill", "extract"], "maxRisk": "reversible", "scopes": ["nav", "workarea"] } }
```

- **A caller sees what it supplies and gets back** without reading steps: typed inputs with sensitivity, outputs bound to a step, named outcomes, and `requires`, which policy checks before anything runs.
- **Every acting step states the screen it expects next**, with a reviewed `risk`. The checkpoint is identity read-back plus parsed outputs.
- **Loading rejects** unknown targets, templates naming undeclared inputs (so no secret fits), unbound outputs, an understated `requires`, and an irreversible step that is retryable or not right after an `assert`.
- **Reviewable**: semver, content hash, `draft`/`approved`, provenance, a rationale per target, a compile report of flags.

**Locators.** Three semantic kinds: `role_name`, `anchor` (`right_of`, `below` or `same_row` of visible text) and `table_cell` (header, row key, column). No CSS or XPath, even as fallback. A strategy must match **exactly one** element, never "the first"; a fallback succeeding adds a `locator_fallback` warning. Only label-like text becomes a handle, never a value, and table rows are keyed by a templated input where possible.

## 3. Determinism & error handling

**No model on the replay path**; a lint rule forbids `src/replay/` from importing discovery or compiler code. States are matched by content signatures, never URLs.

**The state race** ([diagram](docs/diagrams/05-result-taxonomy.png)). After each action, replay waits for the first match among profile conditions, the step's outcomes and its expected state, in that order, against **one** observation. Past `slowLoadMs` adds a warning; no match by the timeout is `unexpected_state`. An unresolvable target checks conditions first, so an error page reads as `app_error`, not drift.

`status` is exactly `success | business_outcome | failure`; recoveries, interventions and warnings annotate any of them.

| Disposition | CoreServ examples | Effect |
|---|---|---|
| outcome | `MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, `INSUFFICIENT_FUNDS` | `business_outcome` |
| recover | System Notice, session expired, password-expiry dialog | bounded handler, then continue, or sign in and restart |
| escalate | Supervisor Override | takeover request |
| fail | Application Error; nothing known matched | `failure` |

A failure carries `stepId`, `intent`, `expected`, `observed` (states checked, never screen content), `sideEffects` (`none | possible | committed`), `safeToRetry`, `outputsVerified: false` and masked evidence. A browser that will not start, an unreachable entry URL or a thrown exception is `runtime_error`, still inside the contract.

**Irreversible actions, in replay and discovery alike**, are marked dispatched *before* the surface acts, so an exception mid-click cannot hide a commit, and are never repeated or restarted. After dispatch, anything but the expected state or a listed outcome is `outcome_unknown` in replay; in discovery a dispatch error asks a person and ends the trace as `outcome_unknown`, which never compiles, and a second try at the same commit is refused. Before the step, an `assert` reads back what will be committed, again if control changed hands. The compiler requires it to check every input, unless the request exempts one the screen does not show.

Evidence: `evidence/E2-replay-success`, `evidence/E3-business-outcome`, `evidence/E4-recoverable`, `evidence/E5-hard-failure`.

## 4. Heterogeneity & multi-tenant

**The seam** ([diagram](docs/diagrams/09-surfaces-and-layering.png)) is the `Surface` interface (`observe`, `resolve`, `act`, `matches`, `screenshot`, `watchHuman`). One pure function resolves locators over any surface's observation; an in-memory `FakeSurface` runs the replay and handoff tests.

- **Scopes, not frames**: a target names a path of containers the surface defines (frame names here, `[]` for a single-document page).
- **A native dialog is the scope `["dialog"]`** with its text and buttons, so targets, handlers and policy apply unchanged. Unknown dialogs are `unexpected_state`, never auto-accepted.
- **Desktop** would map scope to window then pane and build the same observation from the accessibility tree or OCR. Locators are geometric, so artifacts would not change.

**Multi-tenant reuse is layering.** The app profile (per vendor product and version) owns login, global conditions, risk rules and masks; the artifact owns contract, targets and steps; a tenant binding owns base URL, credentials and allowlist. Overrides patch named targets, signatures and timeouts, never steps, so a relabeled field is an override, not a re-recording. Drift shows as `locator_fallback` warnings and checkpoint failures per tenant. Only the profile and one binding exist.

## 5. Escalation & handoff

**Ownership** ([diagram](docs/diagrams/07-human-handoff.png)): one `controller` (`automation | human | none`) plus an epoch incremented on every transfer. The executor checks both before resolving a target and again just before dispatch, so an action planned under an older epoch never runs. States: `AUTOMATION_ACTIVE → PAUSING → AWAITING_HUMAN → HUMAN_ACTIVE → RESYNC → AUTOMATION_ACTIVE` (or `FAILED`).

**Stuck** in discovery is the same action on an unchanged screen three times, three unusable answers, or the model's `need_human`; budgets end a merely slow run. Replay escalates on an `escalate` condition, an unapproved irreversible step or an unknown outcome. The request carries capability, step, reason, redacted inputs and a masked screenshot.

- **Approval**: approve or deny. Control never passes to the person, but the epoch changes, so the pre-commit assert reruns.
- **Takeover**: the person claims, works in **the same headed browser window**, then returns. Clicks and changes are recorded by role, name and scope, never typed values.
- **Unknown outcome**: the person answers committed, not committed or can't tell. "Committed" is still a `failure` (`sideEffects: "committed"`): it proves the side effect, not the outputs.

**Handing back**: replay re-reads the screen and must match a condition, an outcome or the expected state, else `unexpected_state`; discovery fails if an `escalate` or `fail` condition still shows. The escalated step **never runs again**: rerunning Continue after a cancelled override would only loop.

The operator surface is a JSON request, a terminal prompt and the same window; production would use a queue or ticket and a streamed session. Evidence: `evidence/E7-human-handoff`.

## 6. Safety

Guardrails are deterministic and outside the model ([diagram](docs/diagrams/06-safety-and-policy-gate.png)).

- **Network allowlist**: a request whose origin and exact path are not both listed is blocked, fail-closed.
- **Action policy**: the guarded executor, the only path to the surface, checks ownership, action type, scope and risk against `maxRisk`.
- **Risk** comes from profile rules in discovery (commit controls are irreversible; unknown buttons need approval) and the reviewed step `risk` in replay. The model can never lower it.
- **Irreversible gate**: discovery always asks a person. Replay runs one unattended only for an `approved` artifact *and* an explicit `--allow-irreversible`; otherwise it asks, or fails `policy_denied`.
- **Redaction**: credentials are environment references used only by login, never seen by the model, trace, artifact or logs. Logs mask values by sensitivity (`***77`, `[financial]`); screenshots mask names, member and account numbers, amounts and the operator ID.
- **Limit**: the model sees the real screen, minus credentials, so discovery runs only on synthetic data.

Evidence: `evidence/E6-safety-block`.

## 7. Cuts

- **Outcome probing is not built**, so a fresh artifact has no outcomes and an unknown member is a `failure`. The committed outcomes were **added by hand** (`MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, and `INSUFFICIENT_FUNDS` for `open_subaccount`).
- **The app profile is hand-written**; `versionProbe` has no behaviour yet.
- **Desktop and multi-tenant are design only.** Neither stretch goal is built (approval gating, a modern-web second tenant). Dropped: catalog, LLM fallback, multi-run stability, code generation.
- **Operator surface**: synchronous terminal plus window. Action policy does not cover a person's actions; the network allowlist does. Human steps are flagged, not compiled.
- **Rough edges**: `status` is outside the content hash, so a hand edit can approve an artifact; an allowlist block surfaces as `unexpected_state`; most targets have one strategy (flagged `single_strategy`).
- **Evidence caveats**: the developer ran the E7 handoff at the keyboard. In the `open_subaccount` discovery and verification, Confirm approvals were **answered by a script** the developer's coding agent ran at their request, so only the pre-commit assert checked Review; the developer then approved the artifact. The `lookup_balance` discovery predates hiding the operator ID from the model. Slow load, discovery stuck, `outcome_unknown` and an action-type denial are shown by tests, not evidence runs.

Next: outcome probing, approval bound to the content hash, the second tenant with overrides, the version probe.
