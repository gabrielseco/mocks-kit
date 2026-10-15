// The contract's paths as matchable routes.
import type { OpenApiDocument } from './types';

export interface Route {
  method: string;
  pattern: RegExp;
  params: string[];
  operationId: string;
  authed: boolean;
  responses: Record<string, { content?: Record<string, { schema: object }> }>;
}

interface SpecOperation {
  operationId: string;
  security?: unknown[];
  responses: Route['responses'];
}

export function buildRoutes(spec: OpenApiDocument): Route[] {
  const routes: Route[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item as Record<string, SpecOperation>)) {
      if (!operation?.operationId) continue;

      const params = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      routes.push({
        method: method.toUpperCase(),
        pattern: new RegExp(`^${path.replace(/\{\w+\}/g, '([^/]+)')}$`),
        params,
        operationId: operation.operationId,
        authed: (operation.security ?? []).length > 0,
        responses: operation.responses,
      });
    }
  }

  // Fewer parameters first, so /api/things/latest wins over /api/things/{slug}.
  // The sort is stable: among equals, the document's order holds.
  return routes.sort((a, b) => a.params.length - b.params.length);
}

/** The route for this method and path, or undefined when the contract has none. */
export function matchRoute(routes: Route[], method: string, pathname: string): Route | undefined {
  return routes
    .filter((route) => route.pattern.test(pathname))
    .find((route) => route.method === method);
}

/** Path parameters by name, decoded. */
export function pathParams(route: Route, pathname: string): Record<string, string> {
  const values = pathname.match(route.pattern)!.slice(1);
  return Object.fromEntries(route.params.map((name, i) => [name, decodeURIComponent(values[i])]));
}
