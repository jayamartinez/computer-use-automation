// CoreServ 7.2: a fake legacy core-banking back office. Standalone; never imports from src/.
//
// Every screen is served from /cs.do?act=<token>. Tokens are random and minted per session, so
// a URL says nothing about which screen it leads to.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { seedMembers, type Member } from "./data.ts";
import * as pages from "./pages.ts";

export type CoreServConfig = { port: number; operatorId: string; password: string };

type Action =
  | { screen: "login" }
  | { screen: "banner" }
  | { screen: "nav" }
  | { screen: "main_menu" }
  | { screen: "inquiry" }
  | { screen: "search" }
  | { screen: "profile"; memberId: string }
  | { screen: "acknowledge"; then: Action; form: string };

type Session = { authenticated: boolean; expired: boolean; actions: Map<string, Action> };

// Server-side fault injection, set through the admin endpoint. Each screen fault is armed on a
// workarea screen and fires once, on the next request for that screen, so every scenario
// reproduces exactly. A clock-based session expiry would not: the re-login pass would expire
// again at a different step on every run.
const WORKAREA_SCREENS = ["main_menu", "inquiry", "search", "profile"] as const;
type WorkareaScreen = (typeof WORKAREA_SCREENS)[number];
const SCREEN_FAULTS = ["notice", "expireSession", "error500"] as const;
type Faults = { latencyMs: number } & Partial<
  Record<(typeof SCREEN_FAULTS)[number], WorkareaScreen>
>;
const NO_FAULTS: Faults = { latencyMs: 0 };
const MAX_LATENCY_MS = 60_000;

const COOKIE = "CSSESSION";

export async function startCoreServ(
  config: CoreServConfig,
): Promise<{ url: string; close: () => Promise<void> }> {
  let members: Member[] = seedMembers();
  let faults: Faults = NO_FAULTS;
  const sessions = new Map<string, Session>();

  const link = (session: Session, action: Action): string => {
    const token = randomBytes(8).toString("hex");
    session.actions.set(token, action);
    return `/cs.do?act=${token}`;
  };

  const render = (session: Session, action: Action, form: URLSearchParams): string => {
    switch (action.screen) {
      case "login":
        return pages.loginPage(link(session, { screen: "login" }));
      case "banner":
        return pages.bannerPage(config.operatorId);
      case "nav":
        return pages.navPage({
          mainMenu: link(session, { screen: "main_menu" }),
          memberInquiry: link(session, { screen: "inquiry" }),
        });
      case "main_menu":
        return pages.mainMenuPage(config.operatorId);
      case "inquiry":
        return pages.inquiryPage(link(session, { screen: "search" }));
      case "search": {
        const memberNo = (form.get("f1") ?? "").trim();
        const lastName = (form.get("f2") ?? "").trim().toLowerCase();
        if (!memberNo && !lastName) {
          return pages.inquiryPage(
            link(session, { screen: "search" }),
            "Enter a member number or a last name.",
          );
        }
        const found = members.filter((m) =>
          memberNo ? m.id === memberNo : m.lastName.toLowerCase() === lastName,
        );
        return pages.resultsPage(
          found.map((member) => ({
            member,
            view: link(session, { screen: "profile", memberId: member.id }),
          })),
        );
      }
      case "profile": {
        const member = members.find((m) => m.id === action.memberId);
        if (!member) return pages.messagePage("Member Profile", "Member record not available.");
        if (member.restricted) {
          return pages.messagePage(
            "Member Profile",
            "Access restricted. Employee accounts require Member Services authorization.",
          );
        }
        return pages.profilePage(member);
      }
      case "acknowledge":
        return render(session, action.then, new URLSearchParams(action.form));
    }
  };

  /** Fires a fault armed on this screen, once. Returns the page shown instead, if any. */
  const interrupt = (
    session: Session,
    action: Action,
    form: URLSearchParams,
  ): { status: number; body: string } | undefined => {
    const fire = (fault: (typeof SCREEN_FAULTS)[number]): boolean => {
      if (faults[fault] !== action.screen) return false;
      faults = { ...faults, [fault]: undefined };
      return true;
    };
    if (fire("expireSession")) {
      session.authenticated = false;
      session.expired = true;
      return { status: 200, body: pages.sessionExpiredPage() };
    }
    if (fire("error500")) {
      const reference = randomBytes(4).toString("hex").toUpperCase();
      return {
        status: 500,
        body: pages.applicationErrorPage(`${reference.slice(0, 4)}-${reference.slice(4)}`),
      };
    }
    if (fire("notice")) {
      const acknowledge = link(session, {
        screen: "acknowledge",
        then: action,
        form: form.toString(),
      });
      return { status: 200, body: pages.noticePage(acknowledge) };
    }
    return undefined;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://coreserv.local");
    const html = (body: string, status = 200) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
    };

    if (url.pathname === "/__admin/reset" && req.method === "POST") {
      members = seedMembers();
      sessions.clear();
      faults = NO_FAULTS;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url.pathname === "/__admin/faults" && req.method === "POST") {
      const update = parseFaults(await readBody(req));
      if (!update) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(
          `Expected JSON like {"latencyMs": 300} (0 to ${MAX_LATENCY_MS}) or ` +
            `{"notice": "search"}; screen faults take one of ${WORKAREA_SCREENS.join(", ")} or null`,
        );
        return;
      }
      faults = { ...faults, ...update };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(faults));
      return;
    }

    if (faults.latencyMs > 0) await new Promise((r) => setTimeout(r, faults.latencyMs));

    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .find(([name]) => name === COOKIE)?.[1];
    let session = cookie ? sessions.get(cookie) : undefined;
    if (!session) {
      const id = randomBytes(16).toString("hex");
      session = { authenticated: false, expired: false, actions: new Map() };
      sessions.set(id, session);
      res.setHeader("set-cookie", `${COOKIE}=${id}; Path=/; HttpOnly`);
    }

    if (url.pathname === "/") {
      if (!session.authenticated)
        return html(render(session, { screen: "login" }, new URLSearchParams()));
      return html(
        pages.shellPage({
          banner: link(session, { screen: "banner" }),
          nav: link(session, { screen: "nav" }),
          workarea: link(session, { screen: "main_menu" }),
        }),
      );
    }

    if (url.pathname !== "/cs.do") return html(pages.messagePage("CoreServ", "Not found."), 404);

    const action = session.actions.get(url.searchParams.get("act") ?? "");
    const form =
      req.method === "POST" ? new URLSearchParams(await readBody(req)) : new URLSearchParams();

    if (action?.screen === "login") {
      if (form.get("f1") === config.operatorId && form.get("f2") === config.password) {
        session.authenticated = true;
        session.expired = false;
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      return html(
        pages.loginPage(link(session, { screen: "login" }), "Invalid operator ID or password."),
      );
    }
    if (session.expired) return html(pages.sessionExpiredPage());
    if (!session.authenticated || !action) {
      return html(
        pages.messagePage("CoreServ", "This page is no longer available. Sign in again."),
      );
    }
    const shown = interrupt(session, action, form);
    if (shown) return html(shown.body, shown.status);
    return html(render(session, action, form));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error");
    });
  });
  await new Promise<void>((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function parseFaults(body: string): Partial<Faults> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const update: Partial<Faults> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "latencyMs") {
      const valid =
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_LATENCY_MS;
      if (!valid) return undefined;
      update.latencyMs = value;
    } else if ((SCREEN_FAULTS as readonly string[]).includes(key)) {
      // null disarms the fault.
      if (value !== null && !(WORKAREA_SCREENS as readonly unknown[]).includes(value)) {
        return undefined;
      }
      update[key as (typeof SCREEN_FAULTS)[number]] = (value ?? undefined) as WorkareaScreen;
    } else {
      return undefined;
    }
  }
  return update;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
