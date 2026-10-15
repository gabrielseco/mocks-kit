// Monthly car km logs and the yearly summary the page shows.
import type { Schemas } from "@/lib/api/schemas";
import { mockToday } from "./dates";
import { newSlug } from "./store";
import type { Handlers } from "./types";
import { fields, hasErrors, missing, noContent, notFound, toNumber, unprocessable } from "./util";

type CarKmOperations = "listCarKm" | "getCarKmSummary" | "logCarKm" | "updateCarKm" | "deleteCarKm";

const avg = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

type Body = Schemas["CarKmRequest"];

// Year, month and km can arrive as numeric strings; what can't be read is left for the checks.
function readFields(body: Body, current?: Schemas["CarKm"]) {
  const values = fields(body);
  const read = (key: string, fallback: number | undefined) =>
    key in values ? toNumber(values[key]) : (fallback ?? null);

  return {
    year: read("year", current?.year),
    month: read("month", current?.month),
    km: read("km", current?.km),
  };
}

function checks(input: ReturnType<typeof readFields>, body: Body, requireAll: boolean) {
  const values = fields(body);
  const errors = requireAll ? missing(values, ["year", "month", "km"]) : {};

  for (const key of ["year", "month", "km"] as const) {
    if (key in values && values[key] != null && input[key] === null) errors[key] = ["is invalid"];
  }
  if (input.month !== null && (input.month < 1 || input.month > 12) && !errors.month) {
    errors.month = ["is invalid"];
  }
  if (input.km !== null && input.km < 0 && !errors.km) {
    errors.km = ["must be greater than or equal to 0"];
  }
  return errors;
}

export const carKmHandlers: Pick<Handlers, CarKmOperations> = {
  listCarKm: ({ query, store }) => ({
    status: 200,
    body: store.carKm
      .filter((c) => !query.year || c.year === Number(query.year))
      .toSorted((a, b) => a.year - b.year || a.month - b.month),
  }),

  getCarKmSummary: ({ query, store }) => {
    const year = Number(query.year ?? mockToday().slice(0, 4));
    const byMonth = new Map(store.carKm.filter((c) => c.year === year).map((c) => [c.month, c]));

    const months = Array.from({ length: 12 }, (_, i) => {
      const log = byMonth.get(i + 1);
      return log
        ? { month: i + 1, km: log.km, slug: log.slug, logged: true }
        : { month: i + 1, km: 0, slug: null, logged: false };
    });
    const values = months.map((m) => m.km);

    return {
      status: 200,
      body: {
        year,
        months,
        sum: values.reduce((a, b) => a + b, 0),
        avg12Months: avg(values),
        avgFirst6Months: avg(values.slice(0, 6)),
        avgLast6Months: avg(values.slice(-6)),
      },
    };
  },

  // A year and month that already has a log updates it rather than adding a second.
  logCarKm: ({ body, store }) => {
    const input = readFields(body);
    const errors = checks(input, body, true);
    if (hasErrors(errors)) return unprocessable(errors);

    const { year, month, km } = input as { year: number; month: number; km: number };
    const notes = "notes" in fields(body) ? (body.notes ?? null) : null;
    const existing = store.carKm.find((c) => c.year === year && c.month === month);

    if (existing) {
      existing.km = km;
      if ("notes" in fields(body)) existing.notes = notes;
      return { status: 201, body: existing };
    }

    const log: Schemas["CarKm"] = { slug: newSlug(), year, month, km, notes };
    store.carKm.push(log);
    return { status: 201, body: log };
  },

  updateCarKm: ({ path, body, store }) => {
    const index = store.carKm.findIndex((c) => c.slug === path.slug);
    if (index === -1) return notFound;

    const current = store.carKm[index];
    const input = readFields(body, current);
    const errors = checks(input, body, false);
    if (hasErrors(errors)) return unprocessable(errors);

    const next: Schemas["CarKm"] = {
      ...current,
      year: input.year as number,
      month: input.month as number,
      km: input.km as number,
      notes: "notes" in fields(body) ? (body.notes ?? null) : current.notes,
    };
    store.carKm[index] = next;
    return { status: 200, body: next };
  },

  deleteCarKm: ({ path, store }) => {
    const index = store.carKm.findIndex((c) => c.slug === path.slug);
    if (index === -1) return notFound;

    store.carKm.splice(index, 1);
    return noContent;
  },
};
