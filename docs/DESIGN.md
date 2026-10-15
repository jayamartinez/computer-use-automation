# Design specification

The detailed design behind the rules in `AGENTS.md`. Schemas here are conceptual: field names and shapes are the intent, and the Zod definitions written in milestone 4 become the authority once they exist. If implementation needs a different shape, change it deliberately and update this file.

**The Zod definitions now exist** (`src/artifact/schema.ts`, `src/profile/schema.ts`, `src/outcome/result.ts`, `src/surface/target.ts`) and are the authority. Where they differ from the examples below, the differences and reasons are listed under "Deviations from the plan" in `docs/IMPLEMENTATION_PLAN.md`.

Nine diagrams in `docs/diagrams/` (exported from the Paper file "fake banking app") show the same design visually: `01-system-architecture`, `02-discovery-lifecycle`, `03-deterministic-replay`, `04-artifact-anatomy`, `05-result-taxonomy`, `06-safety-and-policy-gate`, `07-human-handoff`, `08-coreserv-workflows`, `09-surfaces-and-layering`. If a diagram and this file disagree, this file wins.

## 1. Demo application: CoreServ 7.2

A fake legacy core-banking back-office app for one tenant, "Lakeside CU" (`lakeside`).

**Legacy characteristics (all deliberate):**
- A frameset shell with three frames: `banner`, `nav`, `workarea`.
- Server-rendered pages built from nested layout tables.
- Text inputs with no `<label>`, `id`, `name`-based hooks or test IDs; the label is text in the adjacent cell.
- Submit buttons named only by their `value`.
- Opaque postback URLs (`/cs.do?act=…`), so no state can be recognized from the URL.
- A version string in the banner ("CoreServ 7.2"), used as a drift signal.

**Screens:** Login, Shell, Main Menu, Member Inquiry, Results, Member Profile, Sub-Account Form, Review, Confirmation, System Notice, Session Expired, Supervisor Override, Application Error.

**Admin endpoints** (outside the automation allowlist): `/__admin/faults` to set faults, `/__admin/reset` to reseed.

**Seed data (all synthetic):**

| Member | Purpose |
|---|---|
| 10042 | Discovery member. Savings $2,480.17, Checking $913.40 |
| 10077 | Verification and replay member. Savings $15,902.66, Checking $4,210.05 |
| 10200 | Employee account. Opening the profile returns "Access restricted" |
| 99999 | Does not exist |

Operator `teller01`. Its password and the supervisor override code come from the environment and are never written to disk by the automation. The automation never reads the override code at all: only the demo app and the human operator know it.

The approved mockups are artboards 1–16 on the "CoreServ screens" page of the Paper file. The pink notes under them ("Notes (Paper only)" artboards) are design notes: the app never renders them, so they can never reach runtime evidence.

**Rules:**
- The Member Profile has an "Open Sub-Account" button that opens the Sub-Account Form for that member.
- Account types offered: Club Savings, Money Market, Certificate. Nickname is 1–20 letters, digits or spaces. Opening deposit is a plain decimal (`500` or `500.00`).
- A missing or malformed field shows the form again with "Complete all required fields." (a validation error, not reachable with valid inputs).
- Opening deposit is drawn from the member's Savings. A deposit above the Savings balance shows the form again with "Opening deposit exceeds available balance". This check runs first.
- A deposit above $2,500.00 shows Supervisor Override Required before Review. Authorize with any Supervisor ID and the correct override code continues to Review, which then shows "Supervisor Override: Approved (<ID>)"; a wrong code shows the override screen again with "Override code not accepted."; Cancel returns to the form.
- Review shows the pending transaction. Confirm opens the account (`4000-<member>-<nn>`, the next free suffix), moves the deposit out of Savings and shows the Confirmation with a reference `OSA-dddd-dddd`. Back returns to the form with its values; Cancel returns to the profile.
- Confirm has no idempotency key: submitting the same Review twice opens two accounts. That is why replay never repeats it.

**Fault settings (server-side, set through the admin endpoint):**

| Fault | Effect |
|---|---|
| `notice` | Armed on a workarea screen: the next request for it shows the System Notice; Acknowledge continues to that screen with the same form data |
| `expireSession` | Armed on a workarea screen: the next request for it ends the session and shows Session Expired. Every later request shows it until the operator uses "Sign in again", which opens the sign-in page in the whole window |
| `latencyMs` | Adds delay to every response |
| `error500` | Armed on a workarea screen: the next request for it returns the Application Error page (HTTP 500) |
| `dialog` | Armed on a workarea screen: the next response for it raises a native `alert()` ("Your CoreServ password expires in 3 days…") when the page loads |
| `commitThen500` | `true` arms it once: the next Confirm commits the sub-account, then returns the Application Error page (HTTP 500), identical to `error500` |

Screen faults fire once, on the screen they are armed for (`main_menu`, `inquiry`, `search`, `profile`, `subaccount`, `continue`, `confirm`), so every scenario reproduces exactly. Example: `POST /__admin/faults {"notice": "search"}`; `null` disarms. A clock-based session TTL was rejected because the re-login pass would expire again at a different step on each run.

## 2. Workflows

Both start on the authenticated shell. Login is performed by the app profile.

### `coreserv.member.lookup_balance`

| # | State before | Action | Expected after | Branches |
|---|---|---|---|---|
| 1 | Main Menu | Click "Member Inquiry" in `nav` | Search form | |
| 2 | Search form | Fill Member Number with `{{inputs.memberId}}` | Field reads back the value | |
| 3 | Search form | Click "Search" | Results row for that member | `MEMBER_NOT_FOUND` |
| 4 | Results | Click "View" in the row whose Member No equals the input | Member Profile | `PERMISSION_DENIED` |
| 5 | Member Profile | Extract Balance from the Accounts row where Type is Savings | Value parses as money | |
| ✓ | Member Profile | Checkpoint: the profile's Member No equals the input; balance parsed | | |

### `coreserv.member.open_subaccount`

Inputs: `memberId` (5 digits, `identifier`), `accountType` (enum of the three types, `none`), `nickname` (`^[A-Za-z0-9 ]{1,20}$`, `none`), `openingDeposit` (money, `financial`). Outputs: `newAccountNumber` (`^4000-\d{5}-\d{2}$`, `account_number`) and `confirmationRef` (`^OSA-\d{4}-\d{4}$`, `none`).

| # | Step id | Action | Risk | Expected after | Branches |
|---|---|---|---|---|---|
| 1–4 | as lookup | Same as lookup; step 4 expects the Open Sub-Account button | read / reversible | Member Profile | `MEMBER_NOT_FOUND`, `PERMISSION_DENIED` |
| 5 | `open_form` | Click "Open Sub-Account" | read | Account Type select resolvable | |
| 6 | `select_type` | Select Account Type `{{inputs.accountType}}` | reversible | Reads back | |
| 7 | `fill_nickname` | Fill Nickname `{{inputs.nickname}}` | reversible | Reads back | |
| 8 | `fill_deposit` | Fill Opening Deposit `{{inputs.openingDeposit}}` | reversible | Reads back | |
| 9 | `continue_to_review` | Click "Continue" (posts nothing) | reversible | Confirm button resolvable | `INSUFFICIENT_FUNDS`; Supervisor Override (escalate) |
| 10 | `assert_review` | Assert Member No, Account Type, Nickname and Opening Deposit (as money) equal the inputs | read | | A mismatch is `unexpected_state` |
| 11 | `confirm` | Click "Confirm" (irreversible, gated, never retried) | irreversible | "Sub-account opened" | Anything else is `outcome_unknown` |
| 12–13 | `read_account`, `read_reference` | Extract New Account No and Confirmation Ref | read | Both match their patterns | |
| ✓ | | Checkpoint: "Sub-account opened"; Member No equals the input; both outputs parsed | | | |

Recoverable on this flow: System Notice anywhere; session expiry before step 11 (sign in again, restart); the known password-expiry alert. Escalations: Supervisor Override (step 9), the approval before step 11, an unknown outcome after it.

Two rules worth keeping:
- **Identity read-back.** Both checkpoints confirm the screen shows the member that was asked for.
- **Pre-commit assertion.** Step 10 makes the irreversible click conditional on the screen showing what will be committed. The schema requires an `assert` step immediately before every irreversible step, and replay runs it again if control changed hands since it last passed.

## 3. Surface interface

```ts
interface Surface {
  observe(): Promise<Observation>;                 // elements with refs, role, name, text, bounds, scope; screenshot; fingerprint
  resolve(target: Target): Promise<Resolution>;    // { kind: "unique", handle, strategyIndex } | { kind: "ambiguous", count } | { kind: "none" }
  act(handle: Handle, action: Action): Promise<void>;
  matches(signature: Signature): Promise<boolean>;
  firstMatch(signatures: Signature[]): Promise<number | undefined>; // ordered, one observation
  screenshot(opts: { mask: MaskRule[] }): Promise<Buffer>;
  watchHuman(listener: (action: HumanAction) => void): Promise<() => Promise<void>>;
}
```

- The recorded flow speaks only in targets, actions and signatures. How a surface perceives and acts is entirely behind this interface.
- **Scope.** Each target and signature names a scope: an ordered path of named containers, matched exactly. The surface defines the names: on `PlaywrightSurface` it is the path of frame names below the top document (`["workarea"]`); on a single-document page it is `[]`; a desktop surface would use window then pane. A surface must give each container a stable name. `PlaywrightSurface` uses the frame's `name`, so an unnamed iframe is a known gap.
- **Native dialogs are a container named `dialog`.** While an `alert`/`confirm`/`prompt` is open, the observation holds only the dialog, as an operator sees it: its message as text and its buttons (`OK`, plus `Cancel` for confirm and prompt) as buttons, all in scope `["dialog"]`. Clicking `OK` accepts it and `Cancel` dismisses it. Existing targets, signatures and profile handlers therefore work unchanged, and a desktop modal window would map the same way. A surface never answers a dialog by itself; one that matches no profile condition is an `unexpected_state`.
- **Handoff seam.** `watchHuman(listener)` starts reporting what a person does on the surface (role, name and scope of the control; never a typed value) and returns a function that stops it. A surface whose session has gone (window closed) throws `SurfaceClosedError`.
- `PlaywrightSurface` builds observations from per-frame accessibility snapshots plus bounding boxes, and resolves `anchor` and `table_cell` geometrically.
- `FakeSurface` is an in-memory state machine used to test the interpreter, executor and handoff without a browser.

## 4. Artifact schema

Trimmed example:

```jsonc
{
  "schemaVersion": 1,
  "id": "coreserv.member.lookup_balance",
  "version": "1.0.0",            // major = contract change; minor = steps or targets; patch = rationale/description
  "status": "draft",             // draft | approved
  "contentHash": "sha256:…",
  "description": "Read a member's current savings balance.",
  "app": { "product": "coreserv", "recordedVersion": "7.2", "surface": "web" },

  "inputs": {
    "memberId": { "type": "string", "pattern": "^\\d{5}$", "sensitivity": "identifier",
                  "description": "Member number", "example": "10042" }
  },
  "outputs": {
    "savingsBalance": { "type": "money", "currency": "USD", "sensitivity": "financial",
                        "fromStep": "read_balance" }
  },

  "targets": {
    "member_number_field": {
      "scope": ["workarea"], "role": "textbox",
      "strategies": [
        { "kind": "anchor", "text": "Member Number", "relation": "right_of" }
      ],
      "rationale": "Input has no accessible name; the adjacent label cell is the only stable handle."
    },
    "search_button": {
      "scope": ["workarea"], "role": "button",
      "strategies": [
        { "kind": "role_name", "name": "Search" },
        { "kind": "anchor", "text": "Member Number", "relation": "below" }
      ],
      "rationale": "Named by its value attribute; anchor kept as fallback."
    },
    "view_link": {
      "scope": ["workarea"], "role": "link",
      "strategies": [
        { "kind": "table_cell", "headers": ["Member No", "Name"],
          "row": { "column": "Member No", "equals": "{{inputs.memberId}}" }, "column": "Action" }
      ],
      "rationale": "Row is keyed by the templated member number, never by position or name."
    },
    "savings_balance_cell": {
      "scope": ["workarea"], "role": "cell",
      "strategies": [
        { "kind": "table_cell", "headers": ["Type", "Balance"],
          "row": { "column": "Type", "equals": "Savings" }, "column": "Balance" }
      ],
      "rationale": "Addressed by header and row key, never by position."
    }
  },

  "steps": [
    { "id": "open_inquiry", "intent": "Open the member inquiry screen",
      "action": "click", "target": "member_inquiry_link",
      "risk": "read", "expect": { "resolvable": "member_number_field" },
      "timeoutMs": 10000, "retry": { "max": 1 } },
    { "id": "fill_member", "intent": "Enter the member number",
      "action": "fill", "target": "member_number_field", "value": "{{inputs.memberId}}",
      "risk": "reversible", "expect": { "valueEquals": "{{inputs.memberId}}" },
      "timeoutMs": 5000, "retry": { "max": 1 } },
    { "id": "search", "intent": "Run the search",
      "action": "click", "target": "search_button",
      "risk": "read", "expect": { "resolvable": "view_link" },
      "timeoutMs": 10000, "retry": { "max": 0 } },
    { "id": "open_member", "intent": "Open the member's profile",
      "action": "click", "target": "view_link",
      "risk": "read", "expect": { "resolvable": "savings_balance_cell" },
      "timeoutMs": 10000, "retry": { "max": 0 } },
    { "id": "read_balance", "intent": "Read the savings balance",
      "action": "extract", "target": "savings_balance_cell", "output": "savingsBalance",
      "risk": "read", "timeoutMs": 5000, "retry": { "max": 1 } }
  ],

  "outcomes": [
    { "code": "MEMBER_NOT_FOUND", "afterSteps": ["search"],
      "signature": { "scope": ["workarea"], "textPresent": "No members match" } },
    { "code": "PERMISSION_DENIED", "afterSteps": ["open_member"],
      "signature": { "scope": ["workarea"], "textPresent": "Access restricted" } }
  ],
  "conditions": "profile",       // all app-profile conditions apply; none are copied into the artifact

  "checkpoint": { "all": [
    { "cellEquals": { "target": "profile_member_no", "value": "{{inputs.memberId}}" } },
    { "outputParsed": "savingsBalance" }
  ]},

  "requires": { "actions": ["click", "fill", "extract"], "maxRisk": "reversible",
                "scopes": ["nav", "workarea"] },

  "provenance": { "traceId": "…", "model": "…", "discoveredAt": "…",
                  "compilerVersion": "…", "verifiedWith": "inputs differing from discovery" }
}
```

**Rules:**
- **Locator kinds.** `role_name` (accessible role and name), `anchor` (a control of a given role in a geometric relation to visible text: `right_of`, `below`, `same_row`), `table_cell` (table found by header set, row by key column, cell by column).
- **Resolution.** Strategies are tried in order. A strategy matching zero or several elements is skipped. No unique match from any strategy is `target_unresolved` or `target_ambiguous`. Success on any strategy but the first adds a `locator_fallback` warning.
- **Values.** Only `{{inputs.x}}` templates or reviewed constants. No secret ever appears.
- **Actions.** `click`, `fill`, `select`, `extract`, `assert`. An `assert` step has no target: it holds a `check` signature that must hold on the current screen, and acts on nothing.
- **Risk.** `read`, `reversible`, `irreversible`. An irreversible step has `retry.max: 0` and `onTimeout: "outcome_unknown"`, and must come immediately after an `assert` step (the pre-commit read-back).
- **Expect.** `valueEquals` for fills and selects; `resolvable` (the next target can be uniquely resolved) for clicks. Checkpoints add identity read-back and parsed outputs.
- **Signatures.** Content predicates within a scope (`textPresent`, `resolvable`, `cellEquals`), combined with `all` / `any`. Never URL-based. `cellEquals` takes `as: "money"` to compare amounts rather than text, so the input `500.00` equals the screen's `$500.00` without a formatting language in templates.
- **Types.** `string`, `integer`, `money` (decimal string, currency), `date`, `enum`. Sensitivities: `none`, `identifier`, `financial`, `account_number`, `pii`. An output may declare a `pattern` its extracted text must match.
- **`open_subaccount` differences.** `requires.maxRisk` is `irreversible`; outputs `newAccountNumber` (`account_number`, logged masked) and `confirmationRef`.

## 5. Replay

Before running: validate inputs against the artifact, check `requires` against tenant policy, check artifact status against the irreversible rule, run the profile login.

Per step:
1. Confirm the controller is `automation` and the epoch is current.
2. Policy check for this action and risk.
3. Resolve the target, waiting up to the timeout.
4. Act through the guarded executor.
5. **State race:** wait for the first match among any profile condition, any outcome whose `afterSteps` includes this step, and the step's `expect`, checked in that order against one observation. If the target in step 3 cannot be resolved, check the profile conditions before reporting drift.
6. Act on the disposition of whatever matched (table below). A timeout with nothing matched is `unexpected_state`.

| Observed | Disposition | Effect |
|---|---|---|
| Step's `expect` | continue | next step |
| Outcome signature | outcome | return `business_outcome` |
| `system_notice` | recover | acknowledge, wait for the notice to clear (up to `slowLoadMs`), re-wait for `expect` |
| `session_expired` | recover | click "Sign in again", re-login and restart from step 1, only if no irreversible step was dispatched; otherwise `outcome_unknown` |
| Slow load | (none) | waiting is built in; past a soft threshold adds a `slow_load` warning |
| `supervisor_override` | escalate | takeover request; with no operator channel, `failure: escalation_timeout` |
| Irreversible step without unattended approval | escalate | approval request |
| `app_error` | fail | `failure: app_error` |
| Nothing matched | fail | `failure: unexpected_state` |
| Irreversible step dispatched, result undetermined | escalate | `unknown_outcome` request |
| `password_expiry_alert` (native dialog) | recover | click OK in scope `dialog`, re-wait for `expect` |
| Any other native dialog | fail | nothing matches, so `failure: unexpected_state`; never accepted blindly |

### Irreversible steps

- **Gate.** The step runs unattended only when the artifact is `approved` and the caller passed `--allow-irreversible`. Otherwise, with an operator channel, an `approval` request is raised (approve or deny); without one, the executor denies it: `failure: policy_denied`.
- **Pre-commit read-back.** The `assert` step before it must have passed in the current control epoch. Any transfer of control (an approval wait included) makes replay run it again first.
- **Dispatched means attempted.** A `dispatch_irreversible` event is logged and the step is marked dispatched *before* the surface is told to act. An error thrown while acting counts as dispatched.
- **No blind retry.** After dispatch nothing repeats the click and nothing restarts the run. Only the step's expected state and outcomes the artifact lists for that step are trusted; any condition (`fail`, `recover` with restart, `escalate`), a timeout or an unknown screen becomes `outcome_unknown`: `sideEffects: "possible"`, `safeToRetry: false`. A `recover` condition with `resume: "continue"` (such as a notice) is still handled, since it repeats nothing.
- **Unknown outcome.** With a channel, an `unknown_outcome` request lets a person look at the live session (§10). Without one, the result is `failure: outcome_unknown`. `commitThen500` is the reproducible case: the app commits and then shows the same page as `error500`.
- **Evidence.** The dispatch event, the state that matched after it, a masked screenshot (the error page's Reference stays readable for reconciliation), the masked element dump and any intervention files.

Recoveries are bounded (default two attempts per condition per run); exceeding the bound is `recovery_exhausted`. A step's `retry` budget covers only failures from the step itself; a disposition's decision is final.

`safeToRetry` is true only when nothing can have been committed and the category is not fixed by the inputs, the policy, the artifact or a human (`src/outcome/result.ts`).

### Result contract

```ts
type ReplayResult = Common & (
  | { status: "success"; outputs: Outputs }
  | { status: "business_outcome"; outcome: { code: string; atStep: string; message?: string } }
  | { status: "failure"; failure: {
        category: "invalid_input" | "policy_denied" | "target_unresolved" | "target_ambiguous"
                | "unexpected_state" | "app_error" | "extraction_invalid" | "recovery_exhausted"
                | "outcome_unknown" | "aborted_by_human" | "escalation_timeout";
        stepId: string; intent: string;
        expected: string; observed: string;        // observed is masked
        sideEffects: "none" | "possible" | "committed";
        safeToRetry: boolean;
        outputsVerified: false;                    // a failure never carries checked outputs
        evidence: { screenshot: string; observation: string };
      } }
);

type Common = {
  runId: string;
  capability: { id: string; version: string; contentHash: string };
  tenant: string; durationMs: number; stepsCompleted: number;
  recoveries: { condition: string; atStep: string; attempts: number }[];
  interventions: { id: string; kind: string; resolution: string }[];
  warnings: { kind: "locator_fallback" | "slow_load" | "version_mismatch"; stepId?: string }[];
  log: string;
};
```

## 6. Discovery

**Capability request:**

```jsonc
{
  "id": "coreserv.member.lookup_balance",
  "goal": "Look up the member and read their current savings balance.",
  "tenant": "lakeside",
  "inputs":  { "memberId": { "type": "string", "pattern": "^\\d{5}$", "value": "10042" } },
  "outputs": { "savingsBalance": { "type": "money", "currency": "USD" } },
  "verifyInputs": { "memberId": "10077" },
  "probes": [ { "code": "MEMBER_NOT_FOUND", "inputs": { "memberId": "99999" } } ]   // secondary scope
}
```

**Loop.** Log in via the profile, then repeat: observe; handle any profile condition; ask the model for one action; classify risk by policy; run it through the guarded executor; record a trace event.

**Model action vocabulary:** `click`, `fill`, `select`, `extract`, `finish`, `need_human`, `give_up`. Values are references (`{"input": "memberId"}`) or flagged literals. There is no `navigate` action; the harness opens the entry point.

**Stopping and stuck detection (all deterministic):** step budget; wall-clock budget; the same action on an unchanged observation fingerprint three times; repeated policy denials; the model's own `need_human` or `give_up`. Stuck raises a takeover request rather than failing outright.

**Provider.** One interface, `decide(context) → Action`. `OpenRouterProvider` for real runs; `RecordedProvider` replays saved responses for tests and for running without a key.

### Trace event

```jsonc
{ "seq": 3, "actor": "automation",
  "observation": { "id": "obs-3", "fingerprint": "…", "screenshot": "…", "elements": "…" },
  "decision": { "action": "fill", "ref": "e14", "value": { "input": "memberId" },
                "rationale": "Enter the member number to search" },
  "policy": { "risk": "reversible", "decision": "allow", "rule": "fill:default" },
  "target": { "role": "textbox", "scope": ["workarea"],
              "candidates": [
                { "kind": "role_name", "unique": false },
                { "kind": "anchor", "text": "Member Number", "relation": "right_of", "unique": true } ] },
  "result": { "status": "ok", "postObservation": "obs-4", "settleMs": 180 } }
```

The trace header carries the request (input values masked by sensitivity), tenant, app version and model. The final event carries `finish` with the elements the model cites as evidence of success.

## 7. Compiler

**Needs from the trace:** value provenance per action; locator candidates tested for uniqueness at the moment of acting; the policy risk decision; action results; output bindings with captured raw text; finish evidence; actor; rationale.

**Deterministic steps:**
1. Validate: the trace ended in `finish`, every declared output is bound, no policy denial is unresolved.
2. Prune only failed actions and interludes handled by profile conditions. Anything else that looks redundant is kept and flagged.
3. Template values from provenance. Flag literals with no provenance.
4. Template or reject locator text containing an input value.
5. Deduplicate elements into named targets; order strategies by a fixed ranking (`role_name`, `anchor`, `table_cell` where it applies); keep only strategies that were unique at capture. Zero is a compile error; one is a warning.
6. Derive `expect` per step and the checkpoint from finish evidence plus identity read-back.
7. Copy risk from the trace; compute `requires`; stamp provenance and content hash; set `draft`.
8. Verification replay with `verifyInputs`. Not saved unless it returns `success`.
9. Write the artifact and a compile report listing every review flag.

Human steps captured during a discovery takeover are compiled in, flagged, and keep the artifact `draft`.

**The one LLM use (secondary scope): outcome probing.** For each probe, replay the draft with the probe inputs and irreversible steps denied, until a step's expected state fails to appear. Give that single observation to the model with a typed question: which element shows this outcome, or none. Write the signature, then re-replay the probe; it must return that `business_outcome`. Until this exists, outcomes are added to the draft by hand and the report says so.

## 8. App profile and tenant binding

```jsonc
// profiles/coreserv/profile.json
{
  "product": "coreserv", "versions": "7.x", "surface": "web",
  "scopes": ["banner", "nav", "workarea", "dialog"],
  "versionProbe": { "scope": ["banner"], "pattern": "CoreServ (\\d+\\.\\d+)" },
  "login": { "steps": [ /* fill operator id, fill {{secrets.password}}, click Sign In */ ],
             "authenticated": { "scope": ["nav"], "textPresent": "Member Inquiry" } },
  "conditions": [
    { "id": "system_notice",       "disposition": "recover",  "signature": { "textPresent": "System Notice" },
      "handler": { "click": { "role": "button", "name": "Acknowledge" } }, "resume": "continue", "maxAttempts": 2 },
    { "id": "session_expired",     "disposition": "recover",  "signature": { "textPresent": "Your session has expired" },
      "handler": { "click": { "role": "link", "name": "Sign in again" } }, "resume": "restart_if_no_side_effects", "maxAttempts": 1 },
    { "id": "app_error",           "disposition": "fail",     "signature": { "textPresent": "Application Error" } },
    { "id": "supervisor_override", "disposition": "escalate", "signature": { "textPresent": "Supervisor Override Required" } },
    { "id": "password_expiry_alert", "disposition": "recover", "signature": { "scope": ["dialog"], "textPresent": "password expires" },
      "handler": { "click": { "scope": ["dialog"], "role": "button", "name": "OK" } }, "resume": "continue", "maxAttempts": 2 }
  ],
  "timeouts": { "slowLoadMs": 3000 },
  "risk": { "safeControls": ["Search", "View", "Continue", "Acknowledge", "Member Inquiry", "Open Sub-Account"],
            "commitControls": ["Confirm"] },
  "formats": { "money": "$#,##0.00", "date": "MM/DD/YYYY" },
  "masks": [                     // values hidden in saved screenshots and observation dumps
    { "label": "Account No", "where": "below" }, { "label": "SSN", "where": "right_of" },
    { "label": "Balance", "where": "below" },
    { "label": "Name", "where": "below",    "when": { "scope": ["workarea"], "textPresent": "Member Inquiry Results" } },
    { "label": "Name", "where": "right_of", "when": { "scope": ["workarea"], "textPresent": "Member Profile" } },
    { "label": "Member No", "where": "below", "when": { "scope": ["workarea"], "textPresent": "Member Inquiry Results" } },
    { "label": "Member No", "where": "right_of", "when": { "scope": ["workarea"], "textPresent": "Member Profile" } },
    { "label": "Member Number", "where": "right_of" },
    { "label": "Opening Deposit", "where": "right_of" }, { "label": "New Account No", "where": "right_of" },
    { "label": "Operator:", "where": "self" }
    /* …one Member No / Name rule per write-path screen; the profile file is the full list */ ]
}

// profiles/coreserv/tenants/lakeside.json
{
  "tenant": "lakeside", "product": "coreserv", "deployedVersion": "7.2",
  "baseUrl": "http://localhost:4070",
  "credentials": { "operatorId": "env:CORESERV_OPERATOR_ID", "password": "env:CORESERV_OPERATOR_PASSWORD" },
  "policy": { "origins": ["http://localhost:4070"], "paths": ["/", "/cs.do"],
              "scopes": ["banner", "nav", "workarea", "dialog"],
              "actions": ["click", "fill", "select", "extract", "assert"],
              "maxRisk": "irreversible" }
}
```

There is no tenant `irreversible` setting. A tenant that must never write sets `maxRisk` below `irreversible`; otherwise the irreversible gate in §5 applies to every tenant the same way.

**Masks.** A rule names a visible label and where its value sits: `below` (a column under a header), `right_of` (a value beside a form label) or `self` (the label and value share one text element, such as the banner's "Operator: teller01"; the whole element is hidden). `when` limits a rule to one screen. Member numbers, names, account numbers, balances, deposits, the available balance, the override amount, the Supervisor ID and the operator ID are all masked in saved screenshots and observation dumps. Evidence is told apart by scenario folder and run id, and logs show identifiers as `***77`.

Tenant overrides (secondary) patch named targets, condition signatures and timeouts only.

**Drift signals:** `locator_fallback` warnings, checkpoint failure rate per tenant, and the probed app version differing from `recordedVersion` (`version_mismatch` warning).

## 9. Policy and the guarded executor

Checks, in order, for every action:
1. Controller is `automation` and the epoch matches.
2. Action type is allowed for this tenant.
3. Target scope is allowed.
4. Risk class is within `maxRisk`; an irreversible action has an approval.
5. Execute through the surface; log the event with redaction applied.

Independent of these, the browser context blocks every request whose origin and path are not both on the tenant allowlist (`paths` entries are exact, or a prefix when they end in `*`). It fails closed, so the admin endpoints are blocked because they are not listed.

## 10. Human handoff

```
                    ┌──────────── approve / deny (approval only) ───────────┐
                    ▼                                                       │
AUTOMATION_ACTIVE ──trigger──► PAUSING ──settled──► AWAITING_HUMAN ──claim──► HUMAN_ACTIVE
        ▲                                                │ timeout               │ return / abort
        │                                                ▼                       ▼
        └───────────────── resync ok ─────────────── RESYNC ◄────────────────────┘
                                                        │ no match
                                                        ▼
                                                     FAILED
```

- **Ownership.** `controller: automation | human | none` and an epoch incremented on every transfer. The guarded executor refuses any action planned under an older epoch.
- **Triggers.** A condition with disposition `escalate`; an irreversible step needing approval; unknown outcome; discovery stuck.
- **Pausing.** Control passes to `none`; automation waits until two observations in a row have the same fingerprint (at most `slowLoadMs`), then captures a masked screenshot.
- **Intervention request.** `{ id, runId, kind: "approval" | "takeover" | "unknown_outcome", capability, stepId, intent, condition, reason, inputs (redacted by sensitivity), screenshot (masked), allowedResponses, epoch, createdAt }`, written to `runs/<runId>/interventions/<n>.json` and sent through an `InterventionChannel`. The channel asks one question at a time from a fixed list of answers; `TerminalChannel` prompts on stdin, and tests use a scripted channel.
- **Approval.** Answers `approve` / `deny`. Control never passes to the human: it goes `none` and back to `automation`, so the pre-commit `assert` runs again before Confirm. `deny` is `failure: aborted_by_human`.
- **Takeover.** Answers `claim` / `abort` within `claimTimeoutMs` (no answer: `escalation_timeout`). On `claim`, control passes to `human` and human capture starts. The person works in the same headed window, then answers `return` / `abort`.
- **Human capture.** An injected listener records each click, change and submit with the control's role, name and scope, the epoch and the time, into `run.jsonl` (`human_action`) and `interventions/<n>.actions.json`. Typed values are never recorded. A click on a profile commit control marks an irreversible action as dispatched, so side effects become `possible`. The network allowlist still applies; action policy does not (a stated limit).
- **Resync on return.** Control passes back to `automation`, then one fresh observation is matched, in order, against: profile conditions (a `recover` one is handled and matching repeats), the step's outcomes, the step's `expect` (advance to the next step). Anything else is `unexpected_state`. **The step that triggered an escalation is never run again**: it would only lead back to the same screen, and the person evidently chose not to finish it. So Cancel on the override screen followed by `return` is `unexpected_state` with `sideEffects: "none"`.
- **Abort and loss of session.** `abort` is `failure: aborted_by_human`. A session expiry seen at resync is handled like any other (sign in again and restart if nothing was dispatched; the override then escalates again). A closed window is `unexpected_state` ("the session window was closed"). A screen elsewhere in the app is `unexpected_state` with evidence.
- **Unknown outcome.** Automation never repeats the click. The person claims the session, looks (for example at the member's account list), returns control and gives a verdict:
  - The step's expected state is on screen at resync (a slow commit finished): automation verifies the checkpoint and extracts outputs as usual. No verdict is needed.
  - *Committed*: `failure` keeping the category that triggered the request (`app_error` for `commitThen500`), with `sideEffects: "committed"`, `safeToRetry: false` and `outputsVerified: false`. The account exists but its number and reference were not read from a checkpointed screen, so they are not returned.
  - *Not committed*: the same category, `sideEffects: "none"`, `safeToRetry` as for that category.
  - *Can't tell*: `failure: outcome_unknown`, `sideEffects: "possible"`, `safeToRetry: false`.
- **Dialogs during a takeover.** A native dialog raised while the person is in control is held by the surface like any other, and the terminal shows its text. After `return`, a known one is handled by its profile condition. This is a limit of the minimal operator surface.
- **In production** this would be asynchronous, the channel would be a queue or ticket, and the window would be a streamed remote session. Those are design notes for the report, not things to build.

## 11. Evidence

Every run writes `runs/<runId>/` (gitignored):

```
run.jsonl            one structured event per line: observation ids, decision + rationale, policy decision, result, timings
result.json          ReplayResult, or the discovery summary
trace.json           discovery only
screenshots/         one per step in discovery; on failure, recovery and handoff in replay (masked)
observations/        element snapshots referenced by the log (masked)
interventions/       requests, responses, captured human actions
```

Curated copies of the required scenarios are committed under `evidence/` (see the implementation plan).
