// Incomes: the same shape of endpoints as expenses, without payment dates,
// types or payment methods.
import { randomUUID } from 'node:crypto';
import type { Schemas } from '@/lib/api/client';
import { shiftMonths, type Store, type StoredIncome } from './store';
import type { Handlers } from './types';
import {
  extra,
  mockToday,
  money,
  monthRange,
  requireFields,
  sum,
} from './util';

type IncomeOperations =
  | 'listIncomeCategories'
  | 'listIncomes'
  | 'listIncomesByCategory'
  | 'getIncome'
  | 'createIncome'
  | 'updateIncome'
  | 'duplicateIncome'
  | 'archiveIncome';

const active = (store: Store) => store.incomes.filter((i) => !i.archived);

const find = (store: Store, slug: string | undefined) =>
  active(store).find((i) => i.slug === slug);

const categoryName = (store: Store, income: StoredIncome) =>
  store.incomeCategories.find((c) => c.id === income.category_id)?.name ?? '';

function row(store: Store, income: StoredIncome) {
  return {
    id: income.id,
    name: income.name,
    category_name: categoryName(store, income),
    note: income.note,
    income: income.income,
    date: income.date,
    estimated: income.estimated,
    slug: income.slug,
  };
}

const newestFirst = (a: StoredIncome, b: StoredIncome) =>
  b.date.localeCompare(a.date) || b.id - a.id;

function list(store: Store, incomes: StoredIncome[]) {
  const sorted = incomes.toSorted(newestFirst);
  return {
    incomes: sorted.map((income) => row(store, income)),
    total: money(sum(sorted.map((income) => income.income))),
  };
}

export const incomeHandlers: Pick<Handlers, IncomeOperations> = {
  listIncomeCategories: ({ store }) => ({
    status: 200,
    body: store.incomeCategories,
  }),

  listIncomes: ({ store, query }) => {
    requireFields(query, ['date']);
    const { from, to } = monthRange(query.date as string);
    const needle = query.search?.toLowerCase();

    return {
      status: 200,
      body: list(
        store,
        active(store).filter(
          (income) =>
            income.date >= from &&
            income.date <= to &&
            (!needle || income.name.toLowerCase().includes(needle))
        )
      ),
    };
  },

  listIncomesByCategory: ({ store, path, query }) => {
    const year = query.year ?? mockToday().slice(0, 4);
    const category = store.incomeCategories.find(
      (c) => c.slug === path.category_slug
    );

    return {
      status: 200,
      body: list(
        store,
        active(store).filter(
          (income) =>
            income.category_id === category?.id &&
            income.date >= `${year}-01-01` &&
            income.date <= `${year}-12-31`
        )
      ),
    };
  },

  getIncome: ({ store, path }) => {
    const income = find(store, path.slug);
    if (!income) return { status: 404 };

    const body: Schemas['GetIncomeResponse'] = {
      ...row(store, income),
      category: income.category_id,
    };
    return { status: 200, body };
  },

  createIncome: ({ store, body }) => {
    requireFields(body, ['name', 'income', 'date', 'category_id']);

    const income: StoredIncome = {
      id: store.nextId++,
      slug: randomUUID(),
      name: body.name as string,
      note: extra<string>(body, 'note') ?? null,
      income: body.income as number,
      date: (body.date as string).slice(0, 10),
      estimated: extra<boolean>(body, 'estimated') ?? false,
      category_id: body.category_id as number,
      archived: false,
    };
    store.incomes.push(income);

    return { status: 200, body: { slug: income.slug } };
  },

  updateIncome: ({ store, path, body }) => {
    const income = find(store, path.slug);
    if (!income) return { status: 404 };

    const name = extra<string>(body, 'name');
    const note = extra<string | null>(body, 'note');
    const amount = extra<number>(body, 'income');
    const date = extra<string>(body, 'date');
    const estimated = extra<boolean>(body, 'estimated');
    const categoryId = extra<number>(body, 'category_id');

    if (name !== undefined) income.name = name;
    if (note !== undefined) income.note = note;
    if (amount !== undefined) income.income = amount;
    if (date !== undefined) income.date = date.slice(0, 10);
    if (estimated !== undefined) income.estimated = estimated;
    if (categoryId !== undefined) income.category_id = categoryId;

    return { status: 200, body: { slug: income.slug } };
  },

  // The copy moves one month on and is never an estimate, as on the backend.
  duplicateIncome: ({ store, path }) => {
    const income = find(store, path.slug);
    if (!income) return { status: 404 };

    const copy: StoredIncome = {
      ...income,
      id: store.nextId++,
      slug: randomUUID(),
      date: shiftMonths(income.date, 1),
      estimated: false,
    };
    store.incomes.push(copy);

    return { status: 200, body: { slug: copy.slug } };
  },

  archiveIncome: ({ store, path }) => {
    const income = find(store, path.slug);
    if (!income) return { status: 404 };

    income.archived = true;
    return { status: 204 };
  },
};
