// Goals: yearly spending targets per expense category, and the report that
// sets spending against them.
import { randomUUID } from 'node:crypto';
import type { Schemas } from '@/lib/api/client';
import type { Handlers } from './types';
import {
  extra,
  mockToday,
  money,
  monthRange,
  monthsRange,
  periodDefaults,
  spendingByCategory,
  stamp,
} from './util';

type GoalOperations =
  | 'listGoals'
  | 'getGoalExpenses'
  | 'createGoal'
  | 'addGoalCategories';

type GoalExpense = Schemas['GetGoalExpensesResponse'][number];

// The goals page only ever reads the goal with this name.
const GOALS_PAGE_GOAL = 'goal expenses';

// The backend sends a rounded Decimal string, or the number 0 for nothing.
const amount = (value: number) => (value === 0 ? 0 : money(value));

export const goalHandlers: Pick<Handlers, GoalOperations> = {
  listGoals: ({ store, query }) => ({
    status: 200,
    body: store.goals
      .filter(
        (goal) =>
          !query.year ||
          (goal.date >= `${query.year}-01-01` &&
            goal.date <= `${query.year}-12-31`)
      )
      .toSorted((a, b) => b.date.localeCompare(a.date))
      .map((goal) => ({ slug: goal.slug, name: goal.name, date: goal.date })),
  }),

  getGoalExpenses: ({ store, query }) => {
    const { year, startMonth, endMonth } = periodDefaults(query);
    const range = monthsRange(year, startMonth, endMonth);

    // Targets count only when their goal is dated inside the period asked
    // for. That is how the backend behaves: a range that doesn't include the
    // goal's own date reports nothing at all.
    const goalIds = store.goals
      .filter(
        (goal) =>
          goal.name.toLowerCase().includes(GOALS_PAGE_GOAL) &&
          goal.date >= range.from &&
          goal.date <= range.to
      )
      .map((goal) => goal.id);
    const targets = store.goalCategories.filter((target) =>
      goalIds.includes(target.goal_id)
    );
    if (targets.length === 0) return { status: 200, body: [] };

    // By payment date, spending stops at the end of the current month.
    const thisMonthEnd = monthRange(mockToday()).to;
    const spendingRange =
      query.date_field === 'payment' && range.to > thisMonthEnd
        ? { from: range.from, to: thisMonthEnd }
        : range;

    const spent = new Map<string, number>();
    for (const { category, total } of spendingByCategory(
      store,
      spendingRange,
      query.date_field
    )) {
      spent.set(category.name, total);
    }
    const expected = new Map<string, number>();
    for (const target of targets) {
      const category = store.categories.find(
        (c) => c.id === target.category_id
      );
      if (category) expected.set(category.name, target.goal_expectation);
    }

    // Names in alphabetical order, then by target, largest first; categories
    // with no target keep their alphabetical order at the end.
    const names = [...new Set([...spent.keys(), ...expected.keys()])].sort();
    const rows = names
      .map((name) => {
        const expensesSum = spent.get(name) ?? 0;
        const expectation = expected.get(name) ?? 0;
        const row: GoalExpense = {
          name,
          expenses_sum: amount(expensesSum),
          goal_expectation: amount(expectation),
          percentage:
            expensesSum === 0 || expectation === 0
              ? 0
              : money((expensesSum / expectation) * 100),
        };
        return { row, expectation };
      })
      .sort((a, b) => b.expectation - a.expectation)
      .map(({ row }) => row);

    return { status: 200, body: rows };
  },

  createGoal: ({ store, body }) => {
    const now = stamp();
    const goal = {
      id: store.nextId++,
      slug: randomUUID(),
      name: body.name ?? '',
      date: (body.date ?? mockToday()).slice(0, 10),
    };
    store.goals.push(goal);

    return {
      status: 201,
      body: {
        slug: goal.slug,
        name: goal.name,
        date: goal.date,
        user_id: store.userId,
        inserted_at: now,
        updated_at: now,
      },
    };
  },

  addGoalCategories: ({ store, path, body }) => {
    const goal = store.goals.find((g) => g.slug === path.slug);
    if (!goal) return { status: 404, body: { error: 'Goal not found' } };

    const requested = body.categories ?? [];
    const known = requested.every((entry) =>
      store.categories.some((c) => c.id === entry.category_id)
    );
    if (!known) return { status: 404, body: { error: 'Category not found' } };

    const now = stamp();
    const added = requested.map((entry) => ({
      slug: randomUUID(),
      goal_id: goal.id,
      category_id: entry.category_id,
      goal_expectation: extra<number>(entry, 'goal_expectation') ?? 0,
      inserted_at: now,
    }));
    store.goalCategories.push(...added);

    return {
      status: 201,
      body: added.map((target) => ({ ...target, updated_at: now })),
    };
  },
};
