import { FakeSurface, type FakeElement } from "../../src/surface/fake/fake-surface.ts";

type Page = "menu" | "inquiry" | "results" | "profile";
/** Screens the app shows instead of the one requested: the profile's conditions. */
export type Interrupt = "notice" | "expired" | "error" | "override";
type Screen = Page | Interrupt | "login";

type State = {
  screen: Screen;
  typed: string;
  member: string;
  /** Where acknowledging a notice continues to. */
  pending: Page;
  navigations: number;
  readyAt: number;
};

export type FakeCoreServOptions = {
  /** Savings balance text per member number. */
  balances: Record<string, string>;
  /** Members whose profile shows "Access restricted". */
  restricted?: string[];
  /** Member number the profile screen displays, when it should differ from the one opened. */
  profileShows?: string;
  /** Extra elements per screen, for building ambiguous or drifted screens. */
  extra?: Partial<Record<Screen, FakeElement[]>>;
  /** What the n-th workarea navigation (counting from 1) shows instead of the page requested. */
  interrupts?: Record<number, Interrupt>;
  /** How long the workarea stays blank after each navigation. */
  loadMs?: number;
  initial?: Screen;
};

const at = (
  scope: string[],
  role: string,
  text: string,
  x: number,
  y: number,
  value?: string,
): FakeElement => ({
  scope,
  role,
  name: text,
  text,
  ...(value === undefined ? {} : { value }),
  bounds: { x, y, width: 90, height: 20 },
});

const W = ["workarea"];
const field = (scope: string[], x: number, y: number, value: string): FakeElement => ({
  ...at(scope, "textbox", "", x, y, value),
  name: "",
});

/** CoreServ's lookup flow, its sign-in and its interruptions, as a state machine. */
export function fakeCoreServ(options: FakeCoreServOptions): FakeSurface<State> {
  const known = (member: string) =>
    member in options.balances || (options.restricted ?? []).includes(member);

  const screens: Record<Screen, (state: State) => FakeElement[]> = {
    login: () => [
      at([], "text", "Operator ID", 0, 0),
      field([], 100, 0, ""),
      at([], "text", "Password", 0, 30),
      field([], 100, 30, ""),
      at([], "button", "Sign In", 100, 60),
    ],
    menu: () => [at(W, "text", "Main Menu", 0, 0)],
    inquiry: (state) => [
      at(W, "text", "Member Number", 0, 0),
      field(W, 100, 0, state.typed),
      at(W, "button", "Search", 100, 60),
    ],
    results: (state) =>
      known(state.member)
        ? [
            at(W, "text", "Member No", 0, 0),
            at(W, "text", "Name", 100, 0),
            at(W, "text", "Action", 200, 0),
            at(W, "text", state.member, 0, 30),
            at(W, "link", "View", 200, 30),
          ]
        : [at(W, "text", "No members match the search criteria.", 0, 0)],
    profile: (state) =>
      (options.restricted ?? []).includes(state.member)
        ? [at(W, "text", "Access restricted. Employee accounts require authorization.", 0, 0)]
        : [
            at(W, "text", "Member No", 0, 0),
            at(W, "cell", options.profileShows ?? state.member, 100, 0),
            at(W, "text", "Type", 0, 100),
            at(W, "text", "Balance", 100, 100),
            at(W, "text", "Checking", 0, 130),
            at(W, "cell", "$1.00", 100, 130),
            at(W, "text", "Savings", 0, 160),
            at(W, "cell", options.balances[state.member] ?? "", 100, 160),
          ],
    notice: () => [
      at(W, "text", "System Notice", 0, 0),
      at(W, "text", "Scheduled maintenance tonight.", 0, 30),
      at(W, "button", "Acknowledge", 0, 60),
    ],
    expired: () => [
      at(W, "text", "Your session has expired. Sign in again to continue.", 0, 0),
      at(W, "link", "Sign in again", 0, 30),
    ],
    error: () => [at(W, "text", "Application Error", 0, 0)],
    override: () => [at(W, "text", "Supervisor Override Required", 0, 0)],
  };

  const navigate = (state: State, page: Page): State => {
    const navigations = state.navigations + 1;
    const interrupt = options.interrupts?.[navigations];
    return {
      ...state,
      navigations,
      screen: interrupt ?? page,
      pending: page,
      readyAt: Date.now() + (options.loadMs ?? 0),
    };
  };

  return new FakeSurface<State>({
    initial: {
      screen: options.initial ?? "menu",
      typed: "",
      member: "",
      pending: "menu",
      navigations: 0,
      readyAt: 0,
    },
    render: (state) => {
      if (state.screen === "login") return screens.login(state);
      const loading = Date.now() < state.readyAt;
      return [
        at(["nav"], "link", "Member Inquiry", 0, 0),
        at(["nav"], "text", "Member Inquiry", 0, 0),
        ...(loading ? [] : screens[state.screen](state)),
        ...(loading ? [] : (options.extra?.[state.screen] ?? [])),
      ];
    },
    reduce: (state, element, action) => {
      if (action.kind === "fill")
        return state.screen === "login" ? state : { ...state, typed: action.value };
      if (action.kind !== "click") return state;
      switch (element.name) {
        case "Member Inquiry":
          return { ...navigate(state, "inquiry"), typed: "" };
        case "Search":
          return { ...navigate(state, "results"), member: state.typed };
        case "View":
          return navigate(state, "profile");
        case "Acknowledge":
          return navigate(state, state.pending);
        case "Sign in again":
          return { ...state, screen: "login" };
        case "Sign In":
          return { ...state, screen: "menu" };
        default:
          return state;
      }
    },
  });
}

export const fakeElement = at;
