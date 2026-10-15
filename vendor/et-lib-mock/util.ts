// Small helpers the mock handlers share. They mirror how the backend rounds
// and ranges things, so the replay tests can match its responses exactly.
import type { Schemas } from '@/lib/api/client';
import { shiftMonths, type Store, type StoredExpense } from './store';
import { MockHttpError } from './types';

/** Today as YYYY-MM-DD; `MOCK_TODAY` pins it (tests use the recorded clock). */
export function mockToday(): string {
  return process.env.MOCK_TODAY ?? new Date().toISOString().slice(0, 10);
}

// Rounded Decimals reach the wire as strings with two decimals.
export const money = (amount: number) => amount.toFixed(2);

// Where the backend converts a Decimal to a float rounded to two decimals.
export const round2 = (amount: number) => Math.round(amount * 100) / 100;

export const sum = (amounts: number[]) =>
  amounts.reduce((total, amount) => total + amount, 0);

/** A naive timestamp like the backend's inserted_at: no zone, to the second. */
export const stamp = () => new Date().toISOString().slice(0, 19);

/** First and last day of a `YYYY-MM...` month. */
export function monthRange(month: string): { from: string; to: string } {
  const prefix = month.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(prefix)) {
    throw new MockHttpError(400, `"${month}" is not a month`);
  }
  // The last day of the month is one day before the next month's first.
  const next = shiftMonths(`${prefix}-01`, 1);
  const last = new Date(Date.parse(next) - 86_400_000).toISOString();
  return { from: `${prefix}-01`, to: last.slice(0, 10) };
}

/** From the first day of `startMonth` to the last day of `endMonth`. */
export function monthsRange(
  year: string,
  startMonth: string,
  endMonth: string
) {
  return {
    from: monthRange(`${year}-${startMonth}`).from,
    to: monthRange(`${year}-${endMonth}`).to,
  };
}

/**
 * The year and month range the statistics and goals endpoints default to: the
 * whole year for a past year, January to the current month for this one.
 */
export function periodDefaults(query: {
  year?: string;
  start_month?: string;
  end_month?: string;
}) {
  const today = mockToday();
  const currentYear = Number(today.slice(0, 4));
  const year = Number.parseInt(query.year ?? String(currentYear), 10);
  return {
    year: String(year),
    startMonth: query.start_month ?? '01',
    endMonth:
      query.end_month ?? (currentYear > year ? '12' : today.slice(5, 7)),
  };
}

export const activeExpenses = (store: Store) =>
  store.expenses.filter((e) => !e.archived);

/** The date an expense counts on: its payment date when asked, else purchase. */
export const expenseDate = (expense: StoredExpense, dateField?: string) =>
  dateField === 'payment'
    ? (expense.payment_date ?? expense.date)
    : expense.date;

/** Expense totals per category within a range, largest first. */
export function spendingByCategory(
  store: Store,
  range: { from: string; to: string },
  dateField?: string,
  expenses: StoredExpense[] = activeExpenses(store)
) {
  const totals = new Map<number, number>();
  for (const expense of expenses) {
    const date = expenseDate(expense, dateField);
    if (date < range.from || date > range.to) continue;
    totals.set(
      expense.category_id,
      (totals.get(expense.category_id) ?? 0) + expense.expense
    );
  }

  return [...totals.entries()]
    .sort(([, a], [, b]) => b - a)
    .flatMap(([categoryId, total]) => {
      const category = store.categories.find((c) => c.id === categoryId);
      return category ? [{ category, total }] : [];
    });
}

/** The tags on an expense, by name ignoring case, as the backend lists them. */
export function tagsOf(store: Store, expense: StoredExpense) {
  return store.tags
    .filter((tag) => expense.tag_slugs.includes(tag.slug))
    .toSorted((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
}

/** An expense as the list endpoints send it. */
export function expenseRow(
  store: Store,
  expense: StoredExpense
): Schemas['ExpenseRow'] {
  const category = store.categories.find((c) => c.id === expense.category_id);
  return {
    id: expense.id,
    name: expense.name,
    note: expense.note,
    expense: expense.expense,
    categoryName: category?.name ?? '',
    date: expense.date,
    payment_date: expense.payment_date,
    slug: expense.slug,
    tags: tagsOf(store, expense),
  };
}

/** Reads a body key the contract's request schema doesn't list yet. */
export const extra = <T>(body: unknown, key: string): T | undefined =>
  (body as Record<string, T | undefined> | undefined)?.[key];

/** The backend raises (HTTP 500) when a required field is missing. */
export function requireFields(body: unknown, fields: string[]) {
  const missing = fields.filter(
    (field) => (body as Record<string, unknown> | undefined)?.[field] == null
  );
  if (missing.length > 0) {
    throw new MockHttpError(
      500,
      `missing required fields: ${missing.join(', ')}`
    );
  }
}
