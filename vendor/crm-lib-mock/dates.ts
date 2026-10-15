// ISO `YYYY-MM-DD` date arithmetic. Strings compare correctly as they are, so only the
// operations that move a date or count days need parsing.
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** Today as YYYY-MM-DD; `MOCK_TODAY` pins it (tests use the recorded clock). */
export function mockToday(): string {
  return process.env.MOCK_TODAY ?? new Date().toISOString().slice(0, 10);
}

export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);

/** `to` minus `from`, in days. */
export const diffDays = (to: string, from: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY);

/** Moves an ISO date by whole months, clamping to the month's last day. */
export function shiftMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(day, lastDay))}`;
}

/** Whole months from `from`'s month to `to`'s month. */
export const monthsBetween = (from: string, to: string): number =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
  (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
