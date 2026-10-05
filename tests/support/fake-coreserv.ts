import { FakeSurface, type FakeElement } from "../../src/surface/fake/fake-surface.ts";

type State = { screen: "menu" | "inquiry" | "results" | "profile"; typed: string; member: string };

export type FakeCoreServOptions = {
  /** Savings balance text per member number. */
  balances: Record<string, string>;
  /** Member number the profile screen displays, when it should differ from the one opened. */
  profileShows?: string;
  /** Extra elements per screen, for building ambiguous or drifted screens. */
  extra?: Partial<Record<State["screen"], FakeElement[]>>;
};

const at = (
  frame: string[],
  role: string,
  text: string,
  x: number,
  y: number,
  value?: string,
): FakeElement => ({
  frame,
  role,
  name: text,
  text,
  ...(value === undefined ? {} : { value }),
  bounds: { x, y, width: 90, height: 20 },
});

const W = ["workarea"];

/** The lookup flow of CoreServ as a state machine, already signed in. */
export function fakeCoreServ(options: FakeCoreServOptions): FakeSurface<State> {
  const screens: Record<State["screen"], (state: State) => FakeElement[]> = {
    menu: () => [at(W, "text", "Main Menu", 0, 0)],
    inquiry: (state) => [
      at(W, "text", "Member Number", 0, 0),
      { ...at(W, "textbox", "", 100, 0, state.typed), name: "" },
      at(W, "button", "Search", 100, 60),
    ],
    results: (state) =>
      state.member in options.balances
        ? [
            at(W, "text", "Member No", 0, 0),
            at(W, "text", "Name", 100, 0),
            at(W, "text", "Action", 200, 0),
            at(W, "text", state.member, 0, 30),
            at(W, "link", "View", 200, 30),
          ]
        : [at(W, "text", "No members match the search criteria.", 0, 0)],
    profile: (state) => [
      at(W, "text", "Member No", 0, 0),
      at(W, "cell", options.profileShows ?? state.member, 100, 0),
      at(W, "text", "Type", 0, 100),
      at(W, "text", "Balance", 100, 100),
      at(W, "text", "Checking", 0, 130),
      at(W, "cell", "$1.00", 100, 130),
      at(W, "text", "Savings", 0, 160),
      at(W, "cell", options.balances[state.member] ?? "", 100, 160),
    ],
  };

  return new FakeSurface<State>({
    initial: { screen: "menu", typed: "", member: "" },
    render: (state) => [
      at(["nav"], "link", "Member Inquiry", 0, 0),
      at(["nav"], "text", "Member Inquiry", 0, 0),
      ...screens[state.screen](state),
      ...(options.extra?.[state.screen] ?? []),
    ],
    reduce: (state, element, action) => {
      if (action.kind === "fill") return { ...state, typed: action.value };
      if (action.kind !== "click") return state;
      if (element.name === "Member Inquiry") return { ...state, screen: "inquiry", typed: "" };
      if (element.name === "Search") return { ...state, screen: "results", member: state.typed };
      if (element.name === "View") return { ...state, screen: "profile" };
      return state;
    },
  });
}

export const fakeElement = at;
