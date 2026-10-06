export type Controller = "automation" | "human" | "none";

/**
 * Who owns the session. The epoch increments on every transfer, and an action carries the
 * epoch it was planned under, so nothing planned before a handoff can run after it.
 */
export class ControlState {
  controller: Controller = "automation";
  epoch = 0;

  transfer(to: Controller): void {
    this.controller = to;
    this.epoch += 1;
  }
}
