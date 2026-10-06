import { describe, expect, it } from "vitest";
import { RunLog } from "../../src/evidence/run-log.ts";
import { redact } from "../../src/evidence/redact.ts";
import { ControlState } from "../../src/executor/control.ts";
import { GuardedExecutor, type ActionRequest } from "../../src/executor/guarded-executor.ts";
import { checkRequires, requestAllowed } from "../../src/executor/policy.ts";
import type { Policy } from "../../src/profile/schema.ts";
import { FakeSurface } from "../../src/surface/fake/fake-surface.ts";
import { fakeElement } from "../support/fake-coreserv.ts";

const policy: Policy = {
  origins: ["http://localhost:4070"],
  paths: ["/", "/cs.do", "/static/*"],
  scopes: ["workarea"],
  actions: ["click", "fill", "extract"],
  maxRisk: "irreversible",
};

function setup(overrides: Partial<Policy> = {}) {
  const lines: string[] = [];
  const surface = new FakeSurface({
    initial: 0,
    render: () => [
      fakeElement(["workarea"], "button", "Confirm", 0, 0),
      fakeElement(["workarea"], "textbox", "Password", 0, 40, ""),
      fakeElement(["nav"], "link", "Admin", 0, 0),
    ],
    reduce: (state) => state,
  });
  const control = new ControlState();
  const log = new RunLog(
    (line) => lines.push(line),
    [{ value: "hunter2-secret", replacement: "[secret]" }],
  );
  const executor = new GuardedExecutor({
    surface,
    policy: { ...policy, ...overrides },
    control,
    log,
    masks: [],
    runDir: "unused",
  });
  return { executor, surface, control, log, lines };
}

const click = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  epoch: 0,
  stepId: "s1",
  intent: "test",
  action: "click",
  targetName: "confirm",
  target: {
    scope: ["workarea"],
    role: "button",
    strategies: [{ kind: "role_name", name: "Confirm" }],
    rationale: "test",
  },
  risk: "read",
  timeoutMs: 0,
  ...overrides,
});

describe("guarded executor: irreversible dispatch", () => {
  it("logs an irreversible action as dispatched before acting, even if acting throws", async () => {
    const { executor, surface, lines } = setup();
    surface.act = () => Promise.reject(new Error("navigation interrupted\nstack"));
    const result = await executor.perform(click({ risk: "irreversible", approved: true }));
    expect(result).toEqual({ status: "dispatch_error", message: "navigation interrupted" });
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      "dispatch_irreversible",
      "action_error",
    ]);
  });

  it("does not log a dispatch for an irreversible action it refused", async () => {
    const { executor, lines } = setup();
    expect(await executor.perform(click({ risk: "irreversible" }))).toMatchObject({
      status: "denied",
      rule: "irreversible_unapproved",
    });
    expect(lines.join("\n")).not.toContain("dispatch_irreversible");
  });
});

describe("guarded executor", () => {
  it("dispatches an allowed action and logs the decision", async () => {
    const { executor, surface, lines } = setup();
    expect(await executor.perform(click())).toMatchObject({ status: "done", strategyIndex: 0 });
    expect(surface.actions).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "action",
      stepId: "s1",
      policy: "click:read",
    });
  });

  it("denies an action type outside the allowlist before it reaches the surface", async () => {
    const { executor, surface, lines } = setup({ actions: ["extract"] });
    expect(await executor.perform(click())).toMatchObject({
      status: "denied",
      rule: "action_type",
    });
    expect(surface.actions).toHaveLength(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "action_denied", rule: "action_type" });
  });

  it("denies a scope outside the allowlist", async () => {
    const { executor, surface } = setup();
    const target = {
      ...click().target,
      scope: ["nav"],
      role: "link",
      strategies: [{ kind: "role_name" as const, name: "Admin" }],
    };
    expect(await executor.perform(click({ target }))).toMatchObject({
      status: "denied",
      rule: "scope",
    });
    expect(surface.actions).toHaveLength(0);
  });

  it("denies risk above the tenant maximum", async () => {
    const { executor } = setup({ maxRisk: "read" });
    expect(await executor.perform(click({ risk: "reversible" }))).toMatchObject({
      status: "denied",
      rule: "max_risk",
    });
  });

  it("never dispatches an irreversible action without an approval", async () => {
    const { executor, surface } = setup();
    expect(await executor.perform(click({ risk: "irreversible" }))).toMatchObject({
      status: "denied",
      rule: "irreversible_unapproved",
    });
    expect(surface.actions).toHaveLength(0);
    expect(await executor.perform(click({ risk: "irreversible", approved: true }))).toMatchObject({
      status: "done",
    });
  });

  it("refuses an action planned under a stale epoch or while a human has control", async () => {
    const { executor, surface, control } = setup();
    control.transfer("human");
    expect(await executor.perform(click({ epoch: executor.epoch }))).toMatchObject({
      status: "denied",
      rule: "control",
    });
    control.transfer("automation");
    // Planned before the handoff: the epoch has moved on even though automation is back.
    expect(await executor.perform(click({ epoch: 0 }))).toMatchObject({
      status: "denied",
      rule: "control",
    });
    expect(surface.actions).toHaveLength(0);
    expect(await executor.perform(click({ epoch: executor.epoch }))).toMatchObject({
      status: "done",
    });
  });

  it("reports an unresolved target without acting", async () => {
    const { executor, surface } = setup();
    const target = {
      ...click().target,
      strategies: [{ kind: "role_name" as const, name: "Cancel" }],
    };
    expect(await executor.perform(click({ target }))).toEqual({
      status: "unresolved",
      kind: "none",
      count: 0,
    });
    expect(surface.actions).toHaveLength(0);
  });

  it("sends the real value to the surface and only the reference to the log", async () => {
    const { executor, surface, log, lines } = setup();
    await executor.perform(
      click({
        action: "fill",
        target: {
          ...click().target,
          role: "textbox",
          strategies: [{ kind: "role_name", name: "Password" }],
        },
        risk: "reversible",
        value: { actual: "hunter2-secret", logged: "{{secrets.password}}" },
      }),
    );
    expect(surface.actions[0]?.action).toEqual({ kind: "fill", value: "hunter2-secret" });
    // The backstop: a secret that reaches a log line some other way is still scrubbed.
    log.write("error", { message: "login failed for hunter2-secret", nested: ["hunter2-secret"] });
    expect(lines.join("\n")).not.toContain("hunter2-secret");
    expect(lines.join("\n")).toContain("{{secrets.password}}");
  });
});

describe("policy preflight and redaction", () => {
  it("rejects a capability from its declared requirements", () => {
    const requires = {
      actions: ["click" as const, "select" as const],
      maxRisk: "read" as const,
      scopes: ["workarea"],
    };
    expect(checkRequires(policy, requires)).toMatchObject({
      decision: "deny",
      rule: "action_type",
    });
    expect(
      checkRequires(policy, { ...requires, actions: ["click"], scopes: ["nav"] }),
    ).toMatchObject({ rule: "scope" });
    expect(
      checkRequires(
        { ...policy, maxRisk: "read" },
        { ...requires, actions: ["click"], maxRisk: "reversible" },
      ),
    ).toMatchObject({ rule: "max_risk" });
    expect(checkRequires(policy, { ...requires, actions: ["click"] }).decision).toBe("allow");
  });

  it("allows a request only when both its origin and its path are listed", () => {
    const allowed = (url: string) => requestAllowed(policy, new URL(url));
    expect(allowed("http://localhost:4070/")).toBe(true);
    expect(allowed("http://localhost:4070/cs.do?act=8f2a")).toBe(true);
    expect(allowed("http://localhost:4070/static/app.css")).toBe(true);
    // Fail closed: anything not listed is blocked, not just what someone thought to deny.
    expect(allowed("http://localhost:4070/__admin/reset")).toBe(false);
    expect(allowed("http://localhost:4070/favicon.ico")).toBe(false);
    expect(allowed("http://localhost:4070/cs.do/extra")).toBe(false);
    expect(allowed("http://localhost:4071/cs.do")).toBe(false);
    expect(allowed("http://127.0.0.1:4070/cs.do")).toBe(false);
  });

  it("masks by sensitivity", () => {
    expect(redact("10077", "none")).toBe("10077");
    expect(redact("10077", "identifier")).toBe("***77");
    expect(redact("4000-10077-01", "account_number")).toBe("***01");
    expect(redact("15902.66 USD", "financial")).toBe("[financial]");
  });
});
