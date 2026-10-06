import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR, startTestApp } from "../support/demo-app.ts";

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

/** A minimal HTTP operator: keeps the session cookie and follows the page's own links. */
async function session() {
  let cookie = "";
  const get = async (path: string, body?: Record<string, string>) => {
    const response = await fetch(`${app.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(body ? { body: new URLSearchParams(body).toString() } : {}),
      redirect: "manual",
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return { status: response.status, html: await response.text() };
  };
  const links = (html: string): string[] =>
    [...html.matchAll(/\/cs\.do\?act=[0-9a-f]+/g)].map((m) => m[0]);
  return { get, links };
}

async function signedIn() {
  const s = await session();
  const login = await s.get("/");
  await s.get(s.links(login.html)[0]!, { f1: OPERATOR.operatorId, f2: OPERATOR.password });
  const [banner, nav, workarea] = s.links((await s.get("/")).html);
  return { ...s, banner: banner!, nav: nav!, workarea: workarea! };
}

async function search(s: Awaited<ReturnType<typeof signedIn>>, form: Record<string, string>) {
  const inquiry = await s.get(s.links((await s.get(s.nav)).html)[1]!);
  return s.get(s.links(inquiry.html)[0]!, form);
}

describe("CoreServ demo app", () => {
  it("rejects a wrong password and serves nothing behind the login", async () => {
    const s = await session();
    const login = await s.get("/");
    const denied = await s.get(s.links(login.html)[0]!, { f1: OPERATOR.operatorId, f2: "wrong" });
    expect(denied.html).toContain("Invalid operator ID or password");
    expect((await s.get("/")).html).toContain("Operator Sign In");
  });

  it("serves a three-frame shell whose URLs do not reveal state", async () => {
    const a = await signedIn();
    const b = await signedIn();
    const shell = (await a.get("/")).html;
    expect(shell).toMatch(
      /<frame name="banner"[\s\S]*<frame name="nav"[\s\S]*<frame name="workarea"/,
    );
    expect((await a.get(a.banner)).html).toContain("CoreServ 7.2");
    // The same screen has a different opaque URL in every session and on every render.
    expect(a.nav).not.toBe(b.nav);
    expect(a.links(shell)).not.toContain(a.nav);
    // Another session's token is meaningless here.
    expect((await a.get(b.nav)).html).toContain("no longer available");
  });

  it("looks up members and shows their balances", async () => {
    const s = await signedIn();
    for (const [memberId, savings] of [
      ["10042", "$2,480.17"],
      ["10077", "$15,902.66"],
    ] as const) {
      const results = await search(s, { f1: memberId, f2: "" });
      expect(results.html).toContain(memberId);
      const profile = await s.get(s.links(results.html)[0]!);
      expect(profile.html).toContain("Member Profile");
      expect(profile.html).toContain(savings);
    }
  });

  it("shows the two business outcomes of the lookup flow", async () => {
    const s = await signedIn();
    expect((await search(s, { f1: "99999", f2: "" })).html).toContain("No members match");
    const restricted = await search(s, { f1: "10200", f2: "" });
    expect((await s.get(s.links(restricted.html)[0]!)).html).toContain("Access restricted");
    expect((await search(s, { f1: "", f2: "nguyen" })).html).toContain("2 member(s) found");
  });

  it("has no ids, labels, test hooks or accessible names in its markup", async () => {
    const s = await signedIn();
    const results = await search(s, { f1: "10077", f2: "" });
    const pages = [
      (await (await session()).get("/")).html,
      (await s.get(s.nav)).html,
      (await s.get(s.links((await s.get(s.nav)).html)[1]!)).html,
      results.html,
      (await s.get(s.links(results.html)[0]!)).html,
    ];
    for (const html of pages) {
      expect(html).not.toMatch(/\sid=|<label|data-test|aria-|placeholder=|title=|<th[\s>]|class=/i);
    }
  });

  it("fires each screen fault once, on the screen it was armed for", async () => {
    const arm = (faults: object) =>
      fetch(`${app.url}/__admin/faults`, { method: "POST", body: JSON.stringify(faults) });
    const s = await signedIn();
    const inquiryLink = () => s.get(s.nav).then(({ html }) => s.links(html)[1]!);

    // Notice: shown instead of the search results; Acknowledge continues with the same form.
    await arm({ notice: "search" });
    const inquiry = await s.get(await inquiryLink());
    expect(inquiry.html).toContain("Member Number");
    const notice = await s.get(s.links(inquiry.html)[0]!, { f1: "10077", f2: "" });
    expect(notice.html).toContain("System Notice");
    expect(notice.html).toContain('value="Acknowledge"');
    const continued = await s.get(s.links(notice.html)[0]!, {});
    expect(continued.html).toContain("1 member(s) found");

    // Application error: an HTTP 500 page, once.
    await arm({ error500: "inquiry" });
    const error = await s.get(await inquiryLink());
    expect(error.status).toBe(500);
    expect(error.html).toContain("Application Error");
    expect((await s.get(await inquiryLink())).html).toContain("Member Number");

    // Session expiry: every later request shows the expired page until the operator signs in.
    await arm({ expireSession: "inquiry" });
    const nav = s.nav;
    const expired = await s.get(s.links((await s.get(nav)).html)[1]!);
    expect(expired.html).toContain("Your session has expired");
    expect(expired.html).toContain('href="/" target="_top">Sign in again');
    expect((await s.get(nav)).html).toContain("Your session has expired");
    const login = await s.get("/");
    expect(login.html).toContain("Operator Sign In");
    await s.get(s.links(login.html)[0]!, { f1: OPERATOR.operatorId, f2: OPERATOR.password });
    expect((await s.get("/")).html).toContain('<frame name="workarea"');
  });

  it("injects latency through the faults endpoint and validates what it is given", async () => {
    const faults = (body: string) => fetch(`${app.url}/__admin/faults`, { method: "POST", body });
    expect((await faults('{"latencyMs": 250}')).status).toBe(200);
    const started = Date.now();
    await fetch(`${app.url}/`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    for (const bad of [
      "nope",
      '{"latencyMs": -1}',
      '{"latencyMs": 1.5}',
      '{"other": 1}',
      "[]",
      '{"notice": "banner"}',
      '{"error500": true}',
    ]) {
      expect((await faults(bad)).status).toBe(400);
    }
    expect(await (await faults('{"latencyMs": 0}')).json()).toEqual({ latencyMs: 0 });
  });

  it("resets through the admin endpoint", async () => {
    const s = await signedIn();
    expect((await fetch(`${app.url}/__admin/reset`, { method: "POST" })).status).toBe(200);
    expect((await s.get("/")).html).toContain("Operator Sign In");
  });
});
