// The engine is domain-free: it reaches nothing of an app's by import, and no
// app's vocabulary appears in it. Specs, recordings, stores and handlers only
// arrive as arguments.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ENGINE = resolve(__dirname, '../../src/engine');
const FORBIDDEN_WORDS = ['expense', 'trip', 'concert', 'invisalign'];
const ALLOWED_PACKAGES = ['vitest'];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name))
      : [join(dir, entry.name)]
  );
}

const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Why `file`'s source breaks isolation; empty when it does not. */
export function isolationProblems(file: string, source: string): string[] {
  const problems: string[] = [];

  for (const [, specifier] of source.matchAll(IMPORT)) {
    if (specifier.startsWith('.')) {
      const target = relative(ENGINE, resolve(dirname(file), specifier));
      if (target.startsWith('..')) {
        problems.push(`imports ${specifier}, outside src/engine`);
      }
    } else if (specifier.startsWith('node:')) {
      continue;
    } else if (!ALLOWED_PACKAGES.includes(specifier)) {
      problems.push(`imports ${specifier}`);
    }
  }

  const lower = source.toLowerCase();
  for (const word of FORBIDDEN_WORDS) {
    if (lower.includes(word)) problems.push(`mentions "${word}"`);
  }
  return problems;
}

describe('engine isolation', () => {
  const files = filesUnder(ENGINE);

  it('has engine files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [relative(ENGINE, file), file]))(
    '%s imports nothing of an app and names no domain',
    (_name, file) => {
      expect(isolationProblems(file, readFileSync(file, 'utf8'))).toEqual([]);
    }
  );

  it('catches the imports and words it forbids', () => {
    const file = join(ENGINE, 'server.ts');
    const offending = [
      `import spec from '@/contracts/openapi.json';`,
      `import { handlers } from '@/lib/mock/handlers';`,
      `import { validate } from '../../vendor/et-lib-mock/validate';`,
      `import { x } from 'vendor/crm-lib-mock/store';`,
      `const s = await import('../../tests/fixtures/widgets/store');`,
      `// the Trips page`,
      `const expenses = [];`,
    ].join('\n');

    expect(isolationProblems(file, offending)).toEqual([
      'imports @/contracts/openapi.json',
      'imports @/lib/mock/handlers',
      'imports ../../vendor/et-lib-mock/validate, outside src/engine',
      'imports vendor/crm-lib-mock/store',
      'imports ../../tests/fixtures/widgets/store, outside src/engine',
      'mentions "expense"',
      'mentions "trip"',
    ]);
    expect(isolationProblems(file, `import { x } from './routes';`)).toEqual([]);
  });
});
