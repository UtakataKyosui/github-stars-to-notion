import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Crust } from '@crustjs/core';
import { handler } from '@crustjs/effect';
import { help } from '@crustjs/extensions';
import { Effect } from 'effect';
import { readConfig, SyncError, sync } from './sync.ts';
import type { Environment, SyncConfig, SyncStats } from './types.ts';

export interface CliDependencies {
  runSync?: (
    config: SyncConfig,
    options: { stats: SyncStats },
  ) => Promise<unknown>;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  append?: (path: string, text: string, encoding: 'utf8') => Promise<unknown>;
}

// Construct a fresh program per invocation: stats and injected dependencies are local.
function syncProgram(
  env: Environment,
  {
    runSync = sync,
    write = console.log,
    append = appendFile,
  }: CliDependencies = {},
) {
  return Effect.gen(function* () {
    const stats: SyncStats = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const failure = yield* Effect.tryPromise({
      try: async () => {
        await runSync(readConfig(env), { stats });
      },
      catch: (error) =>
        error instanceof SyncError ? error.message : 'Unexpected sync failure',
    }).pipe(
      Effect.match({
        onSuccess: () => undefined,
        onFailure: (message) => {
          stats.failed++;
          return message;
        },
      }),
    );
    const report = formatReport(stats, failure);
    yield* Effect.sync(() => write(report));
    const summaryPath = env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      const saved = yield* Effect.tryPromise({
        try: () => append(summaryPath, report, 'utf8'),
        catch: () => 'Could not write the Actions step summary.',
      }).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
      if (!saved) {
        yield* Effect.sync(() =>
          write('Could not write the Actions step summary.'),
        );
        return 1;
      }
    }
    return failure || stats.ai_failed ? 1 : 0;
  });
}

function formatReport(stats: SyncStats, failure: string | undefined): string {
  return [
    '## GitHub Stars → Notion',
    '',
    '| Result | Count |',
    '| --- | ---: |',
    ...Object.entries(stats).map(([key, value]) => `| ${key} | ${value} |`),
    '',
    failure ? `Sync stopped: ${failure}` : 'Basic sync completed.',
    failure && stats.ai_generated === undefined
      ? 'AI processing was not started.'
      : stats.ai_failed
        ? 'AI processing had failures. Basic sync data is preserved; check AI configuration/schema and retry.'
        : stats.ai_generated !== undefined
          ? 'AI processing completed.'
          : 'AI disabled (Cloudflare configuration is absent).',
    '',
  ].join('\n');
}

export async function runCli(
  argv: string[],
  env: Environment = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const { write = console.log, writeError = console.error } = dependencies;
  let syncCode = 0;
  const app = new Crust('github-stars-to-notion', {
    description:
      'Sync public GitHub stars to Notion. Configure GITHUB_TOKEN, NOTION_TOKEN and NOTION_DATA_SOURCE_ID; set GITHUB_STAR_USER or GITHUB_REPOSITORY_OWNER. Optional AI settings: see README.',
  })
    .extend(help())
    .action(
      handler(function* ({ rawArgs }) {
        if (rawArgs.length)
          return yield* Effect.fail(
            new Error('Unexpected positional arguments'),
          );
        syncCode = yield* syncProgram(env, dependencies);
      }),
    );
  const cliCode = await app.execute({
    argv,
    io: {
      stdout: write,
      // Parser diagnostics can echo arbitrary argv values. Never print them.
      stderr: () =>
        writeError(
          'Invalid command or CLI execution failure. Run with --help for usage.',
        ),
    },
  });
  return cliCode || syncCode;
}

export async function main(
  env: Environment = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  return runCli([], env, dependencies);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
