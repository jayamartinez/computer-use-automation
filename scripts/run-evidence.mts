// Regenerates evidence scenarios E2 to E6 by running the real CLI against the demo app, with
// faults armed through its admin endpoint, and copying each run directory verbatim into
// evidence/. Run logs and results are already masked by the code that wrote them; nothing
// here edits them.
//
//   pnpm app        (in another terminal)
//   pnpm evidence

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = "http://localhost:4070";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(import.meta.resolve("tsx/cli"));
const LOOKUP = "coreserv.member.lookup_balance";
const OPEN = "coreserv.member.open_subaccount";

type Expected = { status: string; detail?: string; recovery?: string };
type Case = {
  scenario: string;
  name: string;
  capability: string;
  inputs: Record<string, string>;
  faults?: Record<string, string | boolean>;
  flags?: string[];
  /** A variant of the lakeside binding with one policy field changed. */
  policy?: Record<string, unknown>;
  expected: Expected;
  /** Only an approved artifact may run its irreversible step unattended. */
  needsApproval?: boolean;
};

const lookup = (memberId: string) => ({ memberId });
const open = (memberId: string, openingDeposit: string) => ({
  memberId,
  accountType: "Money Market",
  nickname: "Rainy Day",
  openingDeposit,
});

// Case names carry no member numbers: evidence is told apart by folder and run id.
const CASES: Case[] = [
  {
    scenario: "E2-replay-success",
    name: "lookup_balance",
    capability: LOOKUP,
    inputs: lookup("10077"),
    expected: { status: "success" },
  },
  {
    scenario: "E2-replay-success",
    name: "open_subaccount",
    capability: OPEN,
    inputs: open("10077", "400.00"),
    flags: ["--allow-irreversible"],
    needsApproval: true,
    expected: { status: "success" },
  },
  {
    scenario: "E3-business-outcome",
    name: "lookup_balance-unknown-member",
    capability: LOOKUP,
    inputs: lookup("99999"),
    expected: { status: "business_outcome", detail: "MEMBER_NOT_FOUND" },
  },
  {
    scenario: "E3-business-outcome",
    name: "lookup_balance-restricted-member",
    capability: LOOKUP,
    inputs: lookup("10200"),
    expected: { status: "business_outcome", detail: "PERMISSION_DENIED" },
  },
  // Stops at the form, before Confirm, so a draft artifact is enough.
  {
    scenario: "E3-business-outcome",
    name: "open_subaccount-over-balance",
    capability: OPEN,
    inputs: open("10042", "2490.00"),
    expected: { status: "business_outcome", detail: "INSUFFICIENT_FUNDS" },
  },
  {
    scenario: "E4-recoverable",
    name: "lookup_balance-system-notice",
    capability: LOOKUP,
    inputs: lookup("10077"),
    faults: { notice: "search" },
    expected: { status: "success", recovery: "system_notice" },
  },
  {
    scenario: "E4-recoverable",
    name: "lookup_balance-session-expired",
    capability: LOOKUP,
    inputs: lookup("10077"),
    faults: { expireSession: "profile" },
    expected: { status: "success", recovery: "session_expired" },
  },
  {
    scenario: "E4-recoverable",
    name: "lookup_balance-password-dialog",
    capability: LOOKUP,
    inputs: lookup("10077"),
    faults: { dialog: "profile" },
    expected: { status: "success", recovery: "password_expiry_alert" },
  },
  {
    scenario: "E5-hard-failure",
    name: "lookup_balance-app-error",
    capability: LOOKUP,
    inputs: lookup("10077"),
    faults: { error500: "profile" },
    expected: { status: "failure", detail: "app_error" },
  },
  // No operator and no allow flag: even an approved artifact may not run Confirm unattended.
  {
    scenario: "E6-safety-block",
    name: "open_subaccount-confirm-refused",
    capability: OPEN,
    inputs: open("10077", "400.00"),
    expected: { status: "failure", detail: "policy_denied" },
  },
  // A tenant that never writes: the artifact's `requires` is refused before any step runs.
  {
    scenario: "E6-safety-block",
    name: "open_subaccount-read-only-tenant",
    capability: OPEN,
    inputs: open("10077", "400.00"),
    policy: { maxRisk: "reversible" },
    expected: { status: "failure", detail: "policy_denied" },
  },
  // The app only ever requests allowed paths, so the block needs a narrower allowlist: the
  // first postback is aborted in the browser. Replay reports the screen that never arrived.
  {
    scenario: "E6-safety-block",
    name: "lookup_balance-off-allowlist",
    capability: LOOKUP,
    inputs: lookup("10077"),
    policy: { paths: ["/"] },
    expected: { status: "failure", detail: "unexpected_state" },
  },
];

type Result = {
  runId: string;
  status: string;
  outcome?: { code: string };
  failure?: { category: string };
  recoveries: { condition: string }[];
};

async function admin(path: string, body?: object): Promise<void> {
  const post = () =>
    fetch(`${APP}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  // A pooled keep-alive connection the app has already closed fails once; a new one does not.
  const response = await post().catch(post);
  if (!response.ok)
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
}

function skipReason(c: Case): string | undefined {
  const file = join(ROOT, "capabilities", `${c.capability}.json`);
  if (!existsSync(file)) return `capabilities/${c.capability}.json does not exist yet`;
  const status = (JSON.parse(readFileSync(file, "utf8")) as { status: string }).status;
  // Approval is a human review; the automation never sets it.
  if (c.needsApproval && status !== "approved")
    return `artifact is "${status}"; a person must review and approve it first`;
  return undefined;
}

/** Writes the policy variant into runs/, which is gitignored, and returns its path. */
function tenantVariant(c: Case): string[] {
  if (!c.policy) return [];
  const lakeside = JSON.parse(
    readFileSync(join(ROOT, "profiles/coreserv/tenants/lakeside.json"), "utf8"),
  ) as { policy: object };
  const dir = join(ROOT, "runs", "evidence-tenants");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${c.name}.json`);
  writeFileSync(file, JSON.stringify({ ...lakeside, policy: { ...lakeside.policy, ...c.policy } }));
  return ["--tenant", file];
}

function replay(c: Case): Result {
  const args = [
    TSX,
    "src/cli/main.ts",
    "replay",
    c.capability,
    ...tenantVariant(c),
    ...(c.flags ?? []),
  ];
  for (const [name, value] of Object.entries(c.inputs)) args.push("--input", `${name}=${value}`);
  // No shell: inputs reach the CLI as argv entries, never as an interpolated string.
  const child = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  try {
    return JSON.parse(child.stdout) as Result;
  } catch {
    throw new Error(`CLI exited ${child.status} without a result:\n${child.stderr}`);
  }
}

function check(expected: Expected, result: Result): boolean {
  const detail = result.outcome?.code ?? result.failure?.category;
  return (
    result.status === expected.status &&
    (expected.detail === undefined || detail === expected.detail) &&
    (expected.recovery === undefined ||
      result.recoveries.some((r) => r.condition === expected.recovery))
  );
}

const describe = (e: Expected) =>
  [e.status, e.detail, e.recovery && `+${e.recovery}`].filter(Boolean).join(" ");

try {
  await fetch(APP);
} catch {
  console.error(`The demo app is not reachable at ${APP}. Start it with \`pnpm app\` first.`);
  process.exit(2);
}

console.log(
  "E1 (real model discovery) and E7 (needs a person at the keyboard) are not regenerated here;" +
    " evidence/README.md lists how they were produced.\n",
);

let mismatches = 0;

for (const c of CASES) {
  const label = `${c.scenario}  ${c.name}`;
  const skip = skipReason(c);
  if (skip) {
    console.log(`${label}  expected ${describe(c.expected)}  SKIPPED: ${skip}`);
    continue;
  }
  await admin("/__admin/reset");
  if (c.faults) await admin("/__admin/faults", c.faults);
  let result: Result;
  try {
    result = replay(c);
  } finally {
    await admin("/__admin/reset");
  }
  // Only this case's folder is replaced: a skipped case keeps its committed evidence.
  const target = join(ROOT, "evidence", c.scenario, c.name);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(ROOT, "runs", result.runId), target, {
    recursive: true,
  });
  const ok = check(c.expected, result);
  if (!ok) mismatches++;
  const actual = describe({
    status: result.status,
    detail: result.outcome?.code ?? result.failure?.category,
    recovery: result.recoveries.map((r) => r.condition).join(",") || undefined,
  });
  console.log(
    `${label}  expected ${describe(c.expected)}  actual ${actual}  ${result.runId}  ${ok ? "OK" : "MISMATCH"}`,
  );
}

process.exit(mismatches ? 1 : 0);
