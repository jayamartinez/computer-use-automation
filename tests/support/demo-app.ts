import { startCoreServ } from "../../demo-app/server.ts";

export const OPERATOR = { operatorId: "teller01", password: "synthetic-test-pass-7" };

/** A private instance of the demo app on a free port. */
export const startTestApp = () => startCoreServ({ port: 0, ...OPERATOR });
