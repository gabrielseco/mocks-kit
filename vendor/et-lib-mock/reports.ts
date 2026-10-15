// Reports: a statistics card kept off the statistics page and counted over a
// period of its own (all time, the last 12 months or a date range), with the
// same rows, rules and filters as a card. The rows are counted from the
// store, so a report follows edits made anywhere.
import { randomUUID } from 'node:crypto';
import type { Schemas } from '@/lib/api/client';
import {
  badFilters,
  blank,
  counts,
  type Errors,
  parseFilters,
  parseMatch,
  titleErrors,
  view,
} from './statistics';
import type { Store, StoredExpense, StoredReport } from './store';
import type { Handlers } from './types';
import { activeExpenses, expenseRow, mockToday, round2 } from './util';

type ReportOperations =
  | 'listReports'
  | 'createReport'
  | 'updateReport'
  | 'deleteReport'
  | 'reorderReports'
  | 'createReportRow'
  | 'updateReportRow'
  | 'deleteReportRow'
  | 'listReportRowExpenses';

const PERIODS = ['all', 'last_12_months', 'range'];
const reportNotFound = {
  status: 404,
  body: { error: 'Report not found' },
} as const;
const rowNotFound = { status: 404, body: { error: 'Row not found' } } as const;

const DAY = 24 * 60 * 60 * 1000;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const utc = (value: string) => new Date(`${value}T00:00:00Z`);
const monthsBetween = (from: string, to: string) =>
  Math.max(
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      Number(to.slice(5, 7)) -
      Number(from.slice(5, 7)) +
      1,
    1
  );

// The dates a report counts, as the backend resolves them.
function resolve(report: StoredReport, today: string) {
  if (report.period.kind === 'range') {
    return {
      from: report.period.start_date as string,
      to: report.period.end_date as string,
    };
  }
  if (report.period.kind === 'last_12_months') {
    const start = utc(today);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    return { from: iso(new Date(start.getTime() + DAY)), to: today };
  }
  return { from: '0000-01-01', to: '9999-12-31' };
}

function figures(matched: StoredExpense[], months: number) {
  const total = matched.reduce((sum, expense) => sum + expense.expense, 0);
  const years = new Map<number, { count: number; total: number }>();
  for (const expense of matched) {
    const year = Number(expense.date.slice(0, 4));
    const found = years.get(year) ?? { count: 0, total: 0 };
    years.set(year, {
      count: found.count + 1,
      total: found.total + expense.expense,
    });
  }

  return {
    count: matched.length,
    total: round2(total),
    media: round2(total / months),
    by_year: [...years.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, found]) => ({
        year,
        count: found.count,
        total: round2(found.total),
      })),
  };
}

// What a total is averaged over; for all time, the months of the days the
// report shows (`until` is its last day), so the list of them averages alike.
function monthsFor(
  report: StoredReport,
  inReport: StoredExpense[],
  until: string
) {
  if (report.period.kind === 'last_12_months') return 12;
  if (report.period.kind === 'range') {
    return monthsBetween(
      report.period.start_date as string,
      report.period.end_date as string
    );
  }
  const earliest = inReport.map((e) => e.date).sort()[0];
  return earliest ? monthsBetween(earliest, until) : 1;
}

function result(store: Store, report: StoredReport): Schemas['Report'] {
  const today = mockToday();
  const { from, to } = resolve(report, today);
  const inPeriod = activeExpenses(store).filter(
    (expense) => expense.date >= from && expense.date <= to
  );
  const shown = view(store, { ...report, rows: report.rows });
  const rows = shown.rows.map((row) => ({
    row,
    matched: inPeriod.filter((expense) => counts(store, expense, row)),
  }));
  // The report counts an expense once, even when two rows match it.
  const own = [...new Set(rows.flatMap(({ matched }) => matched))];
  const earliest = own.map((e) => e.date).sort()[0];
  // Up to today, or the latest expense counted when that is later, so a list
  // of the report's days holds what the report counted.
  const shownTo =
    report.period.kind === 'all'
      ? [today, ...own.map((e) => e.date)].sort().at(-1)!
      : to;
  const months = monthsFor(report, own, shownTo);

  return {
    slug: report.slug,
    title: report.title,
    period: report.period,
    from: report.period.kind === 'all' ? (earliest ?? today) : from,
    to: shownTo,
    ...figures(own, months),
    rows: rows.map(({ row, matched }) =>
      rowResult(report, row, matched, months)
    ),
  };
}

// A row of an all-time report averages over the months it ran, from its
// first expense to its last; any other period keeps the report's window.
// `from`/`to` are those two days (null when it counted nothing).
function rowResult(
  report: StoredReport,
  row: StoredReport['rows'][number],
  matched: StoredExpense[],
  reportMonths: number
) {
  const dates = matched.map((e) => e.date).sort();
  const first = dates[0] ?? null;
  const last = dates.at(-1) ?? null;
  const months =
    report.period.kind === 'all' && first && last
      ? monthsBetween(first, last)
      : reportMonths;

  return { ...row, ...figures(matched, months), from: first, to: last };
}

const findReport = (store: Store, slug: string | undefined) =>
  store.reports.find((report) => report.slug === slug);

// The period as it would be stored, or the changeset's messages.
function parsePeriod(
  current: Schemas['ReportPeriod'] | null,
  sent:
    | { kind?: string; start_date?: string | null; end_date?: string | null }
    | undefined
): { period: Schemas['ReportPeriod'] } | { errors: Errors } {
  const kind = sent?.kind ?? current?.kind ?? 'all';
  if (!PERIODS.includes(kind)) return { errors: { period: ['is invalid'] } };
  if (kind !== 'range') {
    return {
      period: {
        kind: kind as Schemas['ReportPeriod']['kind'],
        start_date: null,
        end_date: null,
      },
    };
  }

  const start = sent?.start_date ?? current?.start_date ?? null;
  const end = sent?.end_date ?? current?.end_date ?? null;
  const errors: Errors = {};
  if (!start) errors.start_date = blank;
  else if (Number.isNaN(Date.parse(start))) errors.start_date = ['is invalid'];
  if (!end) errors.end_date = blank;
  else if (Number.isNaN(Date.parse(end))) errors.end_date = ['is invalid'];
  if (start && end && !errors.start_date && !errors.end_date && start > end) {
    errors.end_date = ['must not be before the start date'];
  }
  return Object.keys(errors).length > 0
    ? { errors }
    : { period: { kind: 'range', start_date: start, end_date: end } };
}

export const reportHandlers: Pick<Handlers, ReportOperations> = {
  listReports: ({ store }) => ({
    status: 200,
    body: store.reports.map((report) => result(store, report)),
  }),

  createReport: ({ store, body }) => {
    const errors = titleErrors(body.title);
    const parsed = parsePeriod(null, body.period);
    if (errors || 'errors' in parsed) {
      return {
        status: 422,
        body: {
          errors: { ...errors, ...('errors' in parsed ? parsed.errors : {}) },
        },
      };
    }

    const report: StoredReport = {
      slug: randomUUID(),
      title: (body.title as string).trim(),
      period: parsed.period,
      rows: [],
    };
    store.reports.push(report);
    return { status: 201, body: result(store, report) };
  },

  updateReport: ({ store, path, body }) => {
    const report = findReport(store, path.slug);
    if (!report) return reportNotFound;

    const errors: Errors = {};
    if (body.title !== undefined)
      Object.assign(errors, titleErrors(body.title));
    const parsed = body.period ? parsePeriod(report.period, body.period) : null;
    if (parsed && 'errors' in parsed) Object.assign(errors, parsed.errors);
    if (Object.keys(errors).length > 0) {
      return { status: 422, body: { errors } };
    }

    if (body.title !== undefined) report.title = body.title.trim();
    if (parsed && 'period' in parsed) report.period = parsed.period;
    return { status: 200, body: result(store, report) };
  },

  deleteReport: ({ store, path }) => {
    const report = findReport(store, path.slug);
    if (!report) return reportNotFound;

    store.reports.splice(store.reports.indexOf(report), 1);
    return { status: 204 };
  },

  reorderReports: ({ store, body }) => {
    if (!Array.isArray(body.slugs)) {
      return { status: 422, body: { error: 'slugs must be a list' } };
    }

    const listed = [...new Set(body.slugs)].flatMap(
      (slug) => findReport(store, slug) ?? []
    );
    store.reports = [
      ...listed,
      ...store.reports.filter((report) => !listed.includes(report)),
    ];
    return {
      status: 200,
      body: store.reports.map((report) => result(store, report)),
    };
  },

  createReportRow: ({ store, path, body }) => {
    const report = findReport(store, path.slug);
    if (!report) return reportNotFound;

    const parsed = parseMatch(store, body.match);
    const filters = parseFilters(store, body.filters ?? []);
    const errors: Errors = 'errors' in parsed ? { ...parsed.errors } : {};
    if (!body.label?.trim()) errors.label = blank;
    if (!filters) Object.assign(errors, badFilters);
    if (!('match' in parsed) || !filters || errors.label) {
      return { status: 422, body: { errors } };
    }

    report.rows.push({
      slug: randomUUID(),
      label: (body.label as string).trim(),
      match: parsed.match,
      filters,
    });
    return { status: 201, body: result(store, report) };
  },

  updateReportRow: ({ store, path, body }) => {
    const report = findReport(store, path.slug);
    if (!report) return reportNotFound;
    const row = report.rows.find((r) => r.slug === path.row_slug);
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
    return { status: 200, body: result(store, report) };
  },

  deleteReportRow: ({ store, path }) => {
    const report = findReport(store, path.slug);
    if (!report) return reportNotFound;
    const row = report.rows.find((r) => r.slug === path.row_slug);
    if (!row) return rowNotFound;

    report.rows.splice(report.rows.indexOf(row), 1);
    return { status: 204 };
  },

  listReportRowExpenses: ({ store, path }) => {
    const report = findReport(store, path.slug);
    if (!report) return reportNotFound;
    const row = report.rows.find((r) => r.slug === path.row_slug);
    if (!row) return rowNotFound;

    const { from, to } = resolve(report, mockToday());
    const shown = view(store, { ...report, rows: [row] }).rows[0];
    const matched = activeExpenses(store)
      .filter((e) => e.date >= from && e.date <= to)
      .filter((e) => counts(store, e, shown))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

    // Averaged over the report's months, as the row's figure in the report is.
    const rowFigures = result(store, report).rows.find(
      (r) => r.slug === row.slug
    );
    return {
      status: 200,
      body: {
        rule: { match: shown.match, filters: shown.filters },
        count: matched.length,
        total: round2(matched.reduce((sum, e) => sum + e.expense, 0)),
        media: rowFigures?.media ?? 0,
        expenses: matched.map((expense) => expenseRow(store, expense)),
      },
    };
  },
};
