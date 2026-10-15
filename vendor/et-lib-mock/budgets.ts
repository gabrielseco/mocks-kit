// Category budgets for a month, and the budget-against-spending summary.
import type { Schemas } from '@/lib/api/client';
import type { Store, StoredBudget } from './store';
import { MockHttpError, type Handlers } from './types';
import {
  extra,
  monthRange,
  round2,
  spendingByCategory,
  stamp,
  sum,
} from './util';

type BudgetOperations = 'listBudgets' | 'getBudgetsSummary' | 'upsertBudgets';

type SummaryCategory =
  Schemas['GetBudgetsSummaryResponse']['categories'][number];

const forMonth = (store: Store, month: string) =>
  store.budgets.filter((budget) => budget.month === month);

const render = (budget: StoredBudget) => ({
  id: budget.id,
  categorySlug: budget.categorySlug,
  categoryName: budget.categoryName,
  amount: round2(budget.amount),
  formula: budget.formula,
  createdAt: budget.createdAt,
  updatedAt: budget.updatedAt,
});

const byCategoryName = (a: StoredBudget, b: StoredBudget) =>
  a.categoryName < b.categoryName
    ? -1
    : a.categoryName > b.categoryName
      ? 1
      : 0;

// Share of the budget spent, to two decimals; nothing when there is no budget.
const percentageUsed = (spent: number, budget: number) =>
  budget === 0 ? null : round2((spent / budget) * 100);

function status(budget: number, percentage: number | null) {
  if (budget === 0 || percentage === null) return 'no-budget';
  if (percentage > 150) return 'over';
  if (percentage >= 125) return 'critical';
  if (percentage >= 100) return 'warning';
  if (percentage >= 70) return 'on-track';
  return 'good';
}

function requireMonth(month: string | undefined): string {
  if (!month) {
    throw new MockHttpError(400, 'Missing required parameter: month');
  }
  return month;
}

export const budgetHandlers: Pick<Handlers, BudgetOperations> = {
  listBudgets: ({ store, query }) => {
    const month = requireMonth(query.month);
    const budgets = forMonth(store, month).toSorted(byCategoryName);

    return {
      status: 200,
      body: {
        month,
        userId: String(store.userId),
        budgets: budgets.map(render),
        totalBudget: round2(sum(budgets.map((b) => b.amount))),
      },
    };
  },

  getBudgetsSummary: ({ store, query }) => {
    const month = requireMonth(query.month);
    const budgets = forMonth(store, month);
    const spending = spendingByCategory(
      store,
      monthRange(month),
      query.date_field
    );

    // One row per category that has a budget or spending this month. The
    // backend walks them in slug order and then sorts by budget, largest
    // first, with budgeted categories ahead of unbudgeted ones.
    const slugs = [
      ...new Set([
        ...budgets.map((b) => b.categorySlug),
        ...spending.map((s) => s.category.slug),
      ]),
    ].sort();

    const categories = slugs
      .map((slug) => {
        const budget = budgets.find((b) => b.categorySlug === slug);
        const spent = spending.find((s) => s.category.slug === slug);
        const budgetAmount = budget?.amount ?? 0;
        const actualSpent = spent?.total ?? 0;
        const percentage = percentageUsed(actualSpent, budgetAmount);

        const row: SummaryCategory = {
          categorySlug: slug,
          categoryName: budget?.categoryName ?? spent?.category.name ?? '',
          budgetAmount: round2(budgetAmount),
          formula: budget?.formula ?? null,
          actualSpent: round2(actualSpent),
          remaining: round2(budgetAmount - actualSpent),
          percentageUsed: percentage,
          status: status(budgetAmount, percentage),
        };
        return { row, budgeted: budget ? 1 : 0, budgetAmount };
      })
      .sort(
        (a, b) => b.budgeted - a.budgeted || b.budgetAmount - a.budgetAmount
      )
      .map(({ row }) => row);

    const totalBudget = sum(budgets.map((b) => b.amount));
    const totalSpent = sum(spending.map((s) => s.total));

    return {
      status: 200,
      body: {
        month,
        userId: String(store.userId),
        totalBudget: round2(totalBudget),
        totalActualExpenses: round2(totalSpent),
        remainingBudget: round2(totalBudget - totalSpent),
        percentageUsed: percentageUsed(totalSpent, totalBudget),
        categories,
      },
    };
  },

  // Saving replaces the whole month, as the backend does.
  upsertBudgets: ({ store, body }) => {
    if (!body.month || !Array.isArray(body.budgets)) {
      throw new MockHttpError(
        400,
        'Missing required parameters: month, budgets'
      );
    }
    if (!/^\d{4}-\d{2}$/.test(body.month)) {
      throw new MockHttpError(400, 'Invalid month format. Expected YYYY-MM');
    }

    const month = body.month;
    const now = stamp();
    const saved = body.budgets.map((budget): StoredBudget => ({
      id: store.nextId++,
      month,
      categorySlug: budget.categorySlug,
      categoryName: budget.categoryName,
      amount: Number(budget.amount) || 0,
      formula: extra<string>(budget, 'formula') ?? null,
      createdAt: now,
      updatedAt: now,
    }));
    store.budgets = [
      ...store.budgets.filter((b) => b.month !== month),
      ...saved,
    ];

    return {
      status: 200,
      body: {
        month,
        userId: store.userId,
        budgets: saved.map(render),
        totalBudget: round2(sum(saved.map((b) => b.amount))),
        saved: saved.length,
      },
    };
  },
};
