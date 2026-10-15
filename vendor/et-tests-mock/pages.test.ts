// The pages beyond Expenses: incomes, budgets, goals, groups and settings.
// The replay test pins their reads against the backend's recordings; these
// cover what a recording can't, which is how they change.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleMockRequest,
  resetMockStore,
  SEED_CLOCK,
} from '@/lib/mock/server';

const SESSION = { cookie: 'session_token=mock-session' };
const JANUARY = 'date=2026-01-01T00:00:00Z';
const slug = (id: number) =>
  `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;

async function call(method: string, path: string, body?: unknown) {
  const response = await handleMockRequest(
    new Request(new URL(path, 'http://mock.test'), {
      method,
      headers: { 'content-type': 'application/json', ...SESSION },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : JSON.parse(text),
  };
}

beforeEach(() => {
  process.env.MOCK_TODAY = SEED_CLOCK;
  resetMockStore(SEED_CLOCK);
});

describe('incomes', () => {
  const bonus = {
    name: 'Bonus',
    income: 300,
    date: '2026-01-20',
    category_id: 9501,
  };

  it('a created income joins its month, total and category listing', async () => {
    const created = await call('POST', '/api/incomes', bonus);
    expect(created.status).toBe(200);

    const month = (await call('GET', `/api/incomes?${JANUARY}`)).body;
    expect(month.total).toBe('2920.50');
    expect(month.incomes.map((i: { name: string }) => i.name)).toEqual([
      'Salary January',
      'Bonus',
      'Expense refund',
    ]);

    const detail = (await call('GET', `/api/incomes/${created.body.slug}`))
      .body;
    expect(detail).toMatchObject({
      name: 'Bonus',
      category: 9501,
      category_name: 'Payslip',
      estimated: false,
      note: null,
    });

    const payslips = await call(
      'GET',
      `/api/incomes/category/${slug(9501)}?year=2026`
    );
    expect(payslips.body.total).toBe('5300.00');
  });

  it('answers 500, like the backend, when a required field is missing', async () => {
    expect(
      (await call('POST', '/api/incomes', { name: 'No amount' })).status
    ).toBe(500);
  });

  it('updates, duplicates one month on, and archives', async () => {
    const refund = slug(9602);

    await call('PUT', `/api/incomes/${refund}`, {
      name: 'Travel refund',
      income: 99,
    });
    expect((await call('GET', `/api/incomes/${refund}`)).body).toMatchObject({
      name: 'Travel refund',
      income: 99,
      date: '2026-01-10',
      note: 'Train tickets',
    });

    const copy = await call('POST', `/api/incomes/${refund}/duplicate`);
    expect(
      (await call('GET', `/api/incomes/${copy.body.slug}`)).body
    ).toMatchObject({
      name: 'Travel refund',
      date: '2026-02-10',
    });

    expect((await call('DELETE', `/api/incomes/${refund}`)).status).toBe(204);
    expect((await call('GET', `/api/incomes/${refund}`)).status).toBe(404);
    expect((await call('DELETE', `/api/incomes/${refund}`)).status).toBe(404);
    expect((await call('GET', `/api/incomes?${JANUARY}`)).body.total).toBe(
      '2500.00'
    );
  });
});

describe('budgets', () => {
  it('follows spending: a new expense moves the category and the totals', async () => {
    await call('POST', '/api/expenses', {
      name: 'Big shop',
      expense: 100,
      date: '2026-01-16',
      category_id: 9101,
      type_id: 9201,
      payed_id: 9301,
    });

    const summary = (await call('GET', '/api/budgets/summary?month=2026-01'))
      .body;
    const groceries = summary.categories.find(
      (c: { categoryName: string }) => c.categoryName === 'Groceries'
    );
    // 235.95 of 200.00
    expect(groceries).toMatchObject({
      actualSpent: 235.95,
      remaining: -35.95,
      percentageUsed: 117.98,
      status: 'warning',
    });
    expect(summary.totalActualExpenses).toBe(1330.34);
  });

  it('saving replaces the whole month and leaves other months alone', async () => {
    const saved = await call('POST', '/api/budgets/batch', {
      month: '2026-01',
      budgets: [
        {
          categorySlug: slug(9102),
          categoryName: 'Rent',
          amount: 1000,
          formula: '950+50',
        },
      ],
    });
    expect(saved.body).toMatchObject({
      saved: 1,
      totalBudget: 1000,
      userId: 9001,
    });

    const list = (await call('GET', '/api/budgets?month=2026-01')).body;
    expect(list.budgets).toHaveLength(1);
    expect(list.budgets[0]).toMatchObject({
      categoryName: 'Rent',
      formula: '950+50',
    });

    const summary = (await call('GET', '/api/budgets/summary?month=2026-01'))
      .body;
    expect(summary.categories[0]).toMatchObject({
      categoryName: 'Rent',
      percentageUsed: 95,
      status: 'on-track',
    });
    expect(
      summary.categories.find(
        (c: { categoryName: string }) => c.categoryName === 'Groceries'
      ).status
    ).toBe('no-budget');
  });

  it('asks for the month', async () => {
    expect((await call('GET', '/api/budgets')).status).toBe(400);
    expect((await call('GET', '/api/budgets/summary')).status).toBe(400);
    expect(
      (await call('POST', '/api/budgets/batch', { budgets: [] })).status
    ).toBe(400);
  });
});

describe('goals', () => {
  it('a new target shows up in the spending report', async () => {
    const goal = slug(9901);
    const added = await call('POST', `/api/goals/${goal}/categories`, {
      categories: [{ category_id: 9103, goal_expectation: 1200 }],
    });
    expect(added.status).toBe(201);
    expect(added.body[0]).toMatchObject({
      category_id: 9103,
      goal_expectation: 1200,
    });

    const report = (
      await call(
        'GET',
        '/api/goals/expenses?year=2026&start_month=01&end_month=01'
      )
    ).body;
    expect(report.map((row: { name: string }) => row.name).slice(0, 3)).toEqual(
      ['Groceries', 'Transport', 'Restaurants']
    );
    expect(report[1]).toEqual({
      name: 'Transport',
      expenses_sum: '73.00',
      goal_expectation: '1200.00',
      percentage: '6.08',
    });
  });

  it('rejects an unknown goal or category', async () => {
    const unknownGoal = await call('POST', `/api/goals/${slug(1)}/categories`, {
      categories: [{ category_id: 9103 }],
    });
    expect(unknownGoal).toMatchObject({
      status: 404,
      body: { error: 'Goal not found' },
    });

    const unknownCategory = await call(
      'POST',
      `/api/goals/${slug(9901)}/categories`,
      {
        categories: [{ category_id: 1 }],
      }
    );
    expect(unknownCategory).toMatchObject({
      status: 404,
      body: { error: 'Category not found' },
    });
  });

  it('creates a goal that the list then returns', async () => {
    const created = await call('POST', '/api/goals', {
      name: 'Goal Savings',
      date: '2026-03-01',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Goal Savings', user_id: 9001 });

    const names = (await call('GET', '/api/goals')).body.map(
      (g: { name: string }) => g.name
    );
    expect(names).toEqual(['Goal Savings', 'Goal Expenses']);
  });
});

describe('groups', () => {
  it('creates a group, fills it, and totals it', async () => {
    const created = await call('POST', '/api/spent-expenses', {
      name: 'Ski trip',
      start_date: '2026-02-20',
      end_date: '2026-02-23',
      category_id: 9701,
    });
    expect(created.status).toBe(200);

    const filled = await call('POST', '/api/spent-expenses/expenses', {
      slug: created.body.slug,
      checkboxes: [slug(9405), slug(9407)],
    });
    expect(filled.status).toBe(200);

    const detail = (
      await call('GET', `/api/spent-expenses/${created.body.slug}`)
    ).body;
    expect(detail.total).toBe('65.59');
    expect(detail.spent_expenses.map((e: { name: string }) => e.name)).toEqual([
      'Music streaming',
      'Metro pass',
    ]);

    const listed = (
      await call('GET', '/api/spent-expenses?year=2026')
    ).body.find((g: { name: string }) => g.name === 'Ski trip');
    expect(listed.total).toBe('65.59€');
  });

  it('rejects a group in an unknown category', async () => {
    const response = await call('POST', '/api/spent-expenses', {
      name: 'Nowhere',
      start_date: '2026-02-20',
      end_date: '2026-02-23',
      category_id: 1,
    });
    expect(response).toMatchObject({
      status: 422,
      body: { error: 'Category not found' },
    });
  });

  it('an archived expense leaves its group', async () => {
    await call('DELETE', `/api/expenses/${slug(9410)}`);

    const porto = (await call('GET', `/api/spent-expenses/${slug(9802)}`)).body;
    expect(porto.total).toBe('32.50');
    expect(porto.spent_expenses).toHaveLength(1);
  });

  it('deletes a group and drops its year when it was the last one there', async () => {
    expect(
      (await call('DELETE', `/api/spent-expenses/${slug(9801)}`)).status
    ).toBe(204);
    expect(
      (await call('GET', `/api/spent-expenses/${slug(9801)}`)).status
    ).toBe(404);
    expect((await call('GET', '/api/spent-expenses/years')).body).toEqual([
      2026,
    ]);
  });

  it('removing an expense needs the membership slug, not the expense slug', async () => {
    const response = await call(
      'DELETE',
      `/api/spent-expenses/expenses/${slug(9408)}`
    );
    expect(response.status).toBe(404);
  });
});

describe('settings', () => {
  it('regenerating a token replaces it', async () => {
    const before = (await call('GET', '/api/settings/mcp-token')).body
      .mcp_token;
    const regenerated = (
      await call('POST', '/api/settings/mcp-token/regenerate')
    ).body.mcp_token;

    expect(regenerated).not.toBe(before);
    expect((await call('GET', '/api/settings/mcp-token')).body.mcp_token).toBe(
      regenerated
    );
  });
});

describe('category admin', () => {
  const groceries = slug(9101);
  const names = (rows: { name: string }[]) => rows.map((row) => row.name);

  it('a new category is listed, selectable and unused', async () => {
    const created = await call('POST', '/api/categories/expense', {
      name: 'Books',
    });
    expect(created).toMatchObject({
      status: 201,
      body: { name: 'Books', active: true, usage_count: 0 },
    });

    expect(
      names((await call('GET', '/api/categories/expense')).body)
    ).toContain('Books');
    expect(
      names((await call('GET', '/api/expenses/categories')).body)
    ).toContain('Books');
  });

  it('refuses a blank or duplicate name', async () => {
    for (const name of ['  ', 'Groceries']) {
      const response = await call('POST', '/api/categories/expense', { name });
      expect(response.status, name).toBe(422);
      expect(response.body.errors.name).toHaveLength(1);
    }

    const renamed = await call('PUT', `/api/categories/expense/${groceries}`, {
      name: 'Rent',
    });
    expect(renamed.body).toEqual({
      errors: { name: ['has already been taken'] },
    });
  });

  it('a rename reaches the expenses that use the category', async () => {
    const renamed = await call('PUT', `/api/categories/expense/${groceries}`, {
      name: 'Food',
    });
    expect(renamed.body).toMatchObject({ name: 'Food', usage_count: 5 });

    const month = (await call('GET', `/api/expenses?${JANUARY}`)).body;
    expect(names(month.expenses_by_categories)).toContain('Food');
    expect(names(month.expenses_by_categories)).not.toContain('Groceries');
  });

  it('deactivating hides it from the picker, keeps its expenses, and reverses', async () => {
    const path = `/api/categories/expense/${groceries}`;
    expect((await call('DELETE', path)).status).toBe(204);

    const picker = (await call('GET', '/api/expenses/categories')).body;
    expect(names(picker)).not.toContain('Groceries');

    const admin = (await call('GET', '/api/categories/expense')).body;
    expect(admin).toContainEqual(
      expect.objectContaining({
        name: 'Groceries',
        active: false,
        usage_count: 5,
      })
    );
    const month = (await call('GET', `/api/expenses?${JANUARY}`)).body;
    expect(names(month.expenses_by_categories)).toContain('Groceries');

    expect((await call('PUT', `${path}/activate`)).body.active).toBe(true);
    expect(
      names((await call('GET', '/api/expenses/categories')).body)
    ).toContain('Groceries');
  });

  it('types and payment methods deactivate the same way', async () => {
    for (const [kind, picker] of [
      ['type', '/api/expenses/types'],
      ['payed', '/api/expenses/payed'],
    ]) {
      const [first] = (await call('GET', `/api/categories/${kind}`)).body;
      await call('DELETE', `/api/categories/${kind}/${first.slug}`);

      expect(names((await call('GET', picker)).body), kind).not.toContain(
        first.name
      );
    }
  });

  it('a payment method links a broker account, lower-cased, and unlinks it', async () => {
    const created = (
      await call('POST', '/api/categories/payed', {
        name: 'Degiro',
        broker_account: 'DEGIRO',
      })
    ).body;
    expect(created.broker_account).toBe('degiro');

    const unlinked = await call(
      'PUT',
      `/api/categories/payed/${created.slug}`,
      {
        broker_account: '',
      }
    );
    expect(unlinked.body).toMatchObject({
      name: 'Degiro',
      broker_account: null,
    });
  });

  it.each(['income', 'spent-expense'])(
    '%s: deletes an unused row, refuses a used one, has nothing to activate',
    async (kind) => {
      const used = (await call('GET', `/api/categories/${kind}`)).body.find(
        (row: { usage_count: number }) => row.usage_count > 0
      );
      expect(
        await call('DELETE', `/api/categories/${kind}/${used.slug}`)
      ).toEqual({
        status: 409,
        body: { error: 'Category is still in use' },
      });

      const spare = (
        await call('POST', `/api/categories/${kind}`, { name: 'Spare' })
      ).body;
      expect(
        (await call('PUT', `/api/categories/${kind}/${spare.slug}/activate`))
          .status
      ).toBe(422);
      expect(
        (await call('DELETE', `/api/categories/${kind}/${spare.slug}`)).status
      ).toBe(204);
      expect(
        names((await call('GET', `/api/categories/${kind}`)).body)
      ).not.toContain('Spare');
    }
  );

  it('answers 404 for an unknown kind or slug', async () => {
    expect((await call('GET', '/api/categories/bogus')).status).toBe(404);
    expect(
      (await call('DELETE', `/api/categories/expense/${slug(1)}`)).status
    ).toBe(404);
  });
});
