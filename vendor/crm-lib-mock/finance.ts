// Payslips, money accounts and their snapshots, net worth and targets.
import type { Schemas } from "@/lib/api/schemas";
import { mockToday } from "./dates";
import { newSlug, type Store, type StoredAccount, type StoredSnapshot } from "./store";
import type { Handlers } from "./types";
import { fields, noContent, round2, toNumber } from "./util";

type FinanceOperations =
  | "listPayslips"
  | "getPayslipProjection"
  | "listMoneyAccounts"
  | "createMoneyAccount"
  | "updateMoneyAccount"
  | "deleteMoneyAccount"
  | "recordMoneyAccountSnapshot"
  | "getNetWorth"
  | "getNetWorthHistory"
  | "listTargets"
  | "updateTarget";

type Payslip = Schemas["ListPayslipsResponse"][number];

// Remaining months are filled with the average of the last 3 payslips received.
const RUN_RATE_WINDOW = 3;

const totals = (payslips: Payslip[]) => ({
  gross: payslips.reduce((sum, p) => sum + p.total_devengado, 0),
  irpf: payslips.reduce((sum, p) => sum + p.irpf, 0),
  net_pay: payslips.reduce((sum, p) => sum + p.net_pay, 0),
  expected_refund: payslips.reduce((sum, p) => sum + (p.devolucion_irpf ?? 0), 0),
});

// Year-end projection: what was received, plus the run rate for the months still to come.
function projection(payslips: Payslip[], year: number): Schemas["GetPayslipProjectionResponse"] {
  if (payslips.length === 0) {
    const none = totals([]);
    return { year, months_received: 0, months_remaining: 12, received: none, projected: none };
  }

  const ordered = payslips.toSorted((a, b) => a.period.localeCompare(b.period));
  const firstMonth = Number(ordered[0].period.slice(5, 7));
  const lastMonth = Number(ordered[ordered.length - 1].period.slice(5, 7));
  // Any gap between the first and last payslip, plus the tail to December.
  const remaining = lastMonth - firstMonth + 1 - ordered.length + 12 - lastMonth;

  const received = totals(ordered);
  const window = ordered.slice(-RUN_RATE_WINDOW);
  const recent = totals(window);
  const rate = (key: keyof typeof received) =>
    recent[key] / Math.min(ordered.length, window.length);

  const rounded = (values: typeof received) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round2(v)])) as typeof received;

  return {
    year,
    months_received: ordered.length,
    months_remaining: remaining,
    received: rounded(received),
    projected: rounded({
      gross: received.gross + rate("gross") * remaining,
      irpf: received.irpf + rate("irpf") * remaining,
      net_pay: received.net_pay + rate("net_pay") * remaining,
      expected_refund: received.expected_refund + rate("expected_refund") * remaining,
    }),
  };
}

const balances = (s: StoredSnapshot) => ({
  date: s.date,
  cash: s.cash,
  savings: s.savings,
  invested: s.invested,
  liquid: s.cash + s.savings,
  total: s.cash + s.savings + s.invested,
});

const latestAt = (account: StoredAccount, date: string) =>
  account.snapshots
    .filter((s) => s.date <= date)
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .at(-1);

/** The net worth summary as of a date: each account's latest snapshot on or before it. */
function netWorth(store: Store, date: string): Schemas["GetNetWorthResponse"] {
  const accounts = store.accounts.map((account) => {
    const snapshot = latestAt(account, date) ?? { date, cash: 0, savings: 0, invested: 0 };
    return { slug: account.slug, name: account.name, kind: account.kind, ...balances(snapshot) };
  });

  const total = accounts.reduce((sum, a) => sum + a.total, 0);
  const invested = accounts.reduce((sum, a) => sum + a.invested, 0);
  return {
    as_of: date,
    net_worth: total,
    liquid: accounts.reduce((sum, a) => sum + a.liquid, 0),
    invested,
    invested_pct: total === 0 ? 0 : round2((invested / total) * 100),
    accounts,
  };
}

// A snapshot moves net worth from its date on: the history gets a point for that date.
function refreshHistory(store: Store, date: string) {
  const summary = netWorth(store, date);
  const point = {
    date,
    net_worth: summary.net_worth,
    liquid: summary.liquid,
    invested: summary.invested,
    invested_pct: summary.invested_pct,
  };
  store.history = [...store.history.filter((p) => p.date !== date), point].toSorted((a, b) =>
    a.date.localeCompare(b.date),
  );
}

/** `2025-03` and any date in March both mean 2025-03-01. */
const monthStart = (value: string) => `${value.slice(0, 7)}-01`;

const KINDS = ["bank", "broker", "wallet", "cash"];

export const financeHandlers: Pick<Handlers, FinanceOperations> = {
  // A payslip is dated by its month, so the bounds snap to the first of their month: a range
  // ending 2025-12-31 still includes December's payslip, and one starting mid-month, that month's.
  listPayslips: ({ query, store }) => {
    const start = query.start_date && monthStart(query.start_date);
    const end = query.end_date && monthStart(query.end_date);
    return {
      status: 200,
      body: store.payslips
        .filter((p) => (!start || p.period >= start) && (!end || p.period <= end))
        .toSorted((a, b) => b.period.localeCompare(a.period)),
    };
  },

  getPayslipProjection: ({ query, store }) => {
    // Only a year the backend accepts; anything else falls back to the current one.
    const asked = Number(query.year);
    const year =
      Number.isInteger(asked) && asked >= 2000 && asked <= 2100
        ? asked
        : Number(mockToday().slice(0, 4));
    const inYear = store.payslips.filter(
      (p) => p.period >= `${year}-01-01` && p.period <= `${year}-12-01`,
    );
    return { status: 200, body: projection(inYear, year) };
  },

  listMoneyAccounts: ({ store }) => ({
    status: 200,
    body: store.accounts.map((account) => {
      const latest = account.snapshots.toSorted((a, b) => a.date.localeCompare(b.date)).at(-1);
      return {
        slug: account.slug,
        name: account.name,
        kind: account.kind,
        broker_account: account.broker_account,
        latest: latest ? balances(latest) : null,
      };
    }),
  }),

  createMoneyAccount: ({ body, store }) => {
    const name = (body.name ?? "").trim();
    if (name === "") return { status: 422, body: { errors: { name: ["can't be blank"] } } };

    const account: StoredAccount = {
      slug: newSlug(),
      name,
      kind: body.kind && KINDS.includes(body.kind) ? (body.kind as StoredAccount["kind"]) : "bank",
      broker_account: body.broker_account || null,
      snapshots: [],
    };
    store.accounts.push(account);
    return {
      status: 201,
      body: {
        slug: account.slug,
        name: account.name,
        kind: account.kind,
        broker_account: account.broker_account,
      },
    };
  },

  updateMoneyAccount: ({ path, body, store }) => {
    const account = store.accounts.find((a) => a.slug === path.slug);
    if (!account) return { status: 404, body: { error: "Not found" } };

    const input = fields(body);
    if (typeof input.name === "string" && input.name.trim() !== "") account.name = input.name;
    if (typeof input.kind === "string" && KINDS.includes(input.kind)) {
      account.kind = input.kind as StoredAccount["kind"];
    }
    if ("broker_account" in input) {
      account.broker_account = (input.broker_account as string | null) || null;
    }

    return {
      status: 200,
      body: {
        slug: account.slug,
        name: account.name,
        kind: account.kind,
        // The contract types this as a string; an account with no broker sends null.
        broker_account: account.broker_account as string,
      },
    };
  },

  deleteMoneyAccount: ({ path, store }) => {
    const index = store.accounts.findIndex((a) => a.slug === path.slug);
    if (index === -1) return { status: 404, body: { error: "Not found" } };

    const [removed] = store.accounts.splice(index, 1);
    for (const date of removed.snapshots.map((s) => s.date)) refreshHistory(store, date);
    return noContent;
  },

  // Amounts left out keep what the account recorded for that date (or 0). The backend derives a
  // broker account's `invested` from holdings when recording today; the mock keeps it as given.
  recordMoneyAccountSnapshot: ({ path, body, store }) => {
    const account = store.accounts.find((a) => a.slug === path.slug);
    if (!account) return { status: 404, body: { error: "Not found" } };

    const input = fields(body);
    const date = (body.date as string | undefined) || mockToday();
    const existing = account.snapshots.find((s) => s.date === date);
    const next: StoredSnapshot = existing ?? { date, cash: 0, savings: 0, invested: 0 };

    for (const key of ["cash", "savings", "invested"] as const) {
      if (input[key] == null || input[key] === "") continue;
      const value = toNumber(input[key]);
      if (value === null) {
        return { status: 422, body: { errors: { cash: [`${key} is not a number`] } } };
      }
      if (value < 0) {
        return {
          status: 422,
          body: { errors: { cash: [`${key} must be greater than or equal to 0`] } },
        };
      }
      next[key] = value;
    }

    if (!existing) account.snapshots.push(next);
    refreshHistory(store, date);
    return { status: 200, body: balances(next) };
  },

  getNetWorth: ({ query, store }) => {
    if (query.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
      return { status: 400, body: { error: "invalid date" } };
    }
    return { status: 200, body: netWorth(store, query.date ?? mockToday()) };
  },

  getNetWorthHistory: ({ store }) => ({ status: 200, body: store.history }),

  // Progress and pace are the recorded ones: the mock has no holdings or price history to
  // recompute them from, so only `hidden` and the target value move.
  listTargets: ({ query, store }) => ({
    status: 200,
    body: store.targets.filter((t) => query.include_hidden === "true" || !t.hidden),
  }),

  updateTarget: ({ path, body, store }) => {
    const index = store.targets.findIndex((t) => t.slug === path.slug);
    if (index === -1) return { status: 404, body: { error: "Not found" } };

    const input = fields(body);
    if ("target_value" in input) {
      const value = toNumber(input.target_value);
      if (value === null || value <= 0) {
        return {
          status: 422,
          body: { errors: { target_value: ["must be greater than 0"] } },
        };
      }
    }

    const current = store.targets[index];
    const targetValue = "target_value" in input ? Number(input.target_value) : current.target_value;
    const next = {
      ...current,
      hidden: typeof input.hidden === "boolean" ? input.hidden : current.hidden,
      target_value: targetValue,
    };
    store.targets[index] = next;
    return { status: 200, body: next };
  },
};
