// Expense tags: labels saying what an expense is ("supermarket", "taxi"),
// whatever it was named. An expense carries any number of them.
import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import type { Handlers } from './types';
import { activeExpenses } from './util';

type TagOperations =
  | 'listExpenseTags'
  | 'createExpenseTag'
  | 'updateExpenseTag'
  | 'deleteExpenseTag'
  | 'tagSpentExpenseExpenses'
  | 'tagExpenses'
  | 'untagExpenses'
  | 'tagExpensesWithTags'
  | 'untagExpensesWithTags';

const notFound = { status: 404, body: { error: 'Tag not found' } } as const;

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase());

// The name as the backend would store it, or the errors it would answer with:
// names are trimmed, at most 60 characters and unique ignoring case.
function validName(
  store: Store,
  name: unknown,
  ownSlug?: string
): { name: string } | { errors: Record<string, string[]> } {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '') return { errors: { name: ["can't be blank"] } };
  if (trimmed.length > 60) {
    return { errors: { name: ['should be at most 60 character(s)'] } };
  }
  const taken = store.tags.some(
    (tag) =>
      tag.slug !== ownSlug && tag.name.toLowerCase() === trimmed.toLowerCase()
  );
  return taken
    ? { errors: { name: ['has already been taken'] } }
    : { name: trimmed };
}

export const tagHandlers: Pick<Handlers, TagOperations> = {
  listExpenseTags: ({ store }) => ({
    status: 200,
    body: store.tags.toSorted(byName).map((tag) => ({
      ...tag,
      usage_count: activeExpenses(store).filter((expense) =>
        expense.tag_slugs.includes(tag.slug)
      ).length,
    })),
  }),

  createExpenseTag: ({ store, body }) => {
    const checked = validName(store, body?.name);
    if ('errors' in checked) return { status: 422, body: checked };

    const tag = { name: checked.name, slug: randomUUID() };
    store.tags.push(tag);
    return { status: 201, body: tag };
  },

  updateExpenseTag: ({ store, path, body }) => {
    const tag = store.tags.find((t) => t.slug === path.slug);
    if (!tag) return notFound;

    const checked = validName(store, body?.name, tag.slug);
    if ('errors' in checked) return { status: 422, body: checked };

    tag.name = checked.name;
    return { status: 200, body: { ...tag } };
  },

  // Deleting a tag takes it off every expense that carried it.
  deleteExpenseTag: ({ store, path }) => {
    const index = store.tags.findIndex((t) => t.slug === path.slug);
    if (index === -1) return notFound;

    const [tag] = store.tags.splice(index, 1);
    for (const expense of store.expenses) {
      expense.tag_slugs = expense.tag_slugs.filter((slug) => slug !== tag.slug);
    }
    return { status: 204 };
  },

  tagSpentExpenseExpenses: ({ store, path, body }) => {
    const group = store.groups.find((g) => !g.archived && g.slug === path.slug);
    if (!group) return { status: 404 };

    const tag = store.tags.find((t) => t.slug === body?.tag);
    if (!tag) return { status: 422, body: { error: 'Tag not found' } };

    const ids = store.groupExpenses
      .filter((link) => link.group_id === group.id)
      .map((link) => link.expense_id);
    const expenses = store.expenses.filter((e) => ids.includes(e.id));
    const untagged = expenses.filter((e) => !e.tag_slugs.includes(tag.slug));
    for (const expense of untagged) expense.tag_slugs.push(tag.slug);

    return {
      status: 200,
      body: { expenses: expenses.length, tagged: untagged.length },
    };
  },

  tagExpenses: ({ store, path, body }) =>
    changeExpenses(store, path.slug, body, true),

  untagExpenses: ({ store, path, body }) =>
    changeExpenses(store, path.slug, body, false),

  tagExpensesWithTags: ({ store, body }) => changeMany(store, body, true),

  untagExpensesWithTags: ({ store, body }) => changeMany(store, body, false),
};

// Several tags at once, all or nothing: one tag that isn't the user's is a 404
// and nothing changes. Returns how many tag/expense pairs changed.
function changeMany(
  store: Store,
  body: { tag_slugs?: unknown; expense_slugs?: unknown } | undefined,
  add: boolean
) {
  const tagSlugs = body?.tag_slugs;
  const expenseSlugs = body?.expense_slugs;
  if (
    !Array.isArray(tagSlugs) ||
    tagSlugs.length === 0 ||
    !Array.isArray(expenseSlugs)
  ) {
    return {
      status: 422,
      body: {
        error:
          'tag_slugs and expense_slugs must be lists, and tag_slugs must not be empty',
      },
    } as const;
  }

  const unique = [...new Set(tagSlugs)];
  const tags = store.tags.filter((t) => unique.includes(t.slug));
  if (tags.length !== unique.length) return notFound;

  const wanted = new Set(expenseSlugs.filter((s) => typeof s === 'string'));
  const matched = activeExpenses(store).filter((e) => wanted.has(e.slug));
  let changed = 0;
  for (const expense of matched) {
    for (const tag of tags) {
      const has = expense.tag_slugs.includes(tag.slug);
      if (has === add) continue;
      expense.tag_slugs = add
        ? [...expense.tag_slugs, tag.slug]
        : expense.tag_slugs.filter((slug) => slug !== tag.slug);
      changed += 1;
    }
  }

  return {
    status: 200,
    body: {
      tags: tags
        .toSorted(byName)
        .map((tag) => ({ name: tag.name, slug: tag.slug })),
      matched: matched.length,
      changed,
    },
  } as const;
}

// Puts a tag on, or takes it off, the user's active expenses with these slugs;
// slugs that aren't theirs are skipped, as the backend does.
function changeExpenses(
  store: Store,
  tagSlug: string | undefined,
  body: { expense_slugs?: unknown } | undefined,
  add: boolean
) {
  const tag = store.tags.find((t) => t.slug === tagSlug);
  if (!tag) return notFound;

  const slugs = body?.expense_slugs;
  if (!Array.isArray(slugs)) {
    return {
      status: 422,
      body: { error: 'expense_slugs must be a list of expense slugs' },
    } as const;
  }

  const wanted = new Set(slugs.filter((s) => typeof s === 'string'));
  const matched = activeExpenses(store).filter((e) => wanted.has(e.slug));
  const changing = matched.filter(
    (e) => e.tag_slugs.includes(tag.slug) !== add
  );

  for (const expense of changing) {
    expense.tag_slugs = add
      ? [...expense.tag_slugs, tag.slug]
      : expense.tag_slugs.filter((slug) => slug !== tag.slug);
  }

  return {
    status: 200,
    body: {
      tag: { ...tag },
      matched: matched.length,
      changed: changing.length,
    },
  } as const;
}
