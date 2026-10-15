// Strict JSON validation against the contract's schemas: no coercion between
// strings and numbers, no undeclared keys. The same rules the backend's
// contract check applies to real responses, so a mock response that passes
// here is one the backend could have sent.
import spec from "@/contracts/openapi.json";

type Json = unknown;

interface Schema {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: Json[];
  format?: string;
  pattern?: string;
}

const schemas = spec.components.schemas as Record<string, Schema>;

const jsonType = (value: Json) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

function resolve(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace("#/components/schemas/", "");
  const found = schemas[name];
  if (!found) throw new Error(`unknown schema ${schema.$ref}`);
  return found;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringErrors(value: string, schema: Schema, path: string): string[] {
  const errors: string[] = [];
  if (schema.format === "date" && !ISO_DATE.test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not an ISO 8601 date`);
  }
  if (schema.format === "uuid" && !UUID.test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not a UUID`);
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  return errors;
}

function objectErrors(value: Record<string, Json>, schema: Schema, path: string): string[] {
  const properties = schema.properties ?? {};
  const errors: string[] = [];

  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${path}.${key}: is missing`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (key in properties) {
      errors.push(...validate(item, properties[key], `${path}.${key}`));
    } else if (schema.additionalProperties === false) {
      errors.push(`${path}.${key}: is not declared in the schema`);
    }
  }
  return errors;
}

/** Problems as `path: message` strings; empty when `value` matches `schema`. */
export function validate(value: Json, ref: Schema, path = "$"): string[] {
  const schema = resolve(ref);

  if (value === null) {
    return schema.nullable || !schema.type ? [] : [`${path}: is null, expected ${schema.type}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path}: ${JSON.stringify(value)} is not one of ${schema.enum}`];
  }

  const actual = jsonType(value);
  switch (schema.type) {
    case undefined:
      return [];
    case "object":
      return actual === "object"
        ? objectErrors(value as Record<string, Json>, schema, path)
        : [`${path}: is ${actual}, expected object`];
    case "array":
      return actual === "array"
        ? (value as Json[]).flatMap((item, index) =>
            schema.items ? validate(item, schema.items, `${path}[${index}]`) : [],
          )
        : [`${path}: is ${actual}, expected array`];
    case "string":
      return actual === "string"
        ? stringErrors(value as string, schema, path)
        : [`${path}: is ${actual}, expected string`];
    case "integer":
      return Number.isInteger(value) ? [] : [`${path}: is ${actual}, expected integer`];
    default:
      return actual === schema.type ? [] : [`${path}: is ${actual}, expected ${schema.type}`];
  }
}
