// The mock backend's in-memory data. It is rebuilt from the responses the real backend
// recorded in contracts/examples.json, so the starting data is the backend's own output
// rather than a second hand-written copy.
import { randomUUID } from "node:crypto";
import type { Schemas } from "@/lib/api/schemas";
import { diffDays, monthsBetween, shiftMonths } from "./dates";
import { examples, SEED_CLOCK, type RecordedExample } from "./recorded";

export { SEED_CLOCK };

/** A trip's place, remembered with the trip it belongs to (the API nests it under the trip). */
export type StoredTripLocation = Schemas["TripLocation"] & { trip_slug: string };

/** One recorded balance of an account. */
export interface StoredSnapshot {
  date: string;
  cash: number;
  savings: number;
  invested: number;
}

export interface StoredAccount {
  slug: string;
  name: string;
  kind: Schemas["ListMoneyAccountsResponse"][number]["kind"];
  broker_account: string | null;
  snapshots: StoredSnapshot[];
}

export interface StoredTrayLog {
  id: string;
  series_id: string;
  tray_number: number;
  started_at: string;
  expected_duration_days: number;
}

export interface StoredSeries {
  id: string;
  series_number: number;
  total_trays: number;
}

export interface Store {
  user: Schemas["User"];
  timeOff: Schemas["TimeOff"][];
  trips: Schemas["Trip"][];
  tripLocations: StoredTripLocation[];
  homePeriods: Schemas["HomePeriod"][];
  concerts: Schemas["Concert"][];
  carKm: Schemas["CarKm"][];
  series: StoredSeries[];
  trayLogs: StoredTrayLog[];
  payslips: Schemas["ListPayslipsResponse"];
  accounts: StoredAccount[];
  /** Net worth per snapshot date, as the history endpoint lists it. */
  history: Schemas["GetNetWorthHistoryResponse"];
  targets: Schemas["ListTargetsResponse"];
}

function body<T>(operationId: string, name: string): T {
  const example = examples.find((e) => e.operationId === operationId && e.name === name);
  if (!example) {
    throw new Error(
      `contracts/examples.json has no ${operationId}/${name}; the mock store is seeded from it`,
    );
  }
  // A copy: the store's lists are edited in place, and a reset has to find the recording intact.
  return structuredClone(example.response.body) as T;
}

const tripLocationsOf = (e: RecordedExample) =>
  e.operationId === "listTripLocations" &&
  e.response.status === 200 &&
  /\/trips\/[^/]+\/locations$/.test(e.request.path);

/**
 * A fresh store. `today` (YYYY-MM-DD) slides every date by whole months so the recorded
 * "current month" lands on today's month and the default views have data. Pass `SEED_CLOCK` to
 * get the dates exactly as recorded.
 */
export function createStore(today: string = SEED_CLOCK): Store {
  const months = monthsBetween(SEED_CLOCK, today);
  const shift = (date: string) => shiftMonths(date, months);
  const shiftNull = (date: string | null) => (date === null ? null : shift(date));

  const timeOff = body<Schemas["TimeOff"][]>("listTimeOff", "all").map((t) => ({
    ...t,
    start_date: shift(t.start_date),
    end_date: shift(t.end_date),
    approved_at: shiftNull(t.approved_at),
    in_lieu_of_date: shiftNull(t.in_lieu_of_date),
  }));

  // Whole-month shifts can clamp an end of month, so the night counts are taken again.
  const trips = body<Schemas["Trip"][]>("listTrips", "all").map((t) => {
    const [start, end] = [shift(t.start_date), shift(t.end_date)];
    return { ...t, start_date: start, end_date: end, nights: diffDays(end, start) };
  });

  const tripLocations = examples.filter(tripLocationsOf).flatMap((e) => {
    const tripSlug = e.request.path.split("/")[4];
    return (structuredClone(e.response.body) as Schemas["TripLocation"][]).map((l) => {
      const [start, end] = [shift(l.start_date), shift(l.end_date)];
      return {
        ...l,
        trip_slug: tripSlug,
        start_date: start,
        end_date: end,
        nights: diffDays(end, start),
      };
    });
  });

  const homePeriods = body<Schemas["HomePeriod"][]>("listHomePeriods", "all").map((h) => ({
    ...h,
    start_date: shift(h.start_date),
    end_date: shiftNull(h.end_date),
  }));

  const concerts = body<Schemas["Concert"][]>("listConcerts", "all").map((c) => ({
    ...c,
    date: shift(c.date),
  }));

  // Years and months move together: sliding by months can cross a year boundary.
  const carKm = body<Schemas["CarKm"][]>("listCarKm", "all").map((c) => {
    const index = c.year * 12 + (c.month - 1) + months;
    return { ...c, year: Math.floor(index / 12), month: (index % 12) + 1 };
  });

  const overview = body<Schemas["InvisalignSeriesListResponse"]>("listInvisalign", "all");
  const series = overview.series.map((s) => ({
    id: s.id,
    series_number: s.series_number,
    total_trays: s.total_trays,
  }));
  const trayLogs = overview.series.flatMap((s) =>
    s.logs.map((l) => ({
      id: l.id,
      series_id: s.id,
      tray_number: l.tray_number,
      started_at: shift(l.started_at),
      expected_duration_days: l.expected_duration_days,
    })),
  );

  const payslips = body<Schemas["ListPayslipsResponse"]>("listPayslips", "all").map((p) => ({
    ...p,
    period: shift(p.period),
  }));

  // The balances of every account at the two dates the backend recorded net worth for.
  const accounts = body<Schemas["ListMoneyAccountsResponse"]>("listMoneyAccounts", "all").map(
    (account): StoredAccount => ({
      slug: account.slug,
      name: account.name,
      kind: account.kind,
      broker_account: account.broker_account,
      snapshots: [],
    }),
  );
  for (const name of ["endOfDecember", "today"]) {
    for (const row of body<Schemas["GetNetWorthResponse"]>("getNetWorth", name).accounts) {
      accounts
        .find((a) => a.slug === row.slug)
        ?.snapshots.push({
          date: shift(row.date),
          cash: row.cash,
          savings: row.savings,
          invested: row.invested,
        });
    }
  }

  const history = body<Schemas["GetNetWorthHistoryResponse"]>("getNetWorthHistory", "all").map(
    (point) => ({ ...point, date: shift(point.date) }),
  );

  const targets = body<Schemas["ListTargetsResponse"]>("listTargets", "withHidden").map((t) => ({
    ...t,
    deadline: shiftNull(t.deadline),
    pace: t.pace === null ? null : { ...t.pace, reach_date: shiftNull(t.pace.reach_date) },
  }));

  return {
    user: body<Schemas["User"]>("getCurrentUser", "signedIn"),
    timeOff,
    trips,
    tripLocations,
    homePeriods,
    concerts,
    carKm,
    series,
    trayLogs,
    payslips,
    accounts,
    history,
    targets,
  };
}

export const newSlug = () => randomUUID();
