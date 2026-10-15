// The statistics page: the cards a user builds (a title over rows, each row
// one rule picking the expenses it adds up, narrowed by its filters), a
// rule's preview, and which
// built-in sections are hidden. The cards are counted from the store, so they
// follow the period and edits made anywhere; the page's other figures still
// replay what the backend recorded.
import { randomUUID } from 'node:crypto';
import type { Schemas } from '@/lib/api/client';
import { canned } from './canned';
import type { Store, StoredExpense } from './store';
import type { Handlers } from './types';
import {
  activeExpenses,
  expenseRow,
  expenseDate,
  monthsRange,
  periodDefaults,
  round2,
} from './util';

type StatisticsOperations =
  | 'getStatistics'
  | 'listStatisticsCards'
  | 'createStatisticsCard'
  | 'updateStatisticsCard'
  | 'deleteStatisticsCard'
  | 'reorderStatisticsCards'
  | 'createStatisticsCardRow'
  | 'updateStatisticsCardRow'
  | 'deleteStatisticsCardRow'
  | 'previewStatisticsCardRow'
  | 'listStatisticsRuleExpenses'
  | 'suggestStatisticsExpenseNames'
  | 'updateStatisticsLayout';

type Card = Schemas['StatisticsCard'];
type Match = Schemas['StatisticsMatch'];
type Filter = Schemas['StatisticsRowFilter'];
type Section = Schemas['StatisticsSection'];
export type Errors = Record<string, string[]>;

const SECTIONS: Section[] = [
  'expenses_type',
  'expenses_payed',
  'income_categories',
  'categories',
];
const OPS = ['is', 'starts', 'contains'];
const LOOKUP_FIELDS = ['category', 'type', 'payed', 'tag'] as const;
type LookupField = (typeof LOOKUP_FIELDS)[number];

const cardNotFound = {
  status: 404,
  body: { error: 'Card not found' },
} as const;
const rowNotFound = { status: 404, body: { error: 'Row not found' } } as const;
export const blank = ["can't be blank"];

const findLookup = (
  store: Store,
  field: LookupField,
  slug: unknown
): { slug: string; name: string } | undefined =>
  ({
    category: store.categories,
    type: store.types,
    payed: store.payed,
    tag: store.tags,
  })[field].find((option) => option.slug === slug);

/** Whether the expense is filed under (or tagged with) the lookup. */
function hasLookup(
  store: Store,
  expense: StoredExpense,
  field: LookupField,
  slug: string
): boolean {
  if (field === 'tag') {
    return (
      findLookup(store, 'tag', slug) !== undefined &&
      expense.tag_slugs.includes(slug)
    );
  }
  const options = {
    category: store.categories,
    type: store.types,
    payed: store.payed,
  }[field];
  const lookup = options.find((option) => option.slug === slug);
  const id = {
    category: expense.category_id,
    type: expense.type_id,
    payed: expense.payed_id,
  }[field];
  return lookup !== undefined && id === lookup.id;
}

const isLookupField = (field: unknown): field is LookupField =>
  LOOKUP_FIELDS.includes(field as LookupField);

function matches(store: Store, expense: StoredExpense, match: Match): boolean {
  if (match.field !== 'name') {
    return hasLookup(store, expense, match.field, match.value);
  }

  // Names are compared ignoring case, as the backend does.
  const name = expense.name.toLowerCase();
  const value = match.value.toLowerCase();
  if (match.op === 'is') return name === value;
  if (match.op === 'starts') return name.startsWith(value);
  return name.includes(value);
}

// An expense passes when it has every plain filter's lookup and none of the
// excluding ones'.
const passes = (store: Store, expense: StoredExpense, filters: Filter[]) =>
  filters.every(
    (filter) =>
      hasLookup(store, expense, filter.field, filter.value) !== filter.exclude
  );

export const counts = (
  store: Store,
  expense: StoredExpense,
  rule: { match: Match; filters: Filter[] }
) =>
  matches(store, expense, rule.match) && passes(store, expense, rule.filters);

interface Period {
  from: string;
  to: string;
  months: number;
  dateField?: string;
}

function period(query: {
  year?: string;
  start_month?: string;
  end_month?: string;
  date_field?: string;
  start_date?: string;
  end_date?: string;
}): Period {
  // Explicit days, as the backend takes them: the calendar months spanned.
  if (query.start_date && query.end_date) {
    const from = query.start_date;
    const to = query.end_date;
    return {
      from,
      to,
      months: Math.max(
        (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
          Number(to.slice(5, 7)) -
          Number(from.slice(5, 7)) +
          1,
        1
      ),
      dateField: query.date_field,
    };
  }

  const { year, startMonth, endMonth } = periodDefaults(query);
  return {
    ...monthsRange(year, startMonth, endMonth),
    months: Number(endMonth) - Number(startMonth) + 1,
    dateField: query.date_field,
  };
}

const inPeriod = (store: Store, { from, to, dateField }: Period) =>
  activeExpenses(store).filter((expense) => {
    const date = expenseDate(expense, dateField);
    return date >= from && date <= to;
  });

function figures(expenses: StoredExpense[], months: number) {
  const total = expenses.reduce((sum, expense) => sum + expense.expense, 0);
  return {
    count: expenses.length,
    total: round2(total),
    media: round2(total / months),
  };
}

function results(
  store: Store,
  period_: Period
): Schemas['StatisticsCardResult'][] {
  const expenses = inPeriod(store, period_);

  return store.statisticsCards.map((card) => {
    const rows = view(store, card).rows.map((row) => ({
      row,
      matched: expenses.filter((expense) => counts(store, expense, row)),
    }));
    // The card counts an expense once, even when two of its rows match it.
    const inCard = new Set(rows.flatMap(({ matched }) => matched));

    return {
      slug: card.slug,
      title: card.title,
      ...figures([...inCard], period_.months),
      rows: rows.map(({ row, matched }) => ({
        ...row,
        ...figures(matched, period_.months),
      })),
    };
  });
}

// The changeset's messages for a rule, or the rule as it would be stored.
export function parseMatch(
  store: Store,
  match: { field?: unknown; op?: unknown; value?: unknown } | undefined
): { match: Match } | { errors: Errors } {
  if (match?.field === 'name') {
    const errors: Errors = {};
    const value = typeof match.value === 'string' ? match.value.trim() : '';
    if (typeof match.op !== 'string') errors.match_op = blank;
    else if (!OPS.includes(match.op)) errors.match_op = ['is invalid'];
    if (!value) errors.match_value = blank;

    return Object.keys(errors).length > 0
      ? { errors }
      : {
          match: {
            field: 'name',
            op: match.op as Match['op'],
            value,
            value_name: null,
          },
        };
  }

  if (isLookupField(match?.field)) {
    const lookup = findLookup(store, match.field, match.value);
    return lookup
      ? {
          match: {
            field: match.field,
            op: null,
            value: lookup.slug,
            value_name: lookup.name,
          },
        }
      : { errors: { [`${match.field}_id`]: blank } };
  }

  return {
    errors: { match_field: match?.field == null ? blank : ['is invalid'] },
  };
}

export const badFilters: Errors = {
  filters: [
    'must each name one of your categories, types, payment methods or tags',
  ],
};

// The filters as they would be stored, or `null` when one doesn't name one of
// the user's lookups.
export function parseFilters(store: Store, filters: unknown): Filter[] | null {
  if (!Array.isArray(filters)) return null;

  const parsed: Filter[] = [];
  for (const filter of filters as Partial<Filter>[]) {
    const exclude = filter?.exclude ?? false;
    const lookup = isLookupField(filter?.field)
      ? findLookup(store, filter.field, filter.value)
      : undefined;
    if (
      !lookup ||
      !isLookupField(filter.field) ||
      typeof exclude !== 'boolean'
    ) {
      return null;
    }
    parsed.push({
      field: filter.field,
      value: lookup.slug,
      value_name: lookup.name,
      exclude,
    });
  }
  return parsed;
}

// `field:slug,field:slug` from the preview's `only` and `except`.
const queryFilters = (pairs: string | undefined, exclude: boolean) =>
  (pairs ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [field, ...rest] = pair.split(':');
      return { field, value: rest.join(':'), exclude };
    });

// What a rule in a query string (the preview's and the list's) matches in
// its period, newest first; or the errors the backend would answer with.
function ruleMatches(
  store: Store,
  query: {
    field?: string;
    op?: string;
    value?: string;
    only?: string;
    except?: string;
    year?: string;
    start_month?: string;
    end_month?: string;
    date_field?: string;
    start_date?: string;
    end_date?: string;
  }
) {
  const parsed = parseMatch(store, query);
  if ('errors' in parsed) return { errors: parsed.errors, found: null };

  const filters = parseFilters(store, [
    ...queryFilters(query.only, false),
    ...queryFilters(query.except, true),
  ]);
  if (!filters) return { errors: badFilters, found: null };

  const dates = datesErrors(query);
  if (dates) return { errors: dates, found: null };

  const period_ = period(query);
  const rule = { match: parsed.match, filters };
  const matched = inPeriod(store, period_)
    .filter((expense) => counts(store, expense, rule))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  return {
    errors: null,
    found: { rule, matched, figures: figures(matched, period_.months) },
  };
}

// The backend's refusals of an explicit period: one date, a bad date, a
// reversed range, or dates together with a year or months.
function datesErrors(query: {
  year?: string;
  start_month?: string;
  end_month?: string;
  start_date?: string;
  end_date?: string;
}): Errors | null {
  const { start_date: from, end_date: to } = query;
  if (from === undefined && to === undefined) return null;

  const message = (text: string) => ({ period: [text] });
  if (query.year || query.start_month || query.end_month) {
    return message(
      'send either start_date and end_date, or a year with months, not both'
    );
  }
  const valid = (value: string | undefined) =>
    !!value && !Number.isNaN(Date.parse(value));
  if (!valid(from) || !valid(to)) {
    return message('start_date and end_date must both be ISO dates');
  }
  if ((from as string) > (to as string)) {
    return message('start_date must not be after end_date');
  }
  return null;
}

const findCard = (store: Store, slug: string | undefined) =>
  store.statisticsCards.find((card) => card.slug === slug);

// A renamed lookup shows its new name on the rows and filters that follow it.
export function view(store: Store, card: Card): Card {
  return {
    ...card,
    rows: card.rows.map((row) => {
      const filters = row.filters.map((filter) => ({
        ...filter,
        value_name:
          findLookup(store, filter.field, filter.value)?.name ??
          filter.value_name,
      }));
      if (row.match.field === 'name') return { ...row, filters };

      const lookup = findLookup(store, row.match.field, row.match.value);
      return {
        ...row,
        filters,
        match: lookup ? { ...row.match, value_name: lookup.name } : row.match,
      };
    }),
  };
}

export const titleErrors = (title: unknown): Errors | null =>
  typeof title === 'string' && title.trim() ? null : { title: blank };

export const statisticsHandlers: Pick<Handlers, StatisticsOperations> = {
  getStatistics: (request) => {
    const replayed = canned('getStatistics')(request);
    if (replayed.status !== 200) return replayed;

    return {
      status: 200,
      body: {
        ...replayed.body,
        cards: results(request.store, period(request.query)),
        hidden_sections: request.store.statisticsHidden,
      },
    };
  },

  listStatisticsCards: ({ store }) => ({
    status: 200,
    body: store.statisticsCards.map((card) => view(store, card)),
  }),

  createStatisticsCard: ({ store, body }) => {
    const errors = titleErrors(body.title);
    if (errors) return { status: 422, body: { errors } };

    const card: Card = {
      slug: randomUUID(),
      title: body.title.trim(),
      rows: [],
    };
    store.statisticsCards.push(card);
    return { status: 201, body: card };
  },

  updateStatisticsCard: ({ store, path, body }) => {
    const card = findCard(store, path.slug);
    if (!card) return cardNotFound;
    const errors = titleErrors(body.title);
    if (errors) return { status: 422, body: { errors } };

    card.title = body.title.trim();
    return { status: 200, body: view(store, card) };
  },

  deleteStatisticsCard: ({ store, path }) => {
    const card = findCard(store, path.slug);
    if (!card) return cardNotFound;

    store.statisticsCards.splice(store.statisticsCards.indexOf(card), 1);
    return { status: 204 };
  },

  reorderStatisticsCards: ({ store, body }) => {
    if (!Array.isArray(body.slugs)) {
      return { status: 422, body: { error: 'slugs must be a list' } };
    }

    // Listed cards first, in that order; the rest keep theirs after them.
    const listed = [...new Set(body.slugs)].flatMap(
      (slug) => findCard(store, slug) ?? []
    );
    store.statisticsCards = [
      ...listed,
      ...store.statisticsCards.filter((card) => !listed.includes(card)),
    ];
    return {
      status: 200,
      body: store.statisticsCards.map((card) => view(store, card)),
    };
  },

  createStatisticsCardRow: ({ store, path, body }) => {
    const card = findCard(store, path.slug);
    if (!card) return cardNotFound;

    const parsed = parseMatch(store, body.match);
    const filters = parseFilters(store, body.filters ?? []);
    const errors: Errors = 'errors' in parsed ? { ...parsed.errors } : {};
    if (!body.label?.trim()) errors.label = blank;
    if (!filters) Object.assign(errors, badFilters);
    if (!('match' in parsed) || !filters || errors.label) {
      return { status: 422, body: { errors } };
    }

    card.rows.push({
      slug: randomUUID(),
      label: (body.label as string).trim(),
      match: parsed.match,
      filters,
    });
    return { status: 201, body: view(store, card) };
  },

  updateStatisticsCardRow: ({ store, path, body }) => {
    const card = findCard(store, path.slug);
    if (!card) return cardNotFound;
    const row = card.rows.find((r) => r.slug === path.row_slug);
    if (!row) return rowNotFound;

    // A row keeps its rule when `match` is left out, and its filters when
    // `filters` is.
    const parsed = body.match ? parseMatch(store, body.match) : null;
    const filters =
      body.filters === undefined
        ? undefined
        : parseFilters(store, body.filters);
    const errors: Errors =
      parsed && 'errors' in parsed ? { ...parsed.errors } : {};
    if (body.label !== undefined && !body.label.trim()) errors.label = blank;
    if (filters === null) Object.assign(errors, badFilters);
    if (Object.keys(errors).length > 0) {
      return { status: 422, body: { errors } };
    }

    if (body.label !== undefined) row.label = body.label.trim();
    if (parsed && 'match' in parsed) row.match = parsed.match;
    if (filters) row.filters = filters;
    return { status: 200, body: view(store, card) };
  },

  deleteStatisticsCardRow: ({ store, path }) => {
    const card = findCard(store, path.slug);
    if (!card) return cardNotFound;
    const row = card.rows.find((r) => r.slug === path.row_slug);
    if (!row) return rowNotFound;

    card.rows.splice(card.rows.indexOf(row), 1);
    return { status: 204 };
  },

  previewStatisticsCardRow: ({ store, query }) => {
    const { errors, found } = ruleMatches(store, query);
    if (!found) return { status: 422, body: { errors } };

    return {
      status: 200,
      body: {
        ...found.figures,
        expenses: found.matched.slice(0, 5).map((expense) => ({
          slug: expense.slug,
          name: expense.name,
          date: expense.date,
          expense: round2(expense.expense),
          category_name:
            store.categories.find((c) => c.id === expense.category_id)?.name ??
            null,
        })),
      },
    };
  },

  // The preview without its cut at the latest five, as full expense rows.
  listStatisticsRuleExpenses: ({ store, query }) => {
    const { errors, found } = ruleMatches(store, query);
    if (!found) return { status: 422, body: { errors } };

    return {
      status: 200,
      body: {
        rule: found.rule,
        ...found.figures,
        expenses: found.matched.map((expense) => expenseRow(store, expense)),
      },
    };
  },

  suggestStatisticsExpenseNames: ({ store, query }) => {
    const needle = (query.search ?? '').trim().toLowerCase();
    const counts = new Map<string, number>();
    for (const { name } of activeExpenses(store)) {
      if (name.toLowerCase().includes(needle)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }

    return {
      status: 200,
      body: [...counts.entries()]
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .slice(0, 8)
        .map(([name, count]) => ({ name, count })),
    };
  },

  updateStatisticsLayout: ({ store, body }) => {
    const sections: unknown = body.hidden_sections;
    if (!Array.isArray(sections)) {
      return { status: 422, body: { error: 'hidden_sections must be a list' } };
    }
    const unknown = sections.filter((s) => !SECTIONS.includes(s));
    if (unknown.length > 0) {
      return {
        status: 422,
        body: {
          error: `unknown sections: ${unknown.map((s) => JSON.stringify(s)).join(', ')}`,
        },
      };
    }

    store.statisticsHidden = [...new Set(sections as Section[])];
    return { status: 200, body: { hidden_sections: store.statisticsHidden } };
  },
};
