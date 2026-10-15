// One handler per operation in the backend contract. `Handlers` is exhaustive
// over the contract's operation ids, so an endpoint added there does not
// compile here until it has a handler (or is listed in `Unmocked`).
//
// Each handler re-implements just enough of the backend to keep the UI
// coherent: filters, ordering, totals and the mutations. tests/mock replays the
// backend's recorded responses against these to keep them honest.
import { randomUUID } from 'node:crypto';
import type { Schemas } from '@/lib/api/client';
import { shiftMonths, type Store, type StoredExpense } from './store';
import {
  activeExpenses as active,
  expenseRow,
  money,
  monthRange,
  requireFields,
  tagsOf,
} from './util';
import { canned } from './canned';
import { budgetHandlers } from './budgets';
import { categoryHandlers } from './categories';
import { goalHandlers } from './goals';
import { groupHandlers } from './groups';
import { incomeHandlers } from './incomes';
import { settingsHandlers } from './settings';
import { reportHandlers } from './reports';
import { statisticsHandlers } from './statistics';
import { tagHandlers } from './tags';
import { MockHttpError, type Handlers } from './types';

/** The code that signs in, with any email. Anything else is rejected. */
export const MOCK_LOGIN_CODE = '123456';

const selectable = (store: Store) => (option: { slug: string }) =>
  !store.inactive.has(option.slug);

const findExpense = (store: Store, slug: string | undefined) =>
  active(store).find((e) => e.slug === slug);

// The tag slugs a create or update sends: each one of the user's, once.
// `null` when one isn't, which the backend answers with a 422.
function ownTagSlugs(store: Store, slugs: unknown): string[] | null {
  if (!Array.isArray(slugs)) return null;
  const unique = [...new Set(slugs)];
  return unique.every((slug) => store.tags.some((tag) => tag.slug === slug))
    ? unique
    : null;
}

const tagNotFound = { status: 422, body: { error: 'Tag not found' } } as const;

interface ListFilter {
  from: string;
  to: string;
  dateField?: string;
  type?: string;
  payed?: string;
  search?: string;
  categoryId?: number;
}

function filterExpenses(store: Store, filter: ListFilter): StoredExpense[] {
  const needle = filter.search?.toLowerCase();

  return active(store)
    .filter((expense) => {
      const date =
        filter.dateField === 'payment'
          ? (expense.payment_date ?? expense.date)
          : expense.date;

      return (
        date >= filter.from &&
        date <= filter.to &&
        (!filter.type || expense.type_id === Number(filter.type)) &&
        (!filter.payed || expense.payed_id === Number(filter.payed)) &&
        (!needle || expense.name.toLowerCase().includes(needle)) &&
        (filter.categoryId === undefined ||
          expense.category_id === filter.categoryId)
      );
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

const total = (expenses: StoredExpense[]) =>
  money(expenses.reduce((sum, e) => sum + e.expense, 0));

function categorySums(
  store: Store,
  expenses: StoredExpense[]
): Schemas['ExpenseCategorySum'][] {
  const sums = new Map<number, number>();
  for (const expense of expenses) {
    sums.set(
      expense.category_id,
      (sums.get(expense.category_id) ?? 0) + expense.expense
    );
  }

  return [...sums.entries()]
    .sort(([, a], [, b]) => b - a)
    .flatMap(([categoryId, sum]) => {
      const category = store.categories.find((c) => c.id === categoryId);
      return category
        ? [{ name: category.name, slug: category.slug, sum: money(sum) }]
        : [];
    });
}

// Operations that replay recorded backend responses instead of computing
// them (see canned.ts): their pages render, but don't react to filters or
// edits yet. Move one out of here by writing a real handler for it.
export const replayed = {
  getAnnualInvestingSummary: canned('getAnnualInvestingSummary'),
  getDividendsByYear: canned('getDividendsByYear'),
  getDividendsSummary: canned('getDividendsSummary'),
  getEquityReport: canned('getEquityReport'),
  getThesis: canned('getThesis'),
  getYearInReview: canned('getYearInReview'),
  listAssetCountries: canned('listAssetCountries'),
  listAssets: canned('listAssets'),
  listDividendYears: canned('listDividendYears'),
  listDividends: canned('listDividends'),
  listEquityReports: canned('listEquityReports'),
  listHoldings: canned('listHoldings'),
  listMoneyAccounts: canned('listMoneyAccounts'),
  listPayslips: canned('listPayslips'),
  listPrompts: canned('listPrompts'),
  listTargets: canned('listTargets'),
  listTheses: canned('listTheses'),
  listTransactions: canned('listTransactions'),
} satisfies Partial<Handlers>;

export const handlers: Handlers = {
  requestLoginCode: () => ({
    status: 200,
    body: {
      message: 'If that email has an account, a login code has been sent.',
    },
  }),

  // The dispatcher sets the session cookie on a 200.
  verifyLoginCode: ({ body, store }) =>
    body.code === MOCK_LOGIN_CODE
      ? { status: 200, body: { user: store.user } }
      : { status: 401, body: { error: 'Invalid or expired code' } },

  // The dispatcher clears the session cookie.
  logout: () => ({ status: 204 }),

  getCurrentUser: ({ store }) => ({ status: 200, body: store.user }),

  // The pickers only offer what is still active; the admin lists the rest.
  listExpenseCategories: ({ store }) => ({
    status: 200,
    body: store.categories.filter(selectable(store)),
  }),

  listExpenseTypes: ({ store }) => ({
    status: 200,
    body: store.types.filter(selectable(store)),
  }),

  listExpensePayed: ({ store, query }) => ({
    status: 200,
    body: store.payed
      .filter(selectable(store))
      .filter(
        (p) =>
          !query.broker_account ||
          p.broker_account === query.broker_account.toLowerCase()
      ),
  }),

  listExpenses: ({ store, query }) => {
    let range: { from: string; to: string };
    if (query.date) {
      range = monthRange(query.date);
    } else if (query.start_date && query.end_date) {
      range = { from: query.start_date, to: query.end_date };
    } else {
      throw new MockHttpError(
        400,
        'send either "date" or both "start_date" and "end_date"'
      );
    }

    const expenses = filterExpenses(store, {
      ...range,
      dateField: query.date_field,
      type: query.type,
      payed: query.payed,
      search: query.search,
    });

    return {
      status: 200,
      body: {
        expenses: expenses.map((e) => expenseRow(store, e)),
        total: total(expenses),
        expenses_by_categories: categorySums(store, expenses),
      },
    };
  },

  listExpensesByCategory: ({ store, path, query }) => {
    const year = query.year ?? String(new Date().getFullYear());
    const category = store.categories.find(
      (c) => c.slug === path.category_slug
    );
    const expenses = category
      ? filterExpenses(store, {
          from: `${year}-${query.start_month ?? '01'}-01`,
          to: monthRange(`${year}-${query.end_month ?? '12'}`).to,
          type: query.type,
          payed: query.payed,
          search: query.search,
          categoryId: category.id,
        })
      : [];

    return {
      status: 200,
      body: {
        expenses: expenses.map((e) => expenseRow(store, e)),
        total: total(expenses),
        expenses_by_categories: [],
      },
    };
  },

  getExpense: ({ store, path }) => {
    const expense = findExpense(store, path.slug);
    if (!expense) return { status: 404 };

    return {
      status: 200,
      body: {
        id: expense.id,
        name: expense.name,
        note: expense.note,
        expense: expense.expense,
        category: expense.category_id,
        date: expense.date,
        payment_date: expense.payment_date,
        slug: expense.slug,
        type: expense.type_id,
        payed: expense.payed_id ?? -1,
        tags: tagsOf(store, expense),
      },
    };
  },

  createExpense: ({ store, body }) => {
    const tagSlugs = body.tags == null ? [] : ownTagSlugs(store, body.tags);
    if (!tagSlugs) return tagNotFound;

    requireFields(body, [
      'name',
      'expense',
      'date',
      'category_id',
      'payed_id',
      'type_id',
    ]);

    const expense: StoredExpense = {
      id: store.nextId++,
      slug: randomUUID(),
      name: body.name,
      note: body.note ?? null,
      expense: body.expense,
      date: body.date.slice(0, 10),
      payment_date: body.payment_date?.slice(0, 10) ?? null,
      category_id: body.category_id,
      type_id: body.type_id,
      payed_id: body.payed_id,
      tag_slugs: tagSlugs,
      archived: false,
    };
    store.expenses.push(expense);

    return { status: 200, body: { slug: expense.slug } };
  },

  updateExpense: ({ store, path, body }) => {
    const expense = findExpense(store, path.slug);
    if (!expense) return { status: 404 };

    // Left out, the tags stay as they are; sent, they replace the set.
    const tagSlugs = body.tags == null ? null : ownTagSlugs(store, body.tags);
    if (body.tags != null && !tagSlugs) return tagNotFound;
    if (tagSlugs) expense.tag_slugs = tagSlugs;

    if (body.name !== undefined) expense.name = body.name;
    if (body.note !== undefined) expense.note = body.note;
    if (body.expense !== undefined) expense.expense = body.expense;
    if (body.date !== undefined) expense.date = body.date.slice(0, 10);
    if (body.payment_date !== undefined) {
      expense.payment_date = body.payment_date?.slice(0, 10) ?? null;
    }
    if (body.category_id !== undefined) expense.category_id = body.category_id;
    if (body.type_id !== undefined) expense.type_id = body.type_id;
    if (body.payed_id !== undefined) expense.payed_id = body.payed_id;

    return { status: 200, body: { slug: expense.slug } };
  },

  // The copy moves one month on and drops the payment date, as the backend
  // does; it keeps the tags.
  duplicateExpense: ({ store, path }) => {
    const expense = findExpense(store, path.slug);
    if (!expense) return { status: 404 };

    const copy: StoredExpense = {
      ...expense,
      id: store.nextId++,
      slug: randomUUID(),
      date: shiftMonths(expense.date, 1),
      payment_date: null,
      tag_slugs: [...expense.tag_slugs],
    };
    store.expenses.push(copy);

    return { status: 200, body: { slug: copy.slug } };
  },

  archiveExpense: ({ store, path }) => {
    const expense = findExpense(store, path.slug);
    if (!expense) return { status: 404 };

    expense.archived = true;
    // Archiving an expense also takes it out of any group, as on the backend.
    store.groupExpenses = store.groupExpenses.filter(
      (link) => link.expense_id !== expense.id
    );
    return { status: 204 };
  },

  ...incomeHandlers,
  ...budgetHandlers,
  ...categoryHandlers,
  ...goalHandlers,
  ...groupHandlers,
  ...settingsHandlers,
  ...statisticsHandlers,
  ...reportHandlers,
  ...tagHandlers,

  ...replayed,
};
