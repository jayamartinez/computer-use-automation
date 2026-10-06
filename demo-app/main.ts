import { existsSync } from "node:fs";
import { startCoreServ } from "./server.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const operatorId = process.env.CORESERV_OPERATOR_ID;
const password = process.env.CORESERV_OPERATOR_PASSWORD;
const supervisorCode = process.env.CORESERV_SUPERVISOR_CODE;
if (!operatorId || !password || !supervisorCode) {
  console.error(
    "Set CORESERV_OPERATOR_ID, CORESERV_OPERATOR_PASSWORD and CORESERV_SUPERVISOR_CODE " +
      "(copy .env.example to .env).",
  );
  process.exit(1);
}

const app = await startCoreServ({
  port: Number(process.env.CORESERV_PORT ?? 4070),
  operatorId,
  password,
  supervisorCode,
});
console.log(`CoreServ 7.2 demo app listening on ${app.url}`);
