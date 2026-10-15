import { makeObservation } from "../observation.ts";
import { firstMatching, matchesSignature, resolveTarget } from "../resolve.ts";
import type { Target } from "../target.ts";
import type {
  Handle,
  HumanAction,
  Observation,
  ObservedElement,
  Resolution,
  Signature,
  Surface,
  SurfaceAction,
} from "../types.ts";

export type FakeElement = Omit<ObservedElement, "ref">;

export type FakeApp<State> = {
  initial: State;
  render: (state: State) => FakeElement[];
  /** Returns the next state, or the same state when the action changes nothing. */
  reduce: (state: State, element: FakeElement, action: SurfaceAction) => State;
};

/**
 * An in-memory surface: a state, a function that renders it to elements and a reducer. It
 * shares target resolution with the real surface, so it tests the interpreter and executor
 * without a browser and shows the seam holds for something that is not a web page.
 */
export class FakeSurface<State> implements Surface {
  readonly actions: { element: FakeElement; action: SurfaceAction }[] = [];
  private state: State;
  private current: Observation | undefined;

  constructor(private readonly app: FakeApp<State>) {
    this.state = app.initial;
  }

  async observe(): Promise<Observation> {
    const elements = this.app.render(this.state).map((e, i) => ({ ...e, ref: `e${i + 1}` }));
    this.current = makeObservation(elements);
    return this.current;
  }

  async resolve(target: Target): Promise<Resolution> {
    const observation = await this.observe();
    const found = resolveTarget(observation.elements, target);
    if (found.kind !== "unique") return found;
    return { ...found, handle: { observationId: observation.id, ref: found.element.ref } };
  }

  async act(handle: Handle, action: SurfaceAction): Promise<void> {
    const element = this.current?.elements.find((e) => e.ref === handle.ref);
    if (handle.observationId !== this.current?.id || !element) throw new Error("Stale handle");
    this.actions.push({ element, action });
    this.state = this.app.reduce(this.state, element, action);
  }

  async matches(signature: Signature): Promise<boolean> {
    return matchesSignature(await this.observe(), signature);
  }

  async firstMatch(signatures: Signature[]): Promise<number | undefined> {
    return firstMatching(await this.observe(), signatures);
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from("fake-surface");
  }

  private humanListener: ((action: HumanAction) => void) | undefined;
  /** What a person did, recorded apart from `actions`, which are automation's. */
  readonly humanActions: { element: FakeElement; action: SurfaceAction }[] = [];

  async watchHuman(listener: (action: HumanAction) => void): Promise<() => Promise<void>> {
    this.humanListener = listener;
    return async () => {
      if (this.humanListener === listener) this.humanListener = undefined;
    };
  }

  /**
   * A scripted person acting on the same session, outside the guarded executor, as a real
   * operator would. The value typed is applied but never reported.
   */
  async actAsHuman(target: Target, action: SurfaceAction): Promise<void> {
    const found = resolveTarget((await this.observe()).elements, target);
    if (found.kind !== "unique") throw new Error(`Human could not find ${JSON.stringify(target)}`);
    const { ref: _ref, ...element } = found.element;
    this.humanActions.push({ element, action });
    this.humanListener?.({
      kind: action.kind === "click" ? "click" : "change",
      role: element.role,
      name: element.name,
      scope: element.scope,
    });
    this.state = this.app.reduce(this.state, element, action);
  }
}
