// Time off: the calendar entries, including public holidays worked and later taken back.
import type { Schemas } from "@/lib/api/schemas";
import { newSlug, type Store } from "./store";
import type { Handlers } from "./types";
import { fields, hasErrors, missing, noContent, notFound, toNumber, unprocessable } from "./util";

type TimeOffOperations = "listTimeOff" | "createTimeOff" | "updateTimeOff" | "deleteTimeOff";

// Entries in these statuses no longer draw on a holiday's banked hours.
const INACTIVE = ["cancelled", "declined", "cancel_requested"];

/** Hours taken back from a worked holiday, `exceptSlug` left out (the entry being edited). */
function usedHours(store: Store, holidaySlug: string, exceptSlug?: string) {
  return store.timeOff
    .filter(
      (t) =>
        t.in_lieu_of_slug === holidaySlug && t.slug !== exceptSlug && !INACTIVE.includes(t.status),
    )
    .reduce((total, t) => total + (t.hours ?? 0), 0);
}

/** An entry as the API sends it: the in-lieu figures follow the entries that point at it. */
function present(store: Store, entry: Schemas["TimeOff"]): Schemas["TimeOff"] {
  const holiday = store.timeOff.find((t) => t.slug === entry.in_lieu_of_slug);
  return {
    ...entry,
    in_lieu_used_hours: usedHours(store, entry.slug),
    in_lieu_of_date: holiday ? holiday.start_date : null,
  };
}

type Errors = Record<string, string[]>;

// An explicit null or "" unlinks; a slug has to be another worked holiday with hours left.
function checkInLieu(
  store: Store,
  merged: Schemas["TimeOff"],
  linkChanged: boolean,
  exceptSlug?: string,
): Errors {
  const slug = merged.in_lieu_of_slug;
  if (!slug) return {};
  const holiday = store.timeOff.find((t) => t.slug === slug);

  if (linkChanged && !holiday) {
    return { in_lieu_of_slug: ["is not one of your time off entries"] };
  }
  if (!holiday) return {};
  if (holiday.slug === exceptSlug) return { in_lieu_of_slug: ["cannot be the entry itself"] };

  const banked = holiday.worked_hours ?? 0;
  if (banked === 0) return { in_lieu_of_slug: ["is not marked as worked"] };

  const used = usedHours(store, holiday.slug, exceptSlug);
  if (merged.hours !== null && used + merged.hours > banked) {
    return { in_lieu_of_slug: [`only has ${banked - used}h left to take`] };
  }
  return {};
}

// `worked_hours` only exists on a public holiday and can't exceed its hours.
function checkWorkedHours(merged: Schemas["TimeOff"]): Errors {
  const worked = merged.worked_hours ?? 0;
  if (worked < 0) return { worked_hours: ["must be greater than or equal to 0"] };
  if (worked === 0) return {};
  if (merged.timeoff_type !== "public_holiday") {
    return { worked_hours: ["can only be set on a public holiday"] };
  }
  if (merged.hours !== null && worked > merged.hours) {
    return { worked_hours: ["cannot exceed the holiday's hours"] };
  }
  return {};
}

type Body = Schemas["TimeOffRequest"];

// Folds a request body over an entry; numbers can arrive as numeric strings.
function apply(entry: Schemas["TimeOff"], body: Body, create: boolean): Schemas["TimeOff"] {
  const values = fields(body);
  const has = (key: string) => key in values;
  const int = (key: string, current: number | null) =>
    has(key) ? (values[key] === null ? null : toNumber(values[key])) : current;

  return {
    ...entry,
    remote_slug: has("remote_slug") ? (body.remote_slug ?? null) : entry.remote_slug,
    // The source is chosen at creation and is not editable afterwards.
    source: create && body.source ? body.source : entry.source,
    status: body.status ?? entry.status,
    timeoff_type: body.timeoff_type ?? entry.timeoff_type,
    leave_policy_name: has("leave_policy_name")
      ? (body.leave_policy_name ?? null)
      : entry.leave_policy_name,
    start_date: body.start_date ?? entry.start_date,
    end_date: body.end_date ?? entry.end_date,
    hours: int("hours", entry.hours),
    minutes: int("minutes", entry.minutes),
    automatic: body.automatic ?? entry.automatic,
    notes: has("notes") ? (body.notes ?? null) : entry.notes,
    approved_at: has("approved_at") ? (body.approved_at ?? null) : entry.approved_at,
    worked_hours: int("worked_hours", entry.worked_hours),
    in_lieu_of_slug: has("in_lieu_of_slug") ? body.in_lieu_of_slug || null : entry.in_lieu_of_slug,
  };
}

const blank = (): Schemas["TimeOff"] => ({
  slug: "",
  remote_slug: null,
  source: "manual",
  status: "",
  timeoff_type: "",
  leave_policy_name: null,
  start_date: "",
  end_date: "",
  hours: null,
  minutes: null,
  automatic: false,
  notes: null,
  approved_at: null,
  worked_hours: null,
  in_lieu_used_hours: 0,
  in_lieu_of_slug: null,
  in_lieu_of_date: null,
});

export const timeOffHandlers: Pick<Handlers, TimeOffOperations> = {
  listTimeOff: ({ query, store }) => {
    const entries = store.timeOff
      .filter(
        (t) =>
          (!query.start_date || t.end_date >= query.start_date) &&
          (!query.end_date || t.start_date <= query.end_date) &&
          (!query.status || t.status === query.status) &&
          (!query.timeoff_type || t.timeoff_type === query.timeoff_type) &&
          (!query.source || t.source === query.source) &&
          (query.automatic === undefined || t.automatic === (query.automatic === "true")) &&
          (query.worked !== "true" || (t.worked_hours ?? 0) > 0),
      )
      .toSorted((a, b) => a.start_date.localeCompare(b.start_date));

    return { status: 200, body: entries.map((t) => present(store, t)) };
  },

  createTimeOff: ({ body, store }) => {
    const entry = apply({ ...blank(), slug: newSlug() }, body, true);
    const errors = {
      ...missing(fields(body), ["status", "timeoff_type", "start_date", "end_date"]),
      ...checkWorkedHours(entry),
      ...checkInLieu(store, entry, true),
    };
    if (hasErrors(errors)) return unprocessable(errors);

    store.timeOff.push(entry);
    return { status: 201, body: present(store, entry) };
  },

  updateTimeOff: ({ path, body, store }) => {
    const index = store.timeOff.findIndex((t) => t.slug === path.slug);
    if (index === -1) return notFound;

    const current = store.timeOff[index];
    const entry = apply(current, body, false);
    const hasLink = "in_lieu_of_slug" in fields(body);
    const errors = {
      ...checkWorkedHours(entry),
      ...checkInLieu(store, entry, hasLink, entry.slug),
    };

    // Lowering a holiday's worked hours below what was already taken back would orphan them.
    if ("worked_hours" in fields(body)) {
      const used = usedHours(store, current.slug);
      if ((entry.worked_hours ?? 0) < used) {
        errors.worked_hours = [`${used}h of this holiday has already been taken in lieu`];
      }
    }
    if (hasErrors(errors)) return unprocessable(errors);

    store.timeOff[index] = entry;
    return { status: 200, body: present(store, entry) };
  },

  deleteTimeOff: ({ path, store }) => {
    const index = store.timeOff.findIndex((t) => t.slug === path.slug);
    if (index === -1) return notFound;

    const [removed] = store.timeOff.splice(index, 1);
    // Entries that took hours back from a deleted holiday are left standing, unlinked.
    for (const t of store.timeOff) {
      if (t.in_lieu_of_slug === removed.slug) t.in_lieu_of_slug = null;
    }
    return noContent;
  },
};
