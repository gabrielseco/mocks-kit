// Concerts, and the venues they add up to.
import type { Schemas } from "@/lib/api/schemas";
import { newSlug } from "./store";
import type { Handlers } from "./types";
import { fields, hasErrors, missing, noContent, notFound, unprocessable } from "./util";

type ConcertOperations =
  "listConcerts" | "listConcertVenues" | "createConcert" | "updateConcert" | "deleteConcert";

const RATINGS = ["bad", "not_good", "normal", "good", "great", "biblical"];

const ratingError = (rating: unknown): Record<string, string[]> =>
  rating != null && !RATINGS.includes(rating as string) ? { rating: ["is invalid"] } : {};

type Body = Schemas["ConcertRequest"];

// The API sends the linked expense as `expenseSlug` and takes it as `expense_slug`. The mock has
// no expenses of its own, so a slug is linked as given.
const expenseSlug = (body: Body, current: string | null) =>
  "expense_slug" in fields(body) ? body.expense_slug || null : current;

export const concertHandlers: Pick<Handlers, ConcertOperations> = {
  listConcerts: ({ query, store }) => ({
    status: 200,
    body: store.concerts
      .filter(
        (c) =>
          (!query.start_date || c.date >= query.start_date) &&
          (!query.end_date || c.date <= query.end_date) &&
          (!query.name || c.name === query.name) &&
          (!query.venue || c.venue === query.venue) &&
          (!query.rating || c.rating === query.rating) &&
          (query.rolling === undefined || c.rolling === (query.rolling === "true")) &&
          (query.accompanied === undefined || c.accompanied === (query.accompanied === "true")),
      )
      .toSorted((a, b) => b.date.localeCompare(a.date)),
  }),

  listConcertVenues: ({ store }) => {
    const venues = new Map<string, { visits: number; lastVisited: string }>();
    for (const concert of store.concerts) {
      if (concert.venue === null) continue;
      const seen = venues.get(concert.venue);
      venues.set(concert.venue, {
        visits: (seen?.visits ?? 0) + 1,
        lastVisited: seen && seen.lastVisited > concert.date ? seen.lastVisited : concert.date,
      });
    }
    return {
      status: 200,
      body: [...venues.entries()]
        .map(([venue, seen]) => ({ venue, ...seen }))
        .toSorted((a, b) => b.lastVisited.localeCompare(a.lastVisited)),
    };
  },

  createConcert: ({ body, store }) => {
    const errors = { ...missing(fields(body), ["name", "date"]), ...ratingError(body.rating) };
    if (hasErrors(errors)) return unprocessable(errors);

    const concert: Schemas["Concert"] = {
      slug: newSlug(),
      name: body.name as string,
      venue: body.venue ?? null,
      date: body.date as string,
      rolling: body.rolling ?? false,
      accompanied: body.accompanied ?? false,
      rating: (body.rating ?? null) as Schemas["Concert"]["rating"],
      notes: body.notes ?? null,
      expenseSlug: expenseSlug(body, null),
    };
    store.concerts.push(concert);
    return { status: 201, body: concert };
  },

  updateConcert: ({ path, body, store }) => {
    const index = store.concerts.findIndex((c) => c.slug === path.slug);
    if (index === -1) return notFound;

    const errors = ratingError(body.rating);
    if (hasErrors(errors)) return unprocessable(errors);

    const current = store.concerts[index];
    const input = fields(body);
    const next: Schemas["Concert"] = {
      ...current,
      name: body.name ?? current.name,
      venue: "venue" in input ? (body.venue ?? null) : current.venue,
      date: body.date ?? current.date,
      rolling: body.rolling ?? current.rolling,
      accompanied: body.accompanied ?? current.accompanied,
      rating:
        "rating" in input
          ? ((body.rating ?? null) as Schemas["Concert"]["rating"])
          : current.rating,
      notes: "notes" in input ? (body.notes ?? null) : current.notes,
      expenseSlug: expenseSlug(body, current.expenseSlug),
    };
    store.concerts[index] = next;
    return { status: 200, body: next };
  },

  deleteConcert: ({ path, store }) => {
    const index = store.concerts.findIndex((c) => c.slug === path.slug);
    if (index === -1) return notFound;

    store.concerts.splice(index, 1);
    return noContent;
  },
};
