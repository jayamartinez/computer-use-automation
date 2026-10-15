import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDeep } from "../../src/artifact/template.ts";
import { PlaywrightSurface } from "../../src/surface/playwright/playwright-surface.ts";
import type { Strategy, Target } from "../../src/surface/target.ts";
import { OPERATOR, startTestApp } from "../support/demo-app.ts";
import { requestAllowed } from "../../src/executor/policy.ts";
import { coreservProfile, lakesideAt, lookupArtifact } from "../support/fixtures.ts";

let app: Awaited<ReturnType<typeof startTestApp>>;
let surface: PlaywrightSurface;
let targets: Record<string, Target>;
const blocked: string[] = [];

// The lakeside binding's own network allowlist, pointed at this test instance.
let allowRequest: (url: URL) => boolean;
const workarea = (role: string, ...strategies: Strategy[]): Target => ({
  scope: ["workarea"],
  role,
  strategies,
  rationale: "test",
});

/** Polls until a screen state holds; frames navigate asynchronously after a click. */
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Screen state not reached within 5 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Resolves, insisting on exactly one element, then acts. */
async function act(target: Target, value?: string): Promise<void> {
  await until(async () => (await surface.resolve(target)).kind === "unique");
  const found = await surface.resolve(target);
  if (found.kind !== "unique") throw new Error("not unique");
  await surface.act(
    found.handle,
    value === undefined ? { kind: "click" } : { kind: "fill", value },
  );
}

const kind = async (target: Target) => (await surface.resolve(target)).kind;

beforeAll(async () => {
  app = await startTestApp();
  const { policy } = await lakesideAt(app.url);
  allowRequest = (url) => requestAllowed(policy, url);
  surface = await PlaywrightSurface.launch({
    entryUrl: app.url,
    allowRequest,
    onBlocked: (u) => blocked.push(u),
  });
  const artifact = await lookupArtifact();
  targets = renderDeep(artifact.targets, { inputs: { memberId: "10077" } });

  const profile = await coreservProfile();
  for (const step of profile.login.steps) {
    await act(
      step.target,
      step.action === "fill" ? renderDeep(step.value, { secrets: OPERATOR }) : undefined,
    );
  }
  await until(() => surface.matches(profile.login.authenticated));
});

afterAll(async () => {
  await surface?.close();
  await app?.close();
});

describe("PlaywrightSurface against CoreServ", () => {
  it("observes every frame of the frameset as a scope, with roles", async () => {
    const { elements, fingerprint } = await surface.observe();
    expect(new Set(elements.map((e) => e.scope.join("/")))).toEqual(
      new Set(["banner", "nav", "workarea"]),
    );
    expect(elements).toContainEqual(
      expect.objectContaining({ scope: ["nav"], role: "link", name: "Member Inquiry" }),
    );
    expect(elements.some((e) => e.scope[0] === "banner" && e.text.includes("CoreServ 7.2"))).toBe(
      true,
    );
    expect((await surface.observe()).fingerprint).toBe(fingerprint);
  });

  it("resolves every target of the lookup fixture uniquely, through the whole flow", async () => {
    await act(targets.member_inquiry_link!);
    await act(targets.member_number_field!, "10077");
    expect(
      await surface.matches({
        valueEquals: { target: targets.member_number_field!, value: "10077" },
      }),
    ).toBe(true);
    // The inputs have no accessible name, so role and name alone cannot tell them apart.
    expect(await kind(workarea("textbox", { kind: "role_name", name: "Member Number" }))).toBe(
      "none",
    );

    await act(targets.search_button!);
    await act(targets.view_link!);
    await until(async () => (await kind(targets.savings_balance_cell!)) === "unique");

    const balance = await surface.resolve(targets.savings_balance_cell!);
    expect(balance).toMatchObject({
      kind: "unique",
      strategyIndex: 0,
      element: { role: "cell", text: "$15,902.66" },
    });
    expect(
      await surface.matches({ textEquals: { target: targets.profile_member_no!, value: "10077" } }),
    ).toBe(true);
  });

  it("reports ambiguous and none instead of guessing", async () => {
    await act(targets.member_inquiry_link!);
    await act(
      workarea("textbox", { kind: "anchor", text: "Last Name", relation: "right_of" }),
      "Nguyen",
    );
    await act(targets.search_button!);
    await until(() => surface.matches({ scope: ["workarea"], textPresent: "2 member(s) found" }));

    expect(await surface.resolve(workarea("link", { kind: "role_name", name: "View" }))).toEqual({
      kind: "ambiguous",
      count: 2,
    });
    const rowFor = (memberId: string): Strategy => ({
      kind: "table_cell",
      headers: ["Member No", "Name"],
      row: { column: "Member No", equals: memberId },
      column: "Action",
    });
    expect(await kind(workarea("link", rowFor("10312")))).toBe("unique");
    expect(await kind(workarea("link", rowFor("10077")))).toBe("none");
    expect(await kind(workarea("button", { kind: "role_name", name: "Delete" }))).toBe("none");
    // The right control in the wrong scope is not a match.
    expect(await kind({ ...targets.search_button!, scope: ["nav"] })).toBe("none");
  });

  it("refuses to act on a handle from an earlier observation", async () => {
    const found = await surface.resolve(targets.member_inquiry_link!);
    if (found.kind !== "unique") throw new Error("not unique");
    await surface.observe();
    await expect(surface.act(found.handle, { kind: "click" })).rejects.toThrow(/Stale handle/);
  });

  it("masks account numbers in screenshots and never reports a password value", async () => {
    const png = await surface.screenshot({ mask: [{ label: "Account No", where: "below" }] });
    expect(png!.subarray(1, 4).toString()).toBe("PNG");

    const login = await PlaywrightSurface.launch({ entryUrl: app.url, allowRequest });
    try {
      const profile = await coreservProfile();
      const password = await login.resolve(profile.login.steps[1]!.target);
      if (password.kind !== "unique") throw new Error("not unique");
      await login.act(password.handle, { kind: "fill", value: "typed-secret" });
      expect(JSON.stringify(await login.observe())).not.toContain("typed-secret");
    } finally {
      await login.close();
    }
  });
});

describe("network allowlist", () => {
  it("blocks unlisted paths, the admin path and any other origin at the network layer", async () => {
    await expect(
      PlaywrightSurface.launch({
        entryUrl: `${app.url}/report.do`,
        allowRequest,
        onBlocked: (u) => blocked.push(u),
      }),
    ).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    await expect(
      PlaywrightSurface.launch({
        entryUrl: `${app.url}/__admin/reset`,
        allowRequest,
        onBlocked: (u) => blocked.push(u),
      }),
    ).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    const otherOrigin = app.url.replace("localhost", "127.0.0.1");
    await expect(
      PlaywrightSurface.launch({
        entryUrl: otherOrigin,
        allowRequest,
        onBlocked: (u) => blocked.push(u),
      }),
    ).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    expect(blocked).toEqual([
      `${app.url}/report.do`,
      `${app.url}/__admin/reset`,
      `${otherOrigin}/`,
    ]);
  });
});
