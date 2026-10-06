import { startCoreServ } from "../../demo-app/server.ts";

export const OPERATOR = { operatorId: "teller01", password: "synthetic-test-pass-7" };
/** Known to the app and to the scripted supervisor in tests; never given to the automation. */
export const SUPERVISOR = { id: "sup02", code: "synthetic-override-4410" };

/** A private instance of the demo app on a free port. */
export const startTestApp = () =>
  startCoreServ({ port: 0, ...OPERATOR, supervisorCode: SUPERVISOR.code });
