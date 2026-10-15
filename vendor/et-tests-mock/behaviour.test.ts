// What the recordings can't pin: login, mutations and the mock's own guards.
import { beforeEach, describe, expect, it } from 'vitest';
import { MOCK_LOGIN_CODE } from '@/lib/mock/handlers';
import {
  handleMockRequest,
  resetMockStore,
  SEED_CLOCK,
} from '@/lib/mock/server';
import { createStore, shiftMonths } from '@/lib/mock/store';
import { validate } from '@/lib/mock/validate';

const SESSION = { cookie: 'session_token=mock-session' };
const JANUARY = '/api/expenses?date=2026-01-01T00:00:00Z';

async function call(
  method: string,
  path: string,
  { body, headers = SESSION }: { body?: unknown; headers?: HeadersInit } = {}
) {
  const response = await handleMockRequest(
    new Request(new URL(path, 'http://mock.test'), {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : JSON.parse(text),
    setCookie: response.headers.get('set-cookie'),
  };
}

const newExpense = {
  name: 'Bookshop',
  expense: 20.5,
  date: '2026-01-09',
  category_id: 9101,
  type_id: 9201,
  payed_id: 9301,
};

beforeEach(() => {
  process.env.MOCK_TODAY = SEED_CLOCK;
  resetMockStore(SEED_CLOCK);
});

describe('session', () => {
  it('signs in with the mock code and any email, and rejects other codes', async () => {
    const ok = await call('POST', '/api/auth/verify_code', {
      body: { email: 'anyone@example.com', code: MOCK_LOGIN_CODE },
      headers: {},
    });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe('demo@example.com');
    expect(ok.setCookie).toContain('session_token=mock-session');
    expect(ok.setCookie).toContain('HttpOnly');

    const wrong = await call('POST', '/api/auth/verify_code', {
      body: { email: 'anyone@example.com', code: '000000' },
      headers: {},
    });
    expect(wrong).toMatchObject({
      status: 401,
      body: { error: 'Invalid or expired code' },
      setCookie: null,
    });
  });

  it('requires the session cookie on every authed operation', async () => {
    for (const [method, path] of [
      ['GET', '/api/me'],
      ['GET', JANUARY],
      ['POST', '/api/expenses'],
      ['DELETE', '/api/auth/logout'],
    ]) {
      const response = await call(method, path, { headers: {} });
      expect(response, `${method} ${path}`).toMatchObject({
        status: 401,
        body: { error: 'Unauthorized' },
      });
    }
  });

  it('clears the cookie on logout', async () => {
    const response = await call('DELETE', '/api/auth/logout');
    expect(response.status).toBe(204);
    expect(response.setCookie).toContain('Max-Age=0');
  });
});

describe('expense mutations', () => {
  it('a created expense shows up in its month, its total and its category sum', async () => {
    const before = (await call('GET', JANUARY)).body;
    const created = await call('POST', '/api/expenses', { body: newExpense });
    expect(created.status).toBe(200);

    const after = (await call('GET', JANUARY)).body;
    expect(after.expenses).toHaveLength(before.expenses.length + 1);
    expect(Number(after.total)).toBeCloseTo(Number(before.total) + 20.5, 2);
    expect(after.expenses.map((e: { name: string }) => e.name)).toContain(
      'Bookshop'
    );

    const detail = await call('GET', `/api/expenses/${created.body.slug}`);
    expect(detail.body).toMatchObject({
      name: 'Bookshop',
      note: null,
      payment_date: null,
      category: 9101,
      type: 9201,
      payed: 9301,
    });
  });

  it('answers 500, like the backend, when a required field is missing', async () => {
    const response = await call('POST', '/api/expenses', {
      body: { name: 'No amount' },
    });
    expect(response.status).toBe(500);
    expect(response.body.mock).toBe(true);
  });

  it('updates only the fields that were sent', async () => {
    const slug = '00000000-0000-4000-8000-000000009406';
    const updated = await call('PUT', `/api/expenses/${slug}`, {
      body: { name: 'Big shop', expense: 99, category_id: 9104 },
    });
    expect(updated).toMatchObject({ status: 200, body: { slug } });

    const detail = (await call('GET', `/api/expenses/${slug}`)).body;
    expect(detail).toMatchObject({
      name: 'Big shop',
      expense: 99,
      category: 9104,
      date: '2026-01-03',
      note: 'Weekly shop',
    });
  });

  it('duplicates one month on, without the payment date', async () => {
    const original = '00000000-0000-4000-8000-000000009411';
    const copy = await call('POST', `/api/expenses/${original}/duplicate`);
    expect(copy.status).toBe(200);
    expect(copy.body.slug).not.toBe(original);

    const detail = (await call('GET', `/api/expenses/${copy.body.slug}`)).body;
    expect(detail).toMatchObject({
      name: 'Pizza night',
      date: '2026-02-13',
      payment_date: null,
    });
  });

  it('archives: the expense leaves the lists and its slug stops resolving', async () => {
    const slug = '00000000-0000-4000-8000-000000009406';
    expect((await call('DELETE', `/api/expenses/${slug}`)).status).toBe(204);

    expect((await call('GET', `/api/expenses/${slug}`)).status).toBe(404);
    expect((await call('DELETE', `/api/expenses/${slug}`)).status).toBe(404);
    expect(
      (await call('PUT', `/api/expenses/${slug}`, { body: {} })).status
    ).toBe(404);

    const january = (await call('GET', JANUARY)).body;
    expect(january.expenses.map((e: { slug: string }) => e.slug)).not.toContain(
      slug
    );
  });

  it('reset restores the recorded data', async () => {
    await call('POST', '/api/expenses', { body: newExpense });
    expect((await call('POST', '/api/__mock/reset')).status).toBe(204);

    const names = (await call('GET', JANUARY)).body.expenses.map(
      (e: { name: string }) => e.name
    );
    expect(names).not.toContain('Bookshop');
  });
});

describe('guards', () => {
  it('answers 501 with an explanation for an endpoint outside the contract', async () => {
    const response = await call('GET', '/api/crm/trips');
    expect(response.status).toBe(501);
    expect(response.body.error).toContain(
      'Mock mode has no GET /api/crm/trips'
    );
  });

  it('answers 501 for a contract operation the mock does not implement', async () => {
    const response = await call('POST', '/api/transactions', {
      body: { quantity: '1' },
    });
    expect(response.status).toBe(501);
    expect(response.body.error).toContain('createTransaction');
  });

  it('answers 400 when a list is asked for with neither a month nor a range', async () => {
    expect((await call('GET', '/api/expenses')).status).toBe(400);
  });
});

describe('replay-only pages', () => {
  it('answers from the recording whatever filter is asked for', async () => {
    const asked = await call('GET', '/api/theses?stance=not_interested');
    expect(asked.status).toBe(200);
    expect(asked.body.theses).toHaveLength(2);
  });

  it('slides recorded dates onto the current month, like the stores do', async () => {
    process.env.MOCK_TODAY = '2026-10-10';
    const dates = (
      await call('GET', '/api/transactions')
    ).body.transactions.map((t: { date: string }) => t.date);

    // Recorded in December 2025 with the clock in January 2026.
    expect(dates).toContain('2026-09-01');
  });

  it('picks the recording made with the closest query', async () => {
    const eur = await call(
      'GET',
      '/api/holdings?base_currency=EUR&sort=name&order=asc'
    );
    expect(eur.body.portfolio.currency).toBe('EUR');

    const usd = await call('GET', '/api/holdings?base_currency=USD');
    expect(usd.body.portfolio.currency).toBe('USD');

    // A value nobody recorded falls back to the first recording.
    const other = await call('GET', '/api/holdings?base_currency=GBP');
    expect(other.status).toBe(200);
  });

  it('404s a detail that was not recorded', async () => {
    expect((await call('GET', '/api/theses/1')).status).toBe(404);
  });
});

describe('store dates', () => {
  it('slides the recorded month onto the current one', () => {
    const recorded = createStore(SEED_CLOCK).expenses.find(
      (e) => e.id === 9406
    );
    const shifted = createStore('2026-10-10').expenses.find(
      (e) => e.id === 9406
    );

    expect(recorded?.date).toBe('2026-01-03');
    expect(shifted?.date).toBe('2026-10-03');
  });

  it('shifts months across years and clamps to the last day', () => {
    expect(shiftMonths('2025-12-28', 1)).toBe('2026-01-28');
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonths('2026-01-15', -2)).toBe('2025-11-15');
  });
});

describe('contract validation of mock responses', () => {
  const row = { $ref: '#/components/schemas/ExpenseRow' };
  const valid = {
    id: 1,
    name: 'A',
    note: null,
    expense: 1.5,
    categoryName: 'C',
    date: '2026-01-03',
    payment_date: null,
    slug: '00000000-0000-4000-8000-000000009406',
    tags: [],
  };

  it('accepts a row shaped like the backend sends it', () => {
    expect(validate(valid, row)).toEqual([]);
  });

  it('rejects coerced types, extra keys, missing keys and bad formats', () => {
    expect(validate({ ...valid, expense: '1.5' }, row)).toEqual([
      '$.expense: is string, expected number',
    ]);
    expect(validate({ ...valid, extra: true }, row)).toEqual([
      '$.extra: is not declared in the schema',
    ]);
    expect(validate({ ...valid, date: '03/01/2026' }, row)[0]).toContain(
      'not an ISO 8601 date'
    );

    const withoutSlug: Record<string, unknown> = { ...valid };
    delete withoutSlug.slug;
    expect(validate(withoutSlug, row)).toEqual(['$.slug: is missing']);
  });
});

describe('statistics cards', () => {
  const CARDS = '/api/statistics/cards';
  const JANUARY_STATS = '/api/statistics?year=2026&start_month=01&end_month=01';
  const cardsIn = async (path = JANUARY_STATS) =>
    (await call('GET', path)).body.cards;

  it('builds a card whose rows follow the period and count an expense once', async () => {
    const created = await call('POST', CARDS, { body: { title: ' Out ' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Out', rows: [] });
    const rows = `${CARDS}/${created.body.slug}/rows`;

    const byName = await call('POST', rows, {
      body: {
        label: 'Metro',
        match: { field: 'name', op: 'starts', value: 'METRO' },
      },
    });
    expect(byName.status).toBe(201);

    const transport = '00000000-0000-4000-8000-000000009103';
    const byCategory = await call('POST', rows, {
      body: {
        label: 'Transport',
        match: { field: 'category', value: transport },
      },
    });
    expect(byCategory.body.rows[1].match).toEqual({
      field: 'category',
      op: null,
      value: transport,
      value_name: 'Transport',
    });

    // Metro pass (54.60) is in Transport (73.00) too.
    const [, , card] = await cardsIn();
    expect(card).toMatchObject({
      title: 'Out',
      count: 2,
      total: 73,
      media: 73,
    });
    expect(card.rows.map((row: { total: number }) => row.total)).toEqual([
      54.6, 73,
    ]);

    const december = await cardsIn(
      '/api/statistics?year=2025&start_month=12&end_month=12'
    );
    expect(december[2]).toMatchObject({ count: 0, total: 0 });
  });

  it('follows expenses added elsewhere', async () => {
    const before = (await cardsIn())[1].rows[0];
    await call('POST', '/api/expenses', {
      body: { ...newExpense, name: 'Supermarket' },
    });
    const after = (await cardsIn())[1].rows[0];

    expect(after.count).toBe(before.count + 1);
    expect(after.total).toBeCloseTo(before.total + newExpense.expense);
  });

  it('renames, reorders and deletes cards, and edits and removes rows', async () => {
    const [home, food] = (await call('GET', CARDS)).body;

    const renamed = await call('PUT', `${CARDS}/${home.slug}`, {
      body: { title: 'House' },
    });
    expect(renamed.body.title).toBe('House');

    const reordered = await call('PUT', `${CARDS}/order`, {
      body: { slugs: [food.slug, 'unknown'] },
    });
    expect(reordered.body.map((card: { title: string }) => card.title)).toEqual(
      ['Food', 'House']
    );

    const row = home.rows[0];
    const relabelled = await call(
      'PUT',
      `${CARDS}/${home.slug}/rows/${row.slug}`,
      { body: { label: 'Landlord' } }
    );
    expect(relabelled.body.rows[0]).toMatchObject({
      label: 'Landlord',
      match: row.match,
    });

    expect(
      (await call('DELETE', `${CARDS}/${home.slug}/rows/${row.slug}`)).status
    ).toBe(204);
    expect((await call('DELETE', `${CARDS}/${food.slug}`)).status).toBe(204);
    expect((await call('GET', CARDS)).body).toMatchObject([
      { title: 'House', rows: [{ label: 'Subscriptions' }] },
    ]);
  });

  it('refuses what the backend refuses', async () => {
    const [home] = (await call('GET', CARDS)).body;
    const rows = `${CARDS}/${home.slug}/rows`;
    const errors = async (body: unknown) =>
      (await call('POST', rows, { body })).body;

    expect((await call('POST', CARDS, { body: { title: ' ' } })).body).toEqual({
      errors: { title: ["can't be blank"] },
    });
    expect(
      await errors({
        label: 'x',
        match: { field: 'name', op: 'like', value: 'x' },
      })
    ).toEqual({ errors: { match_op: ['is invalid'] } });
    expect(
      await errors({ label: 'x', match: { field: 'category', value: 'nope' } })
    ).toEqual({ errors: { category_id: ["can't be blank"] } });
    expect(await errors({ label: 'x' })).toEqual({
      errors: { match_field: ["can't be blank"] },
    });

    expect(
      (await call('PUT', `${CARDS}/nope`, { body: { title: 'x' } })).status
    ).toBe(404);
    expect((await call('DELETE', `${rows}/nope`)).body).toEqual({
      error: 'Row not found',
    });
  });

  it('remembers the hidden sections', async () => {
    const saved = await call('PUT', '/api/statistics/layout', {
      body: { hidden_sections: ['income_categories'] },
    });
    expect(saved.body).toEqual({ hidden_sections: ['income_categories'] });
    expect((await call('GET', JANUARY_STATS)).body.hidden_sections).toEqual([
      'income_categories',
    ]);

    const unknown = await call('PUT', '/api/statistics/layout', {
      body: { hidden_sections: ['car'] },
    });
    expect(unknown).toMatchObject({
      status: 422,
      body: { error: 'unknown sections: "car"' },
    });
  });
});

describe('expense tags', () => {
  // Seeded tags: "supermarket" is on four expenses, "gift" on none.
  const SUPERMARKET = '00000000-0000-4000-8000-000000009454';
  const GIFT = '00000000-0000-4000-8000-000000009453';
  const TAXI_HOME = '/api/expenses/00000000-0000-4000-8000-000000009410';

  const tagNames = async (path: string) =>
    ((await call('GET', path)).body.tags as { name: string }[]).map(
      (tag) => tag.name
    );

  it('creates an expense with tags and shows them in the list and the detail', async () => {
    const created = await call('POST', '/api/expenses', {
      body: { ...newExpense, tags: [SUPERMARKET, GIFT] },
    });
    expect(created.status).toBe(200);

    expect(await tagNames(`/api/expenses/${created.body.slug}`)).toEqual([
      'gift',
      'supermarket',
    ]);

    const list = await call('GET', JANUARY);
    const row = list.body.expenses.find(
      (e: { slug: string }) => e.slug === created.body.slug
    );
    expect(row.tags.map((tag: { name: string }) => tag.name)).toEqual([
      'gift',
      'supermarket',
    ]);
  });

  it('replaces the tags on update when sent, and keeps them when not', async () => {
    expect(await tagNames(TAXI_HOME)).toEqual(['taxi']);

    await call('PUT', TAXI_HOME, { body: { name: 'Taxi back' } });
    expect(await tagNames(TAXI_HOME)).toEqual(['taxi']);

    await call('PUT', TAXI_HOME, { body: { tags: [GIFT] } });
    expect(await tagNames(TAXI_HOME)).toEqual(['gift']);

    await call('PUT', TAXI_HOME, { body: { tags: [] } });
    expect(await tagNames(TAXI_HOME)).toEqual([]);
  });

  it('refuses a tag that is not the user’s, changing nothing', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';

    const created = await call('POST', '/api/expenses', {
      body: { ...newExpense, tags: [unknown] },
    });
    expect(created.status).toBe(422);
    expect(created.body).toEqual({ error: 'Tag not found' });

    const updated = await call('PUT', TAXI_HOME, { body: { tags: [unknown] } });
    expect(updated.status).toBe(422);
    expect(await tagNames(TAXI_HOME)).toEqual(['taxi']);
  });

  it('copies the tags when duplicating', async () => {
    const copy = await call('POST', `${TAXI_HOME}/duplicate`);
    expect(await tagNames(`/api/expenses/${copy.body.slug}`)).toEqual(['taxi']);
  });

  it('creates, renames and deletes tags, counting the expenses that carry each', async () => {
    const created = await call('POST', '/api/expenses/tags', {
      body: { name: '  bus ' },
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('bus');

    const duplicate = await call('POST', '/api/expenses/tags', {
      body: { name: 'BUS' },
    });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.errors.name).toEqual(['has already been taken']);

    const renamed = await call(
      'PUT',
      `/api/expenses/tags/${created.body.slug}`,
      { body: { name: 'coach' } }
    );
    expect(renamed.body).toEqual({ name: 'coach', slug: created.body.slug });

    const usage = async () =>
      Object.fromEntries(
        (
          (await call('GET', '/api/expenses/tags')).body as {
            name: string;
            usage_count: number;
          }[]
        ).map((tag) => [tag.name, tag.usage_count])
      );
    expect(await usage()).toMatchObject({ coach: 0, supermarket: 4, taxi: 1 });

    const taxi = '00000000-0000-4000-8000-000000009455';
    expect((await call('DELETE', `/api/expenses/tags/${taxi}`)).status).toBe(
      204
    );
    expect(await usage()).not.toHaveProperty('taxi');
    expect(await tagNames(TAXI_HOME)).toEqual([]);

    expect((await call('DELETE', `/api/expenses/tags/${taxi}`)).status).toBe(
      404
    );
  });

  it('tags every expense of a group once', async () => {
    const groups = await call('GET', '/api/spent-expenses?year=2026');
    const group = groups.body[0];
    const detail = await call('GET', `/api/spent-expenses/${group.slug}`);
    const size = detail.body.spent_expenses.length;
    const path = `/api/spent-expenses/${group.slug}/tags`;

    const first = await call('POST', path, { body: { tag: GIFT } });
    expect(first.body).toEqual({ expenses: size, tagged: size });

    const again = await call('POST', path, { body: { tag: GIFT } });
    expect(again.body).toEqual({ expenses: size, tagged: 0 });

    const missing = await call('POST', path, { body: { tag: 'nope' } });
    expect(missing.status).toBe(422);
  });

  it('tags and untags many expenses at once, skipping slugs that are not theirs', async () => {
    const one = await call('GET', TAXI_HOME);
    const slug = one.body.slug as string;
    const path = `/api/expenses/tags/${GIFT}/expenses`;

    const tagged = await call('POST', path, {
      body: { expense_slugs: [slug, 'not-an-expense'] },
    });
    expect(tagged).toMatchObject({
      status: 200,
      body: { tag: { slug: GIFT }, matched: 1, changed: 1 },
    });
    expect(await tagNames(TAXI_HOME)).toContain('gift');

    const again = await call('POST', path, { body: { expense_slugs: [slug] } });
    expect(again.body).toMatchObject({ matched: 1, changed: 0 });

    const untagged = await call('DELETE', path, {
      body: { expense_slugs: [slug] },
    });
    expect(untagged.body).toMatchObject({ matched: 1, changed: 1 });
    expect(await tagNames(TAXI_HOME)).not.toContain('gift');
  });

  it('lists a whole year of expenses with start_date and end_date', async () => {
    const year = await call(
      'GET',
      '/api/expenses?start_date=2025-01-01&end_date=2026-12-31'
    );
    const month = await call('GET', JANUARY);
    expect(year.status).toBe(200);
    expect(year.body.expenses.length).toBeGreaterThan(
      month.body.expenses.length
    );
    const months = new Set(
      year.body.expenses.map((e: { date: string }) => e.date.slice(0, 7))
    );
    expect(months.size).toBeGreaterThan(1);
    expect(year.body.expenses[0]).toHaveProperty('categoryName');
  });

  it('tags and untags with several tags in one request, all or nothing', async () => {
    const slug = (await call('GET', TAXI_HOME)).body.slug as string;
    const path = '/api/expenses/tags/expenses';

    const tagged = await call('POST', path, {
      body: { tag_slugs: [GIFT, SUPERMARKET], expense_slugs: [slug, 'nope'] },
    });
    expect(tagged.status).toBe(200);
    expect(tagged.body).toMatchObject({ matched: 1, changed: 2 });
    expect(tagged.body.tags.map((t: { name: string }) => t.name)).toEqual([
      'gift',
      'supermarket',
    ]);
    expect(await tagNames(TAXI_HOME)).toEqual(
      expect.arrayContaining(['gift', 'supermarket', 'taxi'])
    );

    const untagged = await call('DELETE', path, {
      body: { tag_slugs: [GIFT], expense_slugs: [slug] },
    });
    expect(untagged.body).toMatchObject({ matched: 1, changed: 1 });
    expect(await tagNames(TAXI_HOME)).not.toContain('gift');
    expect(await tagNames(TAXI_HOME)).toContain('supermarket');

    const stranger = await call('POST', path, {
      body: {
        tag_slugs: [GIFT, '00000000-0000-4000-8000-000000000000'],
        expense_slugs: [slug],
      },
    });
    expect(stranger.status).toBe(404);
    expect(await tagNames(TAXI_HOME)).not.toContain('gift');

    for (const body of [{}, { tag_slugs: [], expense_slugs: [] }]) {
      expect((await call('POST', path, { body })).status).toBe(422);
    }
  });

  it('answers 404 for an unknown tag and 422 without a list of slugs', async () => {
    const missing = await call(
      'POST',
      '/api/expenses/tags/00000000-0000-4000-8000-000000000000/expenses',
      { body: { expense_slugs: [] } }
    );
    expect(missing.status).toBe(404);

    const noList = await call('POST', `/api/expenses/tags/${GIFT}/expenses`, {
      body: {},
    });
    expect(noList.status).toBe(422);
  });
});

describe('statistics rows by tag, and their filters', () => {
  const EATING_OUT = '00000000-0000-4000-8000-000000009451';
  const FOR_OTHERS = '00000000-0000-4000-8000-000000009202';
  const FOOD = '/api/statistics/cards/00000000-0000-4000-8000-000000009922';
  const PREVIEW =
    '/api/statistics/cards/preview?year=2026&start_month=01&end_month=01';
  const tagRule = { field: 'tag', value: EATING_OUT };

  it('adds a row by tag with a filter, counts it, and edits its filters', async () => {
    const created = await call('POST', `${FOOD}/rows`, {
      body: {
        label: 'Not for others',
        match: tagRule,
        filters: [{ field: 'type', value: FOR_OTHERS, exclude: true }],
      },
    });
    expect(created.status).toBe(201);
    const row = created.body.rows.at(-1);
    expect(row.match).toMatchObject({ field: 'tag', value_name: 'eating out' });
    expect(row.filters).toEqual([
      {
        field: 'type',
        value: FOR_OTHERS,
        value_name: 'For others',
        exclude: true,
      },
    ]);

    const counted = async () => {
      const page = await call(
        'GET',
        '/api/statistics?year=2026&start_month=01&end_month=01'
      );
      const card = page.body.cards.find(
        (c: { title: string }) => c.title === 'Food'
      );
      return card.rows.find((r: { slug: string }) => r.slug === row.slug);
    };
    // Pizza night; Lunch with Ana was for others.
    expect(await counted()).toMatchObject({ count: 1, total: 27.9 });

    const path = `${FOOD}/rows/${row.slug}`;
    await call('PUT', path, { body: { label: 'Renamed' } });
    expect((await counted()).filters).toHaveLength(1);

    await call('PUT', path, { body: { filters: [] } });
    expect(await counted()).toMatchObject({ count: 2, total: 60.4 });
  });

  it('refuses a filter that is not one of the user’s lookups', async () => {
    for (const filter of [
      { field: 'type', value: 'nope' },
      { field: 'name', value: 'x' },
    ]) {
      const refused = await call('POST', `${FOOD}/rows`, {
        body: { label: 'x', match: tagRule, filters: [filter] },
      });
      expect(refused.status).toBe(422);
      expect(refused.body.errors.filters).toHaveLength(1);
    }
  });

  it('previews with only and except', async () => {
    const rule = `${PREVIEW}&field=tag&value=${EATING_OUT}`;
    expect((await call('GET', rule)).body.count).toBe(2);
    expect(
      (await call('GET', `${rule}&only=type:${FOR_OTHERS}`)).body.total
    ).toBe(32.5);
    expect(
      (await call('GET', `${rule}&except=type:${FOR_OTHERS}`)).body.total
    ).toBe(27.9);
    expect((await call('GET', `${rule}&except=type:nope`)).status).toBe(422);
  });
});

describe('the expenses a statistics rule matches', () => {
  const EATING_OUT = '00000000-0000-4000-8000-000000009451';
  const FOR_OTHERS = '00000000-0000-4000-8000-000000009202';
  const JANUARY_RULE = `field=tag&value=${EATING_OUT}&year=2026&start_month=01&end_month=01`;
  const list = (query: string) =>
    call('GET', `/api/statistics/cards/expenses?${query}`);
  const preview = (query: string) =>
    call('GET', `/api/statistics/cards/preview?${query}`);

  it('lists every match with the figures the preview gives, and the rule named', async () => {
    for (const query of [
      JANUARY_RULE,
      `${JANUARY_RULE}&except=type:${FOR_OTHERS}`,
      'field=name&op=contains&value=a&year=2026&start_month=01&end_month=02',
    ]) {
      const [listed, previewed] = [await list(query), await preview(query)];
      expect(listed.status).toBe(200);
      expect(listed.body.expenses).toHaveLength(listed.body.count);
      expect([listed.body.count, listed.body.total, listed.body.media]).toEqual(
        [previewed.body.count, previewed.body.total, previewed.body.media]
      );
    }

    const narrowed = await list(`${JANUARY_RULE}&except=type:${FOR_OTHERS}`);
    expect(narrowed.body.rule.filters).toEqual([
      {
        field: 'type',
        value: FOR_OTHERS,
        value_name: 'For others',
        exclude: true,
      },
    ]);
    expect(narrowed.body.expenses.map((e: { name: string }) => e.name)).toEqual(
      ['Pizza night']
    );
  });

  it('follows an edit: retyping an expense moves it out of a filtered list', async () => {
    const mine = `${JANUARY_RULE}&except=type:${FOR_OTHERS}`;
    const before = await list(mine);
    const pizza = before.body.expenses[0];

    await call('PUT', `/api/expenses/${pizza.slug}`, {
      body: { type_id: 9202 },
    });
    expect((await list(mine)).body.count).toBe(before.body.count - 1);
  });

  it('refuses a rule or a filter that is not valid', async () => {
    expect((await list('field=tag&value=nope')).status).toBe(422);
    expect((await list(`${JANUARY_RULE}&only=type:nope`)).status).toBe(422);
  });
});

describe('reports', () => {
  const REPORTS = '/api/reports';

  it('starts with a demo report, kept off the statistics cards', async () => {
    const reports = await call('GET', REPORTS);
    expect(reports.status).toBe(200);
    expect(reports.body).toHaveLength(1);
    expect(reports.body[0]).toMatchObject({
      period: { kind: 'all' },
      rows: [{ label: 'Rent' }],
    });

    const cards = await call('GET', '/api/statistics/cards');
    const titles = cards.body.map((c: { title: string }) => c.title);
    expect(titles).not.toContain(reports.body[0].title);
  });

  it('builds a report over a date range and counts it by year', async () => {
    const created = await call('POST', REPORTS, {
      body: {
        title: 'Groceries run',
        period: {
          kind: 'range',
          start_date: '2020-01-01',
          end_date: '2030-12-31',
        },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'Groceries run',
      period: { kind: 'range', start_date: '2020-01-01' },
      count: 0,
    });

    const slug = created.body.slug as string;
    const withRow = await call('POST', `${REPORTS}/${slug}/rows`, {
      body: {
        label: 'Super',
        match: { field: 'name', op: 'contains', value: 'Super' },
      },
    });
    expect(withRow.status).toBe(201);
    expect(withRow.body.rows[0].count).toBeGreaterThan(0);
    expect(withRow.body.by_year.length).toBeGreaterThan(0);
    expect(withRow.body.total).toBe(withRow.body.rows[0].total);

    const row = withRow.body.rows[0].slug as string;
    const list = await call('GET', `${REPORTS}/${slug}/rows/${row}/expenses`);
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(withRow.body.rows[0].count);
    expect(list.body.total).toBe(withRow.body.rows[0].total);
  });

  it('a row of an all-time report carries its own days and averages over them', async () => {
    const slug = (await call('GET', REPORTS)).body[0].slug as string;
    await call('POST', `${REPORTS}/${slug}/rows`, {
      body: {
        label: 'January only',
        match: { field: 'name', op: 'is', value: 'Rent January' },
      },
    });

    const report = (await call('GET', REPORTS)).body[0];
    const [rent, january] = report.rows;
    // The whole report runs over three months; the second row ran in one.
    expect(january).toMatchObject({ count: 1, from: january.to });
    expect(january.media).toBe(january.total);
    expect(rent.from < rent.to).toBe(true);
    expect(rent.media).toBe(Math.round((rent.total / 3) * 100) / 100);

    // A row that counted nothing has no days.
    await call('POST', `${REPORTS}/${slug}/rows`, {
      body: {
        label: 'Nothing',
        match: { field: 'name', op: 'is', value: 'No such expense' },
      },
    });
    const nothing = (await call('GET', REPORTS)).body[0].rows.at(-1);
    expect(nothing).toMatchObject({ count: 0, from: null, to: null });
  });

  it('a range ending before the data counts nothing; validation and 404s', async () => {
    const slug = (await call('GET', REPORTS)).body[0].slug as string;

    const emptied = await call('PUT', `${REPORTS}/${slug}`, {
      body: {
        period: {
          kind: 'range',
          start_date: '2001-01-01',
          end_date: '2001-12-31',
        },
      },
    });
    expect(emptied.status).toBe(200);
    expect(emptied.body).toMatchObject({ count: 0, total: 0, by_year: [] });

    const reversed = await call('PUT', `${REPORTS}/${slug}`, {
      body: {
        period: {
          kind: 'range',
          start_date: '2025-02-01',
          end_date: '2025-01-01',
        },
      },
    });
    expect(reversed.status).toBe(422);
    expect(reversed.body.errors.end_date).toBeDefined();

    expect((await call('POST', REPORTS, { body: { title: ' ' } })).status).toBe(
      422
    );
    expect(
      (await call('PUT', `${REPORTS}/nope`, { body: { title: 'x' } })).status
    ).toBe(404);
    expect((await call('DELETE', `${REPORTS}/nope`)).status).toBe(404);
  });

  it('renames, reorders and deletes', async () => {
    const first = (await call('GET', REPORTS)).body[0].slug as string;
    const second = (await call('POST', REPORTS, { body: { title: 'Second' } }))
      .body.slug as string;

    const renamed = await call('PUT', `${REPORTS}/${first}`, {
      body: { title: 'Renamed' },
    });
    expect(renamed.body.title).toBe('Renamed');

    const order = await call('PUT', `${REPORTS}/order`, {
      body: { slugs: [second] },
    });
    expect(order.body.map((r: { slug: string }) => r.slug)).toEqual([
      second,
      first,
    ]);

    expect((await call('DELETE', `${REPORTS}/${second}`)).status).toBe(204);
    expect(await call('GET', REPORTS)).toMatchObject({ status: 200 });
  });
});

describe('the rule list over explicit days', () => {
  const RULE = 'field=name&op=contains&value=a';

  it('counts exactly the days asked for, like the year query for a whole year', async () => {
    const days = await call(
      'GET',
      `/api/statistics/cards/expenses?${RULE}&start_date=2026-01-01&end_date=2026-12-31`
    );
    const year = await call(
      'GET',
      `/api/statistics/cards/expenses?${RULE}&year=2026&start_month=01&end_month=12`
    );
    expect(days.status).toBe(200);
    expect(days.body.count).toBeGreaterThan(0);
    expect({
      count: days.body.count,
      total: days.body.total,
      media: days.body.media,
    }).toEqual({
      count: year.body.count,
      total: year.body.total,
      media: year.body.media,
    });

    const narrow = await call(
      'GET',
      `/api/statistics/cards/expenses?${RULE}&start_date=2026-10-01&end_date=2026-10-31`
    );
    expect(narrow.body.count).toBeLessThan(days.body.count);
  });

  it('refuses one date, a bad date, a reversed range and both kinds of period', async () => {
    for (const extra of [
      'start_date=2026-01-01',
      'start_date=soon&end_date=2026-01-01',
      'start_date=2026-02-01&end_date=2026-01-01',
      'start_date=2026-01-01&end_date=2026-02-01&year=2026',
    ]) {
      const response = await call(
        'GET',
        `/api/statistics/cards/expenses?${RULE}&${extra}`
      );
      expect(response.status).toBe(422);
      expect(response.body.errors.period).toHaveLength(1);
    }
  });
});
