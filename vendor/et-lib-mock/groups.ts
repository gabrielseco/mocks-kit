// Expense groups ("spent expenses"): a named date range, such as a trip, with
// expenses attached to it.
import { randomUUID } from 'node:crypto';
import type { Schemas } from '@/lib/api/client';
import type { Store, StoredGroup } from './store';
import { MockHttpError, type Handlers } from './types';
import { mockToday, money, monthsRange, sum } from './util';

type GroupOperations =
  | 'listSpentExpenses'
  | 'listSpentExpenseCategories'
  | 'listSpentExpenseYears'
  | 'getSpentExpense'
  | 'createSpentExpense'
  | 'deleteSpentExpense'
  | 'addExpensesToSpentExpense'
  | 'removeExpenseFromSpentExpense';

type GroupExpenseRow =
  Schemas['GetSpentExpenseResponse']['spent_expenses'][number];

const active = (store: Store) => store.groups.filter((g) => !g.archived);

const find = (store: Store, slug: string | undefined) =>
  active(store).find((g) => g.slug === slug);

// A group's expenses, whether or not the expense itself is still active.
function expensesOf(store: Store, group: StoredGroup) {
  const ids = store.groupExpenses
    .filter((link) => link.group_id === group.id)
    .map((link) => link.expense_id);
  return store.expenses.filter((expense) => ids.includes(expense.id));
}

export const groupHandlers: Pick<Handlers, GroupOperations> = {
  listSpentExpenses: ({ store, query }) => {
    if (!query.year) {
      // The backend builds its date range from the year and raises without it.
      throw new MockHttpError(500, 'missing required parameter: year');
    }
    const category = store.groupCategories.find(
      (c) => c.slug === query.category_slug
    );

    const groups = active(store)
      .filter(
        (group) =>
          group.start_date >= `${query.year}-01-01` &&
          group.end_date <= `${query.year}-12-31` &&
          (!query.category_slug || group.category_id === category?.id)
      )
      .toSorted((a, b) => b.start_date.localeCompare(a.start_date));

    return {
      status: 200,
      body: groups.map((group) => {
        const expenses = expensesOf(store, group);
        // A rounded Decimal with a euro sign, or "0€" for an empty group.
        const total =
          expenses.length === 0
            ? '0'
            : money(sum(expenses.map((e) => e.expense)));
        return {
          id: group.id,
          name: group.name,
          start_date: group.start_date,
          end_date: group.end_date,
          slug: group.slug,
          total: `${total}€`,
        };
      }),
    };
  },

  listSpentExpenseCategories: ({ store }) => ({
    status: 200,
    body: store.groupCategories,
  }),

  listSpentExpenseYears: ({ store }) => ({
    status: 200,
    body: [
      ...new Set(active(store).map((g) => Number(g.start_date.slice(0, 4)))),
    ].sort((a, b) => b - a),
  }),

  getSpentExpense: ({ store, path, query }) => {
    const group = find(store, path.slug);
    if (!group) return { status: 404 };

    // A month range only applies when both ends are given.
    const range =
      query.start_month && query.end_month
        ? monthsRange(
            query.year ?? mockToday().slice(0, 4),
            query.start_month,
            query.end_month
          )
        : null;
    const needle = query.search?.toLowerCase();

    const expenses = expensesOf(store, group)
      .filter(
        (expense) =>
          (!range ||
            (expense.date >= range.from && expense.date <= range.to)) &&
          (!query.type || expense.type_id === Number(query.type)) &&
          (!query.payed || expense.payed_id === Number(query.payed)) &&
          (!needle || expense.name.toLowerCase().includes(needle))
      )
      .toSorted((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

    const categoryOf = (categoryId: number) =>
      store.categories.find((c) => c.id === categoryId);

    const sums = new Map<number, number>();
    for (const expense of expenses) {
      sums.set(
        expense.category_id,
        (sums.get(expense.category_id) ?? 0) + expense.expense
      );
    }

    return {
      status: 200,
      body: {
        name: group.name,
        start_date: group.start_date,
        end_date: group.end_date,
        spent_expenses: expenses.map((expense): GroupExpenseRow => ({
          id: expense.id,
          name: expense.name,
          expense: expense.expense,
          categoryName: categoryOf(expense.category_id)?.name ?? '',
          date: expense.date,
          slug: expense.slug,
          spent_expense_name: group.name,
        })),
        total:
          expenses.length === 0
            ? 0
            : money(sum(expenses.map((e) => e.expense))),
        expenses_by_categories: [...sums.entries()]
          .sort(([, a], [, b]) => b - a)
          .map(([categoryId, total]) => ({
            name: categoryOf(categoryId)?.name ?? '',
            slug: categoryOf(categoryId)?.slug ?? '',
            sum: money(total),
          })),
      },
    };
  },

  createSpentExpense: ({ store, body }) => {
    const category = store.groupCategories.find(
      (c) => c.id === body.category_id
    );
    if (!category)
      return { status: 422, body: { error: 'Category not found' } };

    if (!body.name || !body.start_date || !body.end_date) {
      throw new MockHttpError(
        422,
        'name, start_date and end_date are required'
      );
    }
    if (body.end_date < body.start_date) {
      throw new MockHttpError(422, 'end_date must be on or after start_date');
    }

    const group: StoredGroup = {
      id: store.nextId++,
      slug: randomUUID(),
      name: body.name,
      start_date: body.start_date.slice(0, 10),
      end_date: body.end_date.slice(0, 10),
      category_id: category.id,
      archived: false,
    };
    store.groups.push(group);

    return { status: 200, body: { slug: group.slug } };
  },

  deleteSpentExpense: ({ store, path }) => {
    const group = find(store, path.slug);
    if (!group) return { status: 404 };

    group.archived = true;
    return { status: 204 };
  },

  // `checkboxes` are the slugs of the expenses ticked in the dialog.
  addExpensesToSpentExpense: ({ store, body }) => {
    const group = find(store, body.slug);
    if (!group) return { status: 404 };

    for (const expense of store.expenses) {
      if (!(body.checkboxes ?? []).includes(expense.slug)) continue;
      store.groupExpenses.push({
        slug: randomUUID(),
        group_id: group.id,
        expense_id: expense.id,
      });
    }

    return { status: 200, body: { slug: group.slug } };
  },

  // Addressed by the membership row's own slug, which is not the expense's.
  removeExpenseFromSpentExpense: ({ store, path }) => {
    const index = store.groupExpenses.findIndex(
      (link) => link.slug === path.slug
    );
    if (index === -1) return { status: 404 };

    store.groupExpenses.splice(index, 1);
    return { status: 204 };
  },
};
