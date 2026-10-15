// The mock backend's in-memory data. It is rebuilt from the responses the real
// backend recorded in contracts/examples.json, so the starting data is the
// backend's own output rather than a second hand-written copy.
import type { Schemas } from '@/lib/api/client';
import { randomUUID } from 'node:crypto';
import { examples, SEED_CLOCK, type RecordedExample } from './recorded';

export interface StoredReport {
  slug: string;
  title: string;
  period: Schemas['ReportPeriod'];
  rows: Schemas['StatisticsCard']['rows'];
}

export interface StoredExpense {
  id: number;
  slug: string;
  name: string;
  note: string | null;
  expense: number;
  date: string;
  payment_date: string | null;
  category_id: number;
  type_id: number;
  /** null when no payment method is set; the API reports that as -1. */
  payed_id: number | null;
  /** Slugs of the tags on the expense. */
  tag_slugs: string[];
  archived: boolean;
}

export interface StoredIncome {
  id: number;
  slug: string;
  name: string;
  note: string | null;
  income: number;
  date: string;
  estimated: boolean;
  category_id: number;
  archived: boolean;
}

export interface StoredGroup {
  id: number;
  slug: string;
  name: string;
  start_date: string;
  end_date: string;
  /** null when no recording showed which category the group belongs to. */
  category_id: number | null;
  archived: boolean;
}

/** An expense's membership of a group. Removing it uses this row's own slug. */
export interface StoredGroupExpense {
  slug: string;
  group_id: number;
  expense_id: number;
}

export interface StoredBudget {
  id: number;
  month: string;
  categorySlug: string;
  categoryName: string;
  amount: number;
  formula: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredGoal {
  id: number;
  slug: string;
  name: string;
  date: string;
}

export interface StoredGoalCategory {
  slug: string;
  goal_id: number;
  category_id: number;
  goal_expectation: number;
  inserted_at: string;
}

type Option = Schemas['ExpenseOption'];

export interface Store {
  user: Schemas['User'];
  /** The numeric user id, which only a few responses expose. */
  userId: number;
  categories: Option[];
  types: Option[];
  payed: Schemas['ExpensePayed'][];
  /** Slugs of deactivated categories, types and payment methods. */
  inactive: Set<string>;
  /** The user's expense tags; an expense points at them by slug. */
  tags: Schemas['ExpenseTag'][];
  expenses: StoredExpense[];
  incomeCategories: Option[];
  incomes: StoredIncome[];
  groupCategories: Option[];
  groups: StoredGroup[];
  groupExpenses: StoredGroupExpense[];
  budgets: StoredBudget[];
  goals: StoredGoal[];
  goalCategories: StoredGoalCategory[];
  /** The cards the user built for the statistics page, in page order. */
  statisticsCards: Schemas['StatisticsCard'][];
  /** The user's reports: a statistics card kept off the statistics page, with a period of its own. */
  reports: StoredReport[];
  /** Built-in sections of the statistics page the user switched off. */
  statisticsHidden: Schemas['StatisticsSection'][];
  mcpToken: string;
  serviceToken: string;
  nextId: number;
}

function body<T>(operationId: string, name: string): T {
  const example = examples.find(
    (e) => e.operationId === operationId && e.name === name
  );
  if (!example) {
    throw new Error(
      `contracts/examples.json has no ${operationId}/${name}; the mock store is seeded from it`
    );
  }
  // A copy: the store's lists are edited in place (the category admin
  // renames and removes rows), and a reset has to find the recording intact.
  return structuredClone(example.response.body) as T;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Moves an ISO date by whole months, clamping to the month's last day. */
export function shiftMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(day, lastDay))}`;
}

const monthIndex = (date: string) =>
  Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));

export { SEED_CLOCK };

/**
 * A fresh store. `today` (YYYY-MM-DD) slides every date by whole months so the
 * recorded "current month" lands on today's month and the default views have
 * data. Pass `SEED_CLOCK` to get the dates exactly as recorded.
 */
export function createStore(today: string = SEED_CLOCK): Store {
  const months = monthIndex(today) - monthIndex(SEED_CLOCK);
  const shift = (date: string | null) =>
    date === null ? null : shiftMonths(date, months);

  const expenses = examples
    .filter((e) => e.operationId === 'getExpense' && e.response.status === 200)
    .map((e) => e.response.body as Schemas['ExpenseDetail'])
    .map((detail): StoredExpense => ({
      id: detail.id,
      slug: detail.slug,
      name: detail.name,
      note: detail.note,
      expense: detail.expense,
      date: shift(detail.date) as string,
      payment_date: shift(detail.payment_date),
      category_id: detail.category,
      type_id: detail.type,
      payed_id: detail.payed === -1 ? null : detail.payed,
      tag_slugs: detail.tags.map((tag) => tag.slug),
      archived: false,
    }));

  const ok = (operationId: string) =>
    examples.filter(
      (e) => e.operationId === operationId && e.response.status === 200
    );
  const bodies = <T>(operationId: string) =>
    ok(operationId).map((e) => e.response.body as T);
  const unfiltered = (e: RecordedExample) =>
    Object.keys(e.request.query).length === 0;
  const lastSegment = (path: string) => path.split('/').pop() as string;

  const categories = body<Option[]>('listExpenseCategories', 'all');
  const groupCategories = body<Option[]>('listSpentExpenseCategories', 'all');

  const incomes = bodies<Schemas['GetIncomeResponse']>('getIncome').map(
    (income): StoredIncome => ({
      id: income.id,
      slug: income.slug,
      name: income.name,
      note: income.note,
      income: income.income,
      date: shift(income.date) as string,
      estimated: income.estimated,
      category_id: income.category,
      archived: false,
    })
  );

  // The plain listing doesn't say which category a group has; the listings
  // recorded per category do.
  type GroupRow = Schemas['ListSpentExpensesResponse'][number];
  const groups = new Map<number, StoredGroup>();
  for (const example of ok('listSpentExpenses')) {
    const category = groupCategories.find(
      (c) => c.slug === example.request.query.category_slug
    );
    for (const row of example.response.body as GroupRow[]) {
      const known = groups.get(row.id);
      groups.set(row.id, {
        id: row.id,
        slug: row.slug,
        name: row.name,
        start_date: shift(row.start_date) as string,
        end_date: shift(row.end_date) as string,
        category_id: category?.id ?? known?.category_id ?? null,
        archived: false,
      });
    }
  }

  const groupExpenses = ok('getSpentExpense')
    .filter(unfiltered)
    .flatMap((example) => {
      const group = [...groups.values()].find(
        (g) => g.slug === lastSegment(example.request.path)
      );
      const detail = example.response
        .body as Schemas['GetSpentExpenseResponse'];
      return group
        ? detail.spent_expenses.map((row): StoredGroupExpense => ({
            slug: randomUUID(),
            group_id: group.id,
            expense_id: row.id,
          }))
        : [];
    });

  const budgetLists = bodies<Schemas['ListBudgetsResponse']>('listBudgets');
  const budgets = budgetLists.flatMap((list) =>
    list.budgets.map((budget): StoredBudget => ({
      id: budget.id,
      month: (shift(`${list.month}-01`) as string).slice(0, 7),
      categorySlug: budget.categorySlug,
      categoryName: budget.categoryName,
      amount: budget.amount,
      formula: budget.formula,
      createdAt: budget.createdAt,
      updatedAt: budget.updatedAt,
    }))
  );

  let nextId =
    Math.max(
      0,
      ...expenses.map((e) => e.id),
      ...incomes.map((i) => i.id),
      ...groups.keys(),
      ...budgets.map((b) => b.id)
    ) + 1;

  const goals = body<Schemas['ListGoalsResponse']>('listGoals', 'all').map(
    (goal): StoredGoal => ({
      id: nextId++,
      slug: goal.slug,
      name: goal.name,
      date: shift(goal.date) as string,
    })
  );

  // Goal targets are only visible through the spending-against-goals report:
  // every category with a non-zero expectation belongs to the goals page's goal.
  const goalsPageGoal = goals.find((g) => g.name.includes('Goal Expenses'));
  const goalCategories = goalsPageGoal
    ? body<Schemas['GetGoalExpensesResponse']>('getGoalExpenses', 'month')
        .filter((row) => Number(row.goal_expectation) !== 0)
        .flatMap((row) => {
          const category = categories.find((c) => c.name === row.name);
          return category
            ? [
                {
                  slug: randomUUID(),
                  goal_id: goalsPageGoal.id,
                  category_id: category.id,
                  goal_expectation: Number(row.goal_expectation),
                  inserted_at: '2026-01-01T09:00:00',
                } satisfies StoredGoalCategory,
              ]
            : [];
        })
    : [];

  return {
    user: body('getCurrentUser', 'signedIn'),
    userId: Number(budgetLists[0]?.userId ?? 1),
    categories,
    types: body('listExpenseTypes', 'all'),
    payed: body('listExpensePayed', 'all'),
    inactive: new Set(),
    tags: body<Schemas['ExpenseTagUsage'][]>('listExpenseTags', 'all').map(
      ({ name, slug }) => ({ name, slug })
    ),
    expenses,
    incomeCategories: body('listIncomeCategories', 'all'),
    incomes,
    groupCategories,
    groups: [...groups.values()],
    groupExpenses,
    budgets,
    goals,
    goalCategories,
    statisticsCards: body('listStatisticsCards', 'all'),
    // One report to start from: what a name rule counts across every year.
    reports: [
      {
        slug: '00000000-0000-4000-8000-000000009801',
        title: 'Rent over the years',
        period: { kind: 'all', start_date: null, end_date: null },
        rows: [
          {
            slug: '00000000-0000-4000-8000-000000009802',
            label: 'Rent',
            match: {
              field: 'name',
              op: 'contains',
              value: 'Rent',
              value_name: null,
            },
            filters: [],
          },
        ],
      },
    ],
    statisticsHidden: body<Schemas['GetStatisticsResponse']>(
      'getStatistics',
      'month'
    ).hidden_sections,
    mcpToken: body<Schemas['GetMcpTokenResponse']>('getMcpToken', 'placeholder')
      .mcp_token,
    serviceToken: body<Schemas['GetServiceTokenResponse']>(
      'getServiceToken',
      'placeholder'
    ).service_token,
    nextId,
  };
}
