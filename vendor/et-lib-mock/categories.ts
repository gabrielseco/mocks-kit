// The settings admin: one set of handlers over the five lookup tables.
// `expense`, `type` and `payed` deactivate on delete; `income` and
// `spent-expense` are removed, and refused while anything uses them.
import { randomUUID } from 'node:crypto';
import type { Schemas } from '@/lib/api/client';
import type { Store } from './store';
import type { Handlers } from './types';

type AdminOperations =
  | 'listAdminCategories'
  | 'createAdminCategory'
  | 'updateAdminCategory'
  | 'deleteAdminCategory'
  | 'activateAdminCategory';

type Row = Schemas['ExpenseOption'] & { broker_account?: string | null };

interface Kind {
  rows: (store: Store) => Row[];
  /** Non-archived records pointing at the row with this id. */
  usage: (store: Store, id: number) => number;
  deactivates: boolean;
}

const expenses = (store: Store) => store.expenses.filter((e) => !e.archived);

const kinds: Record<string, Kind> = {
  expense: {
    rows: (store) => store.categories,
    usage: (store, id) =>
      expenses(store).filter((e) => e.category_id === id).length,
    deactivates: true,
  },
  type: {
    rows: (store) => store.types,
    usage: (store, id) =>
      expenses(store).filter((e) => e.type_id === id).length,
    deactivates: true,
  },
  payed: {
    rows: (store) => store.payed,
    usage: (store, id) =>
      expenses(store).filter((e) => e.payed_id === id).length,
    deactivates: true,
  },
  income: {
    rows: (store) => store.incomeCategories,
    usage: (store, id) =>
      store.incomes.filter((i) => !i.archived && i.category_id === id).length,
    deactivates: false,
  },
  'spent-expense': {
    rows: (store) => store.groupCategories,
    usage: (store, id) =>
      store.groups.filter((g) => !g.archived && g.category_id === id).length,
    deactivates: false,
  },
};

const unknownKind = {
  status: 404,
  body: { error: 'Unknown category kind' },
} as const;

const notFound = {
  status: 404,
  body: { error: 'Category not found' },
} as const;

function view(store: Store, kind: Kind, row: Row): Schemas['AdminCategory'] {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    active: !store.inactive.has(row.slug),
    broker_account: row.broker_account ?? null,
    usage_count: kind.usage(store, row.id),
    // The mock has no recurring entries or categorization rules.
    recurring_count: 0,
    rule_count: 0,
  };
}

const find = (store: Store, kind: Kind, slug: string | undefined) =>
  kind.rows(store).find((row) => row.slug === slug);

// The changeset's messages, for the fields the admin form can get wrong.
function validate(
  store: Store,
  kind: Kind,
  name: string | undefined,
  brokerAccount: string | null,
  self?: Row
) {
  const others = kind.rows(store).filter((row) => row !== self);
  const errors: Record<string, string[]> = {};

  if (name !== undefined || !self) {
    if (!name?.trim()) errors.name = ["can't be blank"];
    else if (others.some((row) => row.name === name)) {
      errors.name = ['has already been taken'];
    }
  }
  if (
    brokerAccount &&
    others.some((row) => row.broker_account === brokerAccount)
  ) {
    errors.broker_account = ['has already been taken'];
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

// Only payment methods carry one. It is stored lower-cased; empty unlinks.
const brokerAccount = (kind: Kind, value: string | null | undefined) =>
  kind === kinds.payed && value ? value.toLowerCase() : null;

export const categoryHandlers: Pick<Handlers, AdminOperations> = {
  listAdminCategories: ({ store, path }) => {
    const kind = kinds[path.kind ?? ''];
    if (!kind) return unknownKind;

    return {
      status: 200,
      body: kind
        .rows(store)
        .map((row) => view(store, kind, row))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },

  createAdminCategory: ({ store, path, body }) => {
    const kind = kinds[path.kind ?? ''];
    if (!kind) return unknownKind;

    const broker = brokerAccount(kind, body.broker_account);
    const errors = validate(store, kind, body.name, broker);
    if (errors) return { status: 422, body: { errors } };

    const row: Row = {
      id: store.nextId++,
      slug: randomUUID(),
      name: body.name as string,
    };
    if (kind === kinds.payed) row.broker_account = broker;
    kind.rows(store).push(row);

    return { status: 201, body: view(store, kind, row) };
  },

  updateAdminCategory: ({ store, path, body }) => {
    const kind = kinds[path.kind ?? ''];
    if (!kind) return unknownKind;
    const row = find(store, kind, path.slug);
    if (!row) return notFound;

    const relinks = kind === kinds.payed && body.broker_account !== undefined;
    const broker = relinks ? brokerAccount(kind, body.broker_account) : null;
    const errors = validate(store, kind, body.name, broker, row);
    if (errors) return { status: 422, body: { errors } };

    if (body.name !== undefined) row.name = body.name;
    if (relinks) row.broker_account = broker;

    return { status: 200, body: view(store, kind, row) };
  },

  deleteAdminCategory: ({ store, path }) => {
    const kind = kinds[path.kind ?? ''];
    if (!kind) return unknownKind;
    const row = find(store, kind, path.slug);
    if (!row) return notFound;

    if (kind.deactivates) {
      store.inactive.add(row.slug);
    } else if (kind.usage(store, row.id) > 0) {
      return { status: 409, body: { error: 'Category is still in use' } };
    } else {
      const rows = kind.rows(store);
      rows.splice(rows.indexOf(row), 1);
    }

    return { status: 204 };
  },

  activateAdminCategory: ({ store, path }) => {
    const kind = kinds[path.kind ?? ''];
    if (!kind) return unknownKind;
    const row = find(store, kind, path.slug);
    if (!row) return notFound;

    if (!kind.deactivates) {
      return {
        status: 422,
        body: { error: 'This kind of category has no active flag' },
      };
    }

    store.inactive.delete(row.slug);
    return { status: 200, body: view(store, kind, row) };
  },
};
