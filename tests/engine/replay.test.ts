// replayExamples against the widgets fixture: its recordings pass as one test
// each, and a handler that drifts from them fails the suite.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayExamples } from '../../src/engine/replay';
import { handlers } from '../fixtures/widgets/handlers';
import { engine, recordings } from '../fixtures/widgets/server';

// The real use: every mocked operation's recordings replay and pass;
// listGadgets/default is registered as skipped.
replayExamples({ engine, recordings, only: Object.keys(handlers) });

interface JsonReport {
  numFailedTests: number;
  testResults: {
    assertionResults: { fullName: string; status: string; failureMessages: string[] }[];
  }[];
}

function runNested(): {
  exitCode: number | null;
  results: Map<string, string>;
  report: JsonReport;
} {
  const root = resolve(__dirname, '../..');
  const out = mkdtempSync(join(tmpdir(), 'replay-drift-'));
  try {
    const outputFile = join(out, 'report.json');
    const run = spawnSync(
      process.execPath,
      [
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        resolve(root, 'tests/fixtures/drift/vitest.config.ts'),
        '--reporter=json',
        `--outputFile=${outputFile}`,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const report = JSON.parse(readFileSync(outputFile, 'utf8')) as JsonReport;
    const results = new Map(
      report.testResults
        .flatMap((file) => file.assertionResults)
        .map((test) => [test.fullName, test.status]),
    );
    return { exitCode: run.status, results, report };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe('replayExamples with a drifting handler', () => {
  const nested = runNested();

  it('fails the suite', () => {
    expect(nested.exitCode).not.toBe(0);
  });

  it('registers each recorded example as its own test', () => {
    expect(nested.results.size).toBe(recordings.examples.length * 2);
  });

  it('reports the drifting operation and passes the rest', () => {
    expect(
      Object.fromEntries([...nested.results].filter(([name]) => name.startsWith('drifting'))),
    ).toEqual({
      'drifting listWidgets/default': 'failed',
      'drifting listWidgets/limited': 'failed',
      'drifting listWidgets/signedOut': 'passed',
      'drifting getWidget/default': 'passed',
      'drifting getWidget/notFound': 'passed',
      'drifting getFeaturedWidget/default': 'passed',
      'drifting getHealth/default': 'passed',
      'drifting listGadgets/default': 'skipped',
    });
  });

  it('shows what the handler returned against what was recorded', () => {
    const failure = nested.report.testResults
      .flatMap((file) => file.assertionResults)
      .find((test) => test.fullName === 'drifting listWidgets/default')!;

    expect(failure.failureMessages.join('\n')).toContain('to deeply equal');
  });

  it('skips filtered-out operations without failing; unfiltered they are reported', () => {
    expect(nested.results.get('drifting listGadgets/default')).toBe('skipped');
    expect(nested.results.get('unfiltered listGadgets/default')).toBe('failed');
    expect(nested.report.numFailedTests).toBe(3);
  });
});
