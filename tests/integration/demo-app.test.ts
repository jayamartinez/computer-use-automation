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

  it("resets through the admin endpoint", async () => {
    const s = await signedIn();
    expect((await fetch(`${app.url}/__admin/reset`, { method: "POST" })).status).toBe(200);
    expect((await s.get("/")).html).toContain("Operator Sign In");
  });
});
