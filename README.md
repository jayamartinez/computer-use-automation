# Computer-Use Automation System

An LLM discovers how to complete a task in a legacy back-office UI once. The run is compiled into a typed, versioned capability artifact, which is then replayed deterministically with no model in the loop.

**Status: first checkpoint.** The demo app's read path, the schemas, the surface layer, the guarded executor and deterministic replay of a hand-written `lookup_balance` artifact work end to end. Discovery, the compiler, the write path and handoff are not built yet. See `docs/IMPLEMENTATION_PLAN.md` for progress and deviations.

Until the sections below are written, the short version (Node 22+, pnpm):

```bash
pnpm install && pnpm exec playwright install chromium
cp .env.example .env          # set CORESERV_OPERATOR_PASSWORD to any synthetic value
pnpm app                       # CoreServ demo app on http://localhost:4070
pnpm replay tests/fixtures/coreserv.member.lookup_balance.json --input memberId=10077
pnpm test && pnpm typecheck && pnpm lint
```

Replay needs no model key. Each run writes `runs/<runId>/` with `run.jsonl` and `result.json`.

This file is a required deliverable and will be completed in milestone 14. It must cover:

## Setup

(To be written: prerequisites, install, `.env` keys, starting the CoreServ demo app.)

## Running without live services

(To be written: replay needs no model key; discovery can run from recorded model responses.)

## Demo path

(To be written: the exact commands to run the agent on a goal, then replay the resulting artifact.)

## Where to look

- `REPORT.md`: design write-up.
- `evidence/`: saved artifacts and logs from real discovery and replay runs.
- `docs/DESIGN.md`: detailed specification.
