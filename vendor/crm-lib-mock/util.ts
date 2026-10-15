// Small helpers the mock handlers share.
import type { Store } from "./store";

/** The 422 the crm controllers send for an invalid changeset. */
export const unprocessable = (errors: Record<string, string[]>) =>
  ({ status: 422, body: { errors } }) as const;

export const noContent = { status: 204 } as const;
export const notFound = { status: 404 } as const;

const BLANK = "can't be blank";

/** Errors for the required fields a body leaves out (or sends as null or ""). */
export function missing(body: object, fields: string[]): Record<string, string[]> {
  const values = body as Record<string, unknown>;
  return Object.fromEntries(
    fields.filter((f) => values[f] == null || values[f] === "").map((f) => [f, [BLANK]]),
  );
}

export const hasErrors = (errors: Record<string, string[]>) => Object.keys(errors).length > 0;

/** `end_date` before `start_date`, the one date rule trips, places and periods share. */
export function dateOrder(start: string | null, end: string | null): Record<string, string[]> {
  return start && end && end < start ? { end_date: ["must be on or after start_date"] } : {};
}

/** A body's number the way Ecto casts it: numbers as they are, numeric strings parsed. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Reads a request body as a plain bag of fields. */
export const fields = (body: unknown) => (body ?? {}) as Record<string, unknown>;

export type { Store };
