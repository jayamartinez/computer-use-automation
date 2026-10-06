// CoreServ 7.2 page rendering. Deliberately legacy markup: nested layout tables, <font> tags,
// header cells that are bold <td>s, and no ids, labels or test hooks. Every link and form
// target is an opaque per-session token supplied by the caller.

import { formatMoney, type Member } from "./data.ts";

export function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const FONT = 'face="Arial, Helvetica" size="2"';

function page(title: string, body: string, bgcolor = "#FFFFFF"): string {
  return `<html><head><title>${esc(title)}</title></head>
<body bgcolor="${bgcolor}" text="#000000" link="#000080" vlink="#000080">
${body}
</body></html>`;
}

function workarea(heading: string, content: string, titleColor = "#000080"): string {
  return page(
    heading,
    `<table width="100%" border="0" cellpadding="4" cellspacing="0">
<tr><td bgcolor="${titleColor}"><font ${FONT} color="#FFFFFF"><b>${esc(heading)}</b></font></td></tr>
<tr><td>${content}</td></tr>
</table>`,
  );
}

export function loginPage(action: string, error?: string): string {
  return page(
    "CoreServ Sign In",
    `<center><br><br>
<table border="1" cellpadding="6" cellspacing="0" bgcolor="#FFFFFF">
<tr><td bgcolor="#000080"><font ${FONT} color="#FFFFFF"><b>CoreServ 7.2 Operator Sign In</b></font></td></tr>
<tr><td>
${error ? `<font ${FONT} color="#CC0000">${esc(error)}</font>` : ""}
<form method="post" action="${action}">
<table border="0" cellpadding="3" cellspacing="0">
<tr><td><font ${FONT}>Operator ID</font></td><td><input type="text" name="f1" size="16"></td></tr>
<tr><td><font ${FONT}>Password</font></td><td><input type="password" name="f2" size="16"></td></tr>
<tr><td colspan="2" align="right"><input type="submit" value="Sign In"></td></tr>
</table>
</form>
</td></tr>
</table>
<br><font ${FONT}>Authorized use only. Activity is recorded.</font>
</center>`,
    "#C0C0C0",
  );
}

export function shellPage(frames: { banner: string; nav: string; workarea: string }): string {
  return `<html><head><title>CoreServ</title></head>
<frameset rows="44,*" border="1">
<frame name="banner" src="${frames.banner}" scrolling="no" noresize>
<frameset cols="170,*" border="1">
<frame name="nav" src="${frames.nav}">
<frame name="workarea" src="${frames.workarea}">
</frameset>
</frameset>
</html>`;
}

export function bannerPage(operatorId: string): string {
  return page(
    "Banner",
    `<table width="100%" border="0" cellpadding="2" cellspacing="0"><tr>
<td><font ${FONT} color="#FFFFFF"><b>CoreServ 7.2</b> &nbsp; Lakeside CU</font></td>
<td align="right"><font ${FONT} color="#FFFFFF">Operator: ${esc(operatorId)}</font></td>
</tr></table>`,
    "#000080",
  );
}

export function navPage(links: { mainMenu: string; memberInquiry: string }): string {
  return page(
    "Navigation",
    `<table border="0" cellpadding="4" cellspacing="0">
<tr><td><font ${FONT}><b>Functions</b></font></td></tr>
<tr><td><font ${FONT}><a href="${links.mainMenu}" target="workarea">Main Menu</a></font></td></tr>
<tr><td><font ${FONT}><a href="${links.memberInquiry}" target="workarea">Member Inquiry</a></font></td></tr>
</table>`,
    "#D4D0C8",
  );
}

export function mainMenuPage(operatorId: string): string {
  return workarea(
    "Main Menu",
    `<font ${FONT}>Welcome, ${esc(operatorId)}. Select a function from the list on the left.</font>
<br><br>
<table border="1" cellpadding="3" cellspacing="0">
<tr><td bgcolor="#D4D0C8"><font ${FONT}><b>Bulletin</b></font></td></tr>
<tr><td><font ${FONT}>Month-end processing begins at 6:00 PM. Post all batches before then.</font></td></tr>
</table>`,
  );
}

export function inquiryPage(action: string, message?: string): string {
  return workarea(
    "Member Inquiry",
    `${message ? `<font ${FONT} color="#CC0000">${esc(message)}</font><br>` : ""}
<form method="post" action="${action}">
<table border="0" cellpadding="3" cellspacing="0">
<tr><td><font ${FONT}>Member Number</font></td><td><input type="text" name="f1" size="12" maxlength="10"></td></tr>
<tr><td><font ${FONT}>Last Name</font></td><td><input type="text" name="f2" size="24"></td></tr>
<tr><td>&nbsp;</td><td><input type="submit" value="Search"> <input type="reset" value="Clear"></td></tr>
</table>
</form>`,
  );
}

export function resultsPage(rows: { member: Member; view: string }[]): string {
  if (rows.length === 0) {
    return workarea(
      "Member Inquiry Results",
      `<font ${FONT}>No members match the search criteria.</font>`,
    );
  }
  const header = ["Member No", "Name", "Status", "Action"]
    .map((h) => `<td bgcolor="#D4D0C8"><font ${FONT}><b>${h}</b></font></td>`)
    .join("");
  const body = rows
    .map(
      ({ member, view }) => `<tr>
<td><font ${FONT}>${member.id}</font></td>
<td><font ${FONT}>${esc(`${member.lastName}, ${member.firstName}`)}</font></td>
<td><font ${FONT}>${esc(member.status)}</font></td>
<td><font ${FONT}><a href="${view}">View</a></font></td>
</tr>`,
    )
    .join("\n");
  return workarea(
    "Member Inquiry Results",
    `<font ${FONT}>${rows.length} member(s) found.</font><br><br>
<table border="1" cellpadding="3" cellspacing="0">
<tr>${header}</tr>
${body}
</table>`,
  );
}

export function profilePage(member: Member, openSubAccount: string): string {
  const accounts = member.accounts
    .map(
      (a) => `<tr>
${valueCell(a.number)}${valueCell(a.type)}
<td align="right"><font ${FONT}>${formatMoney(a.balanceCents)}</font></td>
${valueCell(a.opened)}
</tr>`,
    )
    .join("\n");
  return workarea(
    "Member Profile",
    `<table border="0" cellpadding="0" cellspacing="8">
<tr><td>
${memberHeader(member)}
</td></tr>
<tr><td>
<font ${FONT}><b>Accounts</b></font><br>
<table border="1" cellpadding="3" cellspacing="0">
<tr>${["Account No", "Type", "Balance", "Opened"].map(labelCell).join("")}</tr>
${accounts}
</table>
</td></tr>
<tr><td>
<form method="post" action="${openSubAccount}"><input type="submit" value="Open Sub-Account"></form>
</td></tr>
</table>`,
  );
}

const labelCell = (text: string) =>
  `<td bgcolor="#D4D0C8"><font ${FONT}><b>${esc(text)}</b></font></td>`;
const valueCell = (text: string) => `<td><font ${FONT}>${esc(text)}</font></td>`;
const plain = (text: string) => `<font ${FONT}>${esc(text)}</font>`;
const error = (text: string) => `<font ${FONT} color="#CC0000">${esc(text)}</font><br><br>`;

function memberHeader(member: Member): string {
  return `<table border="1" cellpadding="3" cellspacing="0">
<tr>${labelCell("Member No")}${valueCell(member.id)}${labelCell("Status")}${valueCell(member.status)}</tr>
<tr>${labelCell("Name")}${valueCell(`${member.firstName} ${member.lastName}`)}${labelCell("Branch")}${valueCell(member.branch)}</tr>
</table>`;
}

/** A two-column table of bold label cells and value cells, as on Review and Confirmation. */
function detailsTable(heading: string, rows: [string, string][]): string {
  return `<font ${FONT}><b>${esc(heading)}</b></font><br>
<table border="1" cellpadding="3" cellspacing="0" width="372">
${rows.map(([name, text]) => `<tr>${labelCell(name)}${valueCell(text)}</tr>`).join("\n")}
</table>`;
}

const buttons = (...names: string[]): string =>
  names.map((name) => `<input type="submit" name="b" value="${esc(name)}">`).join(" ");

export const ACCOUNT_TYPES = ["Club Savings", "Money Market", "Certificate"] as const;

/** What the operator has entered for a new sub-account, carried from screen to screen. */
export type Draft = {
  accountType: string;
  nickname: string;
  deposit: string;
  /** Supervisor ID once an override has been authorized. */
  override?: string;
};

export function subAccountFormPage(
  member: Member,
  action: string,
  availableCents: number,
  draft?: Draft,
  message?: string,
): string {
  const options = ["", ...ACCOUNT_TYPES]
    .map(
      (type) =>
        `<option value="${esc(type)}"${draft?.accountType === type ? " selected" : ""}>${esc(type || "-- Select --")}</option>`,
    )
    .join("");
  const row = (name: string, field: string, hint = "") =>
    `<tr><td width="140">${plain(name)}</td><td>${field}</td><td>${hint ? plain(hint) : "&nbsp;"}</td></tr>`;
  return workarea(
    "Open Sub-Account",
    `${memberHeader(member)}<br>
${message ? error(message) : ""}${plain("Complete the fields below and select Continue. The opening deposit is transferred from the member's Savings account.")}<br>
${plain("Fields marked * are required.")}<br><br>
<form method="post" action="${action}">
<table border="0" cellpadding="3" cellspacing="0">
${row("Account Type *", `<select name="f1">${options}</select>`)}
${row("Nickname *", `<input type="text" name="f2" size="24" maxlength="20" value="${esc(draft?.nickname ?? "")}">`, "(max 20 characters)")}
${row("Opening Deposit *", `<input type="text" name="f3" size="12" value="${esc(draft?.deposit ?? "")}">`, "USD, no $ sign or commas")}
<tr><td>${plain("Funded From")}</td><td>${plain("Savings")}</td><td>${plain("Available Balance")} &nbsp; ${plain(formatMoney(availableCents))}</td></tr>
<tr><td>&nbsp;</td><td colspan="2">${buttons("Continue", "Cancel")}</td></tr>
</table>
</form>`,
  );
}

export function supervisorOverridePage(
  member: Member,
  action: string,
  amountCents: number,
  limitCents: number,
  message?: string,
): string {
  return workarea(
    "Supervisor Override Required",
    `${memberHeader(member)}<br>
<form method="post" action="${action}">
<table border="1" cellpadding="8" cellspacing="0" bgcolor="#FFFFE1" width="560">
<tr><td>
<font ${FONT}><b>Teller limit exceeded</b></font><br><br>
${message ? error(message) : ""}${plain("The opening deposit exceeds your teller limit. A supervisor must enter their ID and override code at this workstation to continue.")}<br><br>
<table border="1" cellpadding="3" cellspacing="0" bgcolor="#FFFFFF">
<tr>${labelCell("Transaction")}${valueCell("Open Sub-Account")}</tr>
<tr>${labelCell("Amount")}${valueCell(formatMoney(amountCents))}</tr>
<tr>${labelCell("Teller Limit")}${valueCell(formatMoney(limitCents))}</tr>
</table><br>
<table border="0" cellpadding="3" cellspacing="0">
<tr><td width="120">${plain("Supervisor ID")}</td><td><input type="text" name="f1" size="12"></td></tr>
<tr><td>${plain("Override Code")}</td><td><input type="password" name="f2" size="12"></td></tr>
<tr><td>&nbsp;</td><td>${buttons("Authorize", "Cancel")}</td></tr>
</table>
</td></tr>
</table>
</form>`,
  );
}

export function reviewPage(
  member: Member,
  action: string,
  draft: Draft,
  depositCents: number,
): string {
  return workarea(
    "Review Sub-Account",
    `${plain("Verify the details below with the member, then select Confirm to open the account.")}<br>
<font ${FONT}><b>Once confirmed, the account is opened and the deposit is posted. This cannot be undone from this screen.</b></font><br><br>
${detailsTable("Pending Transaction", [
  ["Member No", member.id],
  ["Member Name", `${member.firstName} ${member.lastName}`],
  ["Transaction", "Open Sub-Account"],
  ["Account Type", draft.accountType],
  ["Nickname", draft.nickname],
  ["Opening Deposit", formatMoney(depositCents)],
  ["Funded From", "Savings"],
  ["Supervisor Override", draft.override ? `Approved (${draft.override})` : "Not required"],
])}<br>
<form method="post" action="${action}">${buttons("Confirm", "Back", "Cancel")}</form>`,
  );
}

export function confirmationPage(
  member: Member,
  action: string,
  receipt: {
    accountNumber: string;
    draft: Draft;
    depositCents: number;
    reference: string;
    posted: string;
  },
): string {
  return workarea(
    "Sub-Account Confirmation",
    `<font ${FONT} color="#006400"><b>Sub-account opened.</b></font><br>
${plain("The opening deposit has been posted. Give the member the confirmation reference below.")}<br><br>
${detailsTable("Transaction Receipt", [
  ["Member No", member.id],
  ["New Account No", receipt.accountNumber],
  ["Account Type", receipt.draft.accountType],
  ["Nickname", receipt.draft.nickname],
  ["Opening Deposit", formatMoney(receipt.depositCents)],
  ["Funded From", "Savings"],
  ["Confirmation Ref", receipt.reference],
  ["Posted", receipt.posted],
])}<br>
<form method="post" action="${action}"><input type="submit" value="Return to Member Profile"></form>`,
  );
}

/** A native alert raised as the page loads, as some legacy apps do for operator notices. */
export function withAlert(html: string, message: string): string {
  return html.replace("</body>", `<script>alert(${JSON.stringify(message)});</script>\n</body>`);
}

export function messagePage(heading: string, message: string): string {
  return workarea(heading, `<font ${FONT}>${esc(message)}</font>`);
}

// Interruptions, shown in the workarea instead of the screen that was requested.

export function noticePage(acknowledge: string): string {
  return workarea(
    "System Notice",
    `<form method="post" action="${acknowledge}">
<table border="1" cellpadding="6" cellspacing="0" bgcolor="#FFFFE1" width="480">
<tr><td>
<font ${FONT}><b>Scheduled maintenance tonight</b></font><br><br>
<font ${FONT}>Teller functions will be unavailable from 11:00 PM to 1:00 AM. Save your work before then.</font><br><br>
<input type="submit" value="Acknowledge">
</td></tr>
</table>
</form>`,
  );
}

export function sessionExpiredPage(): string {
  return workarea(
    "Session Expired",
    `<font ${FONT}>Your session has expired. Sign in again to continue.</font><br><br>
<font ${FONT}><a href="/" target="_top">Sign in again</a></font>`,
  );
}

export function applicationErrorPage(reference: string): string {
  const label = (text: string) => `<td bgcolor="#D4D0C8"><font ${FONT}><b>${text}</b></font></td>`;
  return workarea(
    "Application Error",
    `<font ${FONT}>An unexpected error occurred while processing your request.</font><br><br>
<table border="1" cellpadding="3" cellspacing="0" width="480">
<tr>${label("Error Code")}<td><font ${FONT}>CS-500</font></td></tr>
<tr>${label("Reference")}<td><font ${FONT}>${esc(reference)}</font></td></tr>
</table><br>
<font ${FONT}>Contact the help desk if the problem persists. Use the menu on the left to continue.</font>`,
    "#800000",
  );
}
