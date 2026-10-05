// Synthetic seed data for the CoreServ demo app. Nothing here is real.

export type Account = { number: string; type: string; balanceCents: number; opened: string };

export type Member = {
  id: string;
  firstName: string;
  lastName: string;
  status: string;
  branch: string;
  restricted: boolean;
  accounts: Account[];
};

// Checking is listed before Savings on purpose: a position-based locator reads the wrong row.
export function seedMembers(): Member[] {
  return [
    {
      id: "10042",
      firstName: "Dana",
      lastName: "Whitfield",
      status: "Active",
      branch: "Lakeside Main",
      restricted: false,
      accounts: [
        { number: "4000-10042-02", type: "Checking", balanceCents: 91340, opened: "03/14/2011" },
        { number: "4000-10042-01", type: "Savings", balanceCents: 248017, opened: "03/14/2011" },
      ],
    },
    {
      id: "10077",
      firstName: "Marcus",
      lastName: "Oyelaran",
      status: "Active",
      branch: "Lakeside Main",
      restricted: false,
      accounts: [
        { number: "4000-10077-02", type: "Checking", balanceCents: 421005, opened: "08/02/2016" },
        { number: "4000-10077-01", type: "Savings", balanceCents: 1590266, opened: "08/02/2016" },
      ],
    },
    {
      id: "10200",
      firstName: "Priya",
      lastName: "Raman",
      status: "Employee",
      branch: "Lakeside Main",
      restricted: true,
      accounts: [],
    },
    // Two members sharing a last name, so a name search returns several rows.
    {
      id: "10311",
      firstName: "Tom",
      lastName: "Nguyen",
      status: "Active",
      branch: "Harbor Street",
      restricted: false,
      accounts: [
        { number: "4000-10311-01", type: "Savings", balanceCents: 73050, opened: "11/20/2019" },
      ],
    },
    {
      id: "10312",
      firstName: "Linh",
      lastName: "Nguyen",
      status: "Active",
      branch: "Harbor Street",
      restricted: false,
      accounts: [
        { number: "4000-10312-01", type: "Savings", balanceCents: 1204511, opened: "11/20/2019" },
      ],
    },
  ];
}

export function formatMoney(cents: number): string {
  const dollars = Math.floor(cents / 100).toLocaleString("en-US");
  return `$${dollars}.${String(cents % 100).padStart(2, "0")}`;
}
