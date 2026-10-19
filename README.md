# Computer-Use Automation System

An LLM drives a legacy back-office UI once to accomplish a goal (**discovery**). What it learned is compiled into a typed, versioned, reviewable **capability artifact**, which is then **replayed deterministically with no model in the loop**, with typed inputs, typed outputs and an explicit result taxonomy. When automation cannot safely proceed, a person takes over the same live browser session and hands control back.

The target is **CoreServ 7.2**, a local fake core-banking app in `demo-app/` built to be hostile to automation: a frameset, nested layout tables, unlabeled inputs, no IDs and opaque postback URLs. All data is synthetic.

The design write-up is in [`REPORT.md`](REPORT.md). Evidence from real runs is in [`evidence/`](evidence/README.md).

## Setup

Prerequisites: Node 22 or later and pnpm 10 (`corepack enable` provides it). macOS, Linux and Windows all work.

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

Then edit `.env`:

| Key | Needed for | Value |
|---|---|---|
| `CORESERV_OPERATOR_ID` | the demo app and every run | `teller01` (already set) |
| `CORESERV_OPERATOR_PASSWORD` | the demo app and every run | any synthetic value you choose |
| `CORESERV_SUPERVISOR_CODE` | the demo app; typed by a person during a supervisor override | any synthetic value you choose |
| `OPENROUTER_API_KEY` | live discovery only | an OpenRouter key |
| `DISCOVERY_MODEL` | live discovery only | a model with image input and tool calling; the runs in `evidence/` used `anthropic/claude-haiku-5.5` |

The automation never reads the supervisor code; only the demo app and the person at the keyboard know it.

Start the demo app and leave it running in its own terminal:

```bash
pnpm app                # CoreServ on http://localhost:4070
```

Every run writes `runs/<runId>/` (gitignored): `run.jsonl`, plus `result.json` for a replay (outputs masked) or `trace.json` for a discovery, and masked `screenshots/` and `observations/` where relevant. The CLI prints the result with the real outputs to stdout. Every command below needs the demo app running; a replay without it ends in `failure` with category `runtime_error` and `safeToRetry: true`.

## Running without live services

Replay needs no model key and no network beyond the local demo app.

```bash
pnpm replay coreserv.member.lookup_balance --input memberId=10077
```

This returns `success` with `savingsBalance` read from the member profile. The same artifact works for any member: try `10042`, or `99999` for the `MEMBER_NOT_FOUND` business outcome.

Discovery can also run without a key, by replaying the model answers saved in a real trace. The browser, locator synthesis, policy and trace writing are all live; only the model is substituted:

```bash
pnpm discover capabilities/requests/coreserv.member.lookup_balance.json --recording evidence/E1-discovery-lookup_balance/trace.json
```

The tests run without a key or the running demo app (integration tests start private app instances on free ports, and no test calls a live model):

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## Demo path

**1. Discover a capability with a real model** (needs `OPENROUTER_API_KEY` and `DISCOVERY_MODEL`; a run costs well under one cent with Haiku):

```bash
pnpm discover capabilities/requests/coreserv.member.lookup_balance.json
```

The request gives the goal, typed inputs with the values to use, the declared outputs and a second input set for verification. A write capability may also list `readbackExempt`: inputs its commit screen does not show, so the compiler does not require them to be read back before the irreversible step. The command prints a summary whose `trace` field is the trace path, `runs/<runId>/trace.json`.

**2. Compile and verify it.** The compiler turns the trace into a draft artifact, replays it against the live app with the request's *other* inputs, and writes it only if that succeeds. `--out` keeps it away from the reviewed artifacts in `capabilities/`:

```bash
pnpm compile runs/<runId>/trace.json --request capabilities/requests/coreserv.member.lookup_balance.json --out runs/compiled
```

`runs/compiled/coreserv.member.lookup_balance.compile.json` lists every review flag for a person to check before approving, for example `single_strategy` (a control had only one unique locator, so there is no fallback) or `literal_value` (a typed value had no input provenance). For a write capability, `readbacks` lists which inputs the pre-commit assert checks and which the request exempted.

**3. Replay the result** for another member, with no model:

```bash
pnpm replay runs/compiled/coreserv.member.lookup_balance.json --input memberId=10042
```

**The write capability** (`coreserv.member.open_subaccount`) contains an irreversible Confirm. Discovery always asks a person before an irreversible step, so it runs with `--operator`: approval questions appear in the terminal and the browser window is opened for you.

```bash
pnpm discover capabilities/requests/coreserv.member.open_subaccount.json --operator
pnpm compile runs/<runId>/trace.json --request capabilities/requests/coreserv.member.open_subaccount.json --out runs/compiled --operator
```

A compiled artifact starts as `draft`. A draft never runs an irreversible step unattended: replay stops at Confirm with `policy_denied`, or asks you with `--operator`. After review, a person edits the artifact file and changes `"status": "draft"` to `"status": "approved"`. The content hash excludes `status`, so approval does not change what was reviewed, while any other edit makes the artifact fail to load; the error prints the new hash, which a reviewer pastes into `contentHash` after checking the edit. Then `--allow-irreversible` lets it run unattended. The committed `capabilities/coreserv.member.open_subaccount.json` was approved this way.

**Human handoff.** A deposit above $2,500.00 needs a supervisor override, which automation cannot provide:

```bash
pnpm replay coreserv.member.open_subaccount --operator --input memberId=10077 --input accountType="Money Market" --input nickname="Rainy Day" --input openingDeposit=3000.00
```

(The quoting is for bash and zsh; in PowerShell use `--input "accountType=Money Market"`.) The run pauses with an intervention request in `runs/<runId>/interventions/`. Answer `claim` in the terminal where you ran the command, enter any Supervisor ID and the code from `.env` in the browser window, click Authorize, then answer `return`. Automation re-reads the screen, carries on to Review, re-checks it, and asks you to approve Confirm.

### Evidence scenarios

The curated runs in `evidence/` were produced as follows; `evidence/README.md` lists each folder.

| # | Scenario | Command |
|---|---|---|
| E1 | Discovery, real model | `pnpm discover <request>` (lookup), `pnpm discover <request> --operator` (open_subaccount), then `pnpm compile …` |
| E2–E6 | Replay success, business outcomes, recoveries, hard failure, safety blocks | `pnpm evidence` (needs `pnpm app` running) |
| E7 | Human handoff | the supervisor-override replay above, with a person at the keyboard |

`pnpm evidence` resets the demo app, arms each fault through its admin endpoint, runs the real CLI, and copies each run directory into `evidence/<scenario>/<case>/`, **replacing the committed copy of each case it runs** (use `git checkout evidence/` to restore them). It regenerates E2 to E6 only; E1 needs a model key and E7 needs a person. Two E6 cases run under a one-field variant of the `lakeside` binding, written to `runs/evidence-tenants/` and passed with `--tenant <file>`.

## Where to look

- `REPORT.md`: architecture, artifact schema, error handling, heterogeneity, handoff, safety, cuts.
- `capabilities/`: the two compiled capability artifacts and their compile reports; `capabilities/requests/` holds the capability requests.
- `evidence/`: artifacts and logs from real discovery and replay runs.
- `profiles/coreserv/`: the app profile (login, global conditions, risk rules, masks) and the `lakeside` tenant binding (base URL, credential references, allowlist).
- `docs/DESIGN.md`, `docs/DECISIONS.md`, `docs/IMPLEMENTATION_PLAN.md`: specification, decision records, milestones and deviations.
