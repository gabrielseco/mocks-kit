// Trips and where they were spent, the periods a place was home, and what those add up to.
import type { Schemas } from "@/lib/api/schemas";
import { addDays, diffDays, mockToday } from "./dates";
import { newSlug, type Store, type StoredTripLocation } from "./store";
import type { Handlers } from "./types";
import { dateOrder, fields, hasErrors, missing, noContent, notFound, unprocessable } from "./util";

type TripOperations =
  | "listTrips"
  | "createTrip"
  | "updateTrip"
  | "deleteTrip"
  | "listTripLocations"
  | "createTripLocation"
  | "updateTripLocation"
  | "deleteTripLocation"
  | "listHomePeriods"
  | "createHomePeriod"
  | "updateHomePeriod"
  | "deleteHomePeriod"
  | "getResidencySummary";

const byStart = <T extends { start_date: string }>(a: T, b: T) =>
  a.start_date.localeCompare(b.start_date);

// A period overlaps the range [start, end] when it ends on or after start and starts by end.
const overlaps = (
  period: { start_date: string; end_date: string | null },
  start?: string,
  end?: string,
) =>
  (!start || period.end_date === null || period.end_date >= start) &&
  (!end || period.start_date <= end);

// A stored place without the trip it hangs from, which the API only expresses in the path.
const toLocation = (l: StoredTripLocation): Schemas["TripLocation"] => ({
  slug: l.slug,
  location: l.location,
  start_date: l.start_date,
  end_date: l.end_date,
  nights: l.nights,
  notes: l.notes,
});

const tripSlugs = (store: Store) => new Set(store.trips.map((t) => t.slug));

// A trip's place has to sit inside the trip.
function withinTrip(trip: Schemas["Trip"], start: string | null, end: string | null) {
  const errors: Record<string, string[]> = {};
  if (start && start < trip.start_date) {
    errors.start_date = [`must be on or after the trip's start_date (${trip.start_date})`];
  }
  if (end && end > trip.end_date) {
    errors.end_date = [`must be on or before the trip's end_date (${trip.end_date})`];
  }
  return errors;
}

export const tripHandlers: Pick<Handlers, TripOperations> = {
  listTrips: ({ query, store }) => ({
    status: 200,
    body: store.trips
      .filter(
        (t) =>
          overlaps(t, query.start_date, query.end_date) &&
          (!query.label || t.label === query.label),
      )
      .toSorted(byStart),
  }),

  createTrip: ({ body, store }) => {
    const input = fields(body);
    const errors = {
      ...missing(input, ["label", "start_date", "end_date"]),
      ...dateOrder(body.start_date ?? null, body.end_date ?? null),
    };
    if (hasErrors(errors)) return unprocessable(errors);

    const start = body.start_date as string;
    const end = body.end_date as string;
    const trip: Schemas["Trip"] = {
      slug: newSlug(),
      label: body.label as string,
      start_date: start,
      end_date: end,
      nights: diffDays(end, start),
      notes: body.notes ?? null,
    };
    store.trips.push(trip);
    return { status: 201, body: trip };
  },

  updateTrip: ({ path, body, store }) => {
    const index = store.trips.findIndex((t) => t.slug === path.slug);
    if (index === -1) return notFound;

    const current = store.trips[index];
    const next = {
      ...current,
      label: body.label ?? current.label,
      start_date: body.start_date ?? current.start_date,
      end_date: body.end_date ?? current.end_date,
      notes: "notes" in fields(body) ? (body.notes ?? null) : current.notes,
    };
    const errors = dateOrder(next.start_date, next.end_date);
    if (hasErrors(errors)) return unprocessable(errors);

    next.nights = diffDays(next.end_date, next.start_date);
    store.trips[index] = next;
    return { status: 200, body: next };
  },

  deleteTrip: ({ path, store }) => {
    const index = store.trips.findIndex((t) => t.slug === path.slug);
    if (index === -1) return notFound;

    store.trips.splice(index, 1);
    // A trip's places go with it.
    store.tripLocations = store.tripLocations.filter((l) => l.trip_slug !== path.slug);
    return noContent;
  },

  listTripLocations: ({ path, store }) => {
    if (!tripSlugs(store).has(path.trip_slug as string)) return notFound;
    return {
      status: 200,
      body: store.tripLocations
        .filter((l) => l.trip_slug === path.trip_slug)
        .toSorted(byStart)
        .map(toLocation),
    };
  },

  createTripLocation: ({ path, body, store }) => {
    const trip = store.trips.find((t) => t.slug === path.trip_slug);
    if (!trip) return notFound;

    const errors = {
      ...missing(fields(body), ["location", "start_date", "end_date"]),
      ...dateOrder(body.start_date ?? null, body.end_date ?? null),
      ...withinTrip(trip, body.start_date ?? null, body.end_date ?? null),
    };
    if (hasErrors(errors)) return unprocessable(errors);

    const start = body.start_date as string;
    const end = body.end_date as string;
    const created: StoredTripLocation = {
      slug: newSlug(),
      trip_slug: trip.slug,
      location: body.location as string,
      start_date: start,
      end_date: end,
      nights: diffDays(end, start),
      notes: body.notes ?? null,
    };
    store.tripLocations.push(created);

    return { status: 201, body: toLocation(created) };
  },

  updateTripLocation: ({ path, body, store }) => {
    const index = store.tripLocations.findIndex((l) => l.slug === path.slug);
    if (index === -1) return notFound;

    const current = store.tripLocations[index];
    const trip = store.trips.find((t) => t.slug === current.trip_slug);
    const next = {
      ...current,
      location: body.location ?? current.location,
      start_date: body.start_date ?? current.start_date,
      end_date: body.end_date ?? current.end_date,
      notes: "notes" in fields(body) ? (body.notes ?? null) : current.notes,
    };
    const errors = {
      ...dateOrder(next.start_date, next.end_date),
      ...(trip ? withinTrip(trip, next.start_date, next.end_date) : {}),
    };
    if (hasErrors(errors)) return unprocessable(errors);

    next.nights = diffDays(next.end_date, next.start_date);
    store.tripLocations[index] = next;

    return { status: 200, body: toLocation(next) };
  },

  deleteTripLocation: ({ path, store }) => {
    const index = store.tripLocations.findIndex((l) => l.slug === path.slug);
    if (index === -1) return notFound;

    store.tripLocations.splice(index, 1);
    return noContent;
  },

  listHomePeriods: ({ query, store }) => ({
    status: 200,
    body: store.homePeriods
      .filter(
        (h) =>
          overlaps(h, query.start_date, query.end_date) &&
          (!query.location || h.location === query.location),
      )
      .toSorted(byStart),
  }),

  createHomePeriod: ({ body, store }) => {
    const errors = {
      ...missing(fields(body), ["location", "start_date"]),
      ...dateOrder(body.start_date ?? null, body.end_date ?? null),
    };
    if (hasErrors(errors)) return unprocessable(errors);

    const period: Schemas["HomePeriod"] = {
      slug: newSlug(),
      location: body.location as string,
      start_date: body.start_date as string,
      end_date: body.end_date ?? null,
      notes: body.notes ?? null,
    };
    store.homePeriods.push(period);
    return { status: 201, body: period };
  },

  updateHomePeriod: ({ path, body, store }) => {
    const index = store.homePeriods.findIndex((h) => h.slug === path.slug);
    if (index === -1) return notFound;

    const current = store.homePeriods[index];
    const input = fields(body);
    const next = {
      ...current,
      location: body.location ?? current.location,
      start_date: body.start_date ?? current.start_date,
      end_date: "end_date" in input ? (body.end_date ?? null) : current.end_date,
      notes: "notes" in input ? (body.notes ?? null) : current.notes,
    };
    const errors = dateOrder(next.start_date, next.end_date);
    if (hasErrors(errors)) return unprocessable(errors);

    store.homePeriods[index] = next;
    return { status: 200, body: next };
  },

  deleteHomePeriod: ({ path, store }) => {
    const index = store.homePeriods.findIndex((h) => h.slug === path.slug);
    if (index === -1) return notFound;

    store.homePeriods.splice(index, 1);
    return noContent;
  },

  getResidencySummary: ({ query, store }) => {
    const today = mockToday();
    const start = query.start_date ?? `${today.slice(0, 4)}-01-01`;
    const end = query.end_date ?? today;
    return { status: 200, body: residency(store, start, end) };
  },
};

// Everything below counts nights: each day belongs to wherever you slept that night, so a
// trip's return day is a home day. Intervals are inclusive [first night, last night].
type Interval = [string, string];

const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

function intersect([aStart, aEnd]: Interval, [bStart, bEnd]: Interval): Interval | null {
  const [start, end] = [later(aStart, bStart), earlier(aEnd, bEnd)];
  return start <= end ? [start, end] : null;
}

// A same-day stay has no night, so it has no interval.
const nightInterval = (p: { start_date: string; end_date: string }): Interval | null =>
  p.end_date > p.start_date ? [p.start_date, addDays(p.end_date, -1)] : null;

const days = ([start, end]: Interval) => diffDays(end, start) + 1;
const sumDays = (intervals: Interval[]) => intervals.reduce((total, i) => total + days(i), 0);
const present = (i: Interval | null): i is Interval => i !== null;

function mergeIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const [start, end] of intervals.toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const last = merged[merged.length - 1];
    if (last && start <= addDays(last[1], 1)) last[1] = later(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const UNASSIGNED = "Unassigned";

function residency(store: Store, start: string, end: string): Schemas["ResidencySummary"] {
  const range: Interval = [start, end];
  const totalDays = days(range);

  const tripNights = mergeIntervals(
    store.trips
      .filter((t) => overlaps(t, start, end))
      .map((t) => nightInterval(t))
      .filter(present)
      .map((i) => intersect(i, range))
      .filter(present),
  );
  const daysOutOfHome = sumDays(tripNights);

  // An ongoing period (no end date) runs to the end of the range.
  const homeIntervals = store.homePeriods
    .filter((h) => overlaps(h, start, end))
    .flatMap((h) => {
      const interval = intersect([h.start_date, h.end_date ?? end], range);
      return interval ? [{ location: h.location, interval }] : [];
    });

  const byLocation = new Map<string, number>();
  for (const { location, interval } of homeIntervals) {
    const awayInPeriod = sumDays(tripNights.map((t) => intersect(t, interval)).filter(present));
    byLocation.set(location, (byLocation.get(location) ?? 0) + days(interval) - awayInPeriod);
  }

  const locationNights = store.tripLocations
    .filter((l) => overlaps(l, start, end))
    .flatMap((l) => {
      const night = nightInterval(l);
      const interval = night && intersect(night, range);
      return interval ? [{ location: l.location, interval }] : [];
    });
  for (const { location, interval } of locationNights) {
    byLocation.set(location, (byLocation.get(location) ?? 0) + days(interval));
  }

  // Trip nights no place claims would vanish from the breakdown, so they show as Unassigned.
  const claimed = mergeIntervals(locationNights.map((l) => l.interval));
  const claimedTripNights = tripNights.flatMap((trip) =>
    claimed.map((c) => intersect(trip, c)).filter(present),
  );
  const unassigned = daysOutOfHome - sumDays(claimedTripNights);
  if (unassigned > 0) byLocation.set(UNASSIGNED, unassigned);

  const covered = sumDays(mergeIntervals(homeIntervals.map((h) => h.interval)));

  return {
    start_date: start,
    end_date: end,
    total_days: totalDays,
    days_out_of_home: daysOutOfHome,
    days_at_base: totalDays - daysOutOfHome,
    by_location: [...byLocation.entries()]
      .map(([location, count]) => ({ location, days: count }))
      .toSorted((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0)),
    uncovered_days: totalDays - covered,
  };
}
