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
    // Edge cases for replay breadth: zero and very large balances, no Savings account at all,
    // two Savings accounts (an ambiguous row key), punctuation in names and a non-active status.
    {
      id: "10401",
      firstName: "Elena",
      lastName: "Petrov",
      status: "Active",
      branch: "Harbor Street",
      restricted: false,
      accounts: [
        { number: "4000-10401-01", type: "Savings", balanceCents: 0, opened: "01/05/2024" },
      ],
    },
    {
      id: "10402",
      firstName: "Rashid",
      lastName: "Al-Amin",
      status: "Active",
      branch: "Lakeside Main",
      restricted: false,
      accounts: [
        {
          number: "4000-10402-01",
          type: "Savings",
          balanceCents: 1234567890,
          opened: "06/30/2008",
        },
        { number: "4000-10402-02", type: "Checking", balanceCents: 5, opened: "06/30/2008" },
      ],
    },
    {
      id: "10403",
      firstName: "Grace",
      lastName: "O'Neill",
      status: "Active",
      branch: "Harbor Street",
      restricted: false,
      accounts: [
        { number: "4000-10403-02", type: "Checking", balanceCents: 15000, opened: "09/09/2021" },
      ],
    },
    {
      id: "10404",
      firstName: "Samuel",
      lastName: "Whitfield",
      status: "Active",
      branch: "Lakeside Main",
      restricted: false,
      accounts: [
        { number: "4000-10404-01", type: "Savings", balanceCents: 50000, opened: "02/02/2015" },
        { number: "4000-10404-03", type: "Savings", balanceCents: 75000, opened: "02/02/2020" },
      ],
    },
    {
      id: "10405",
      firstName: "Mei-Ling",
      lastName: "Chen",
      status: "Dormant",
      branch: "Harbor Street",
      restricted: false,
      accounts: [
        { number: "4000-10405-02", type: "Checking", balanceCents: 99, opened: "12/31/2012" },
        { number: "4000-10405-01", type: "Savings", balanceCents: 1, opened: "12/31/2012" },
        {
          number: "4000-10405-03",
          type: "Club Savings",
          balanceCents: 30000,
          opened: "12/31/2022",
        },
      ],
    },
    {
      id: "10406",
      firstName: "Jon",
      lastName: "Search",
      status: "Active",
      branch: "Lakeside Main",
      restricted: false,
      accounts: [
        { number: "4000-10406-01", type: "Savings", balanceCents: 999999, opened: "07/04/2018" },
      ],
    },
    {
      id: "10407",
      firstName: "View",
      lastName: "Balance",
      status: "Active",
      branch: "Harbor Street",
      restricted: false,
      accounts: [
        { number: "4000-10407-02", type: "Checking", balanceCents: 100000, opened: "05/05/2005" },
        { number: "4000-10407-01", type: "Savings", balanceCents: 100000, opened: "05/05/2005" },
      ],
    },
  ];
}

export function formatMoney(cents: number): string {
  const dollars = Math.floor(cents / 100).toLocaleString("en-US");
  return `$${dollars}.${String(cents % 100).padStart(2, "0")}`;
}
