#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Crust, defineCommand } from '@crustjs/core';
import { handler } from '@crustjs/effect';
import { defineEnv } from '@crustjs/env';
import { help } from '@crustjs/extensions';
import { spinner } from '@crustjs/progress';
import { skill } from '@crustjs/skills';
import { Effect } from 'effect';
import { initialize, withLocalSettings } from './settings.ts';
import { readConfig, SyncError, sync } from './sync.ts';
import type { Environment, SyncConfig, SyncStats } from './types.ts';

export interface CliDependencies {
  cwd?: string;
  interactive?: boolean;
  templateDir?: string | URL;
  runSync?: (
    config: SyncConfig,
    options: { stats: SyncStats; signal: AbortSignal },
  ) => Promise<unknown>;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  append?: (path: string, text: string, encoding: 'utf8') => Promise<unknown>;
}

// Construct a fresh program per invocation: stats and injected dependencies are local.
function syncProgram(
  loadEnv: () => Promise<Environment>,
  {
    runSync = sync,
    write = console.log,
    append = appendFile,
    cwd = process.cwd(),
    interactive = Boolean(process.stderr.isTTY && process.stdin.isTTY),
  }: CliDependencies = {},
) {
  return Effect.gen(function* () {
    let env: Environment = {};
    const stats: SyncStats = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const failure = yield* Effect.tryPromise({
      try: async (signal) => {
        env = await loadEnv();
        const config = readConfig(await withLocalSettings(env, cwd));
        signal.throwIfAborted();
        const task = () => runSync(config, { stats, signal });
        if (interactive) {
          const indicator = spinner({
            message: 'Syncing GitHub stars to Notion…',
            sigint: false,
          });
          indicator.start();
          let completed = false;
          try {
            await task();
            completed = !stats.ai_failed;
          } finally {
            indicator.stop(completed ? 'success' : 'error');
          }
        } else {
          await task();
        }
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

export function createCli(
  env: Environment = process.env,
  dependencies: CliDependencies = {},
) {
  let syncCode = 0;
  // Strings preserve the existing strict AI validation and safe error reports.
  const environment = defineEnv(
    'environment',
    {
      GITHUB_TOKEN: {
        type: 'string',
        description: 'GitHub API token (secret)',
      },
      NOTION_TOKEN: {
        type: 'string',
        description: 'Notion integration token (secret)',
      },
      NOTION_DATA_SOURCE_ID: {
        type: 'string',
        description: 'Notion data source ID',
      },
      GITHUB_STAR_USER: { type: 'string', description: 'GitHub star owner' },
      GITHUB_REPOSITORY_OWNER: {
        type: 'string',
        description: 'Fallback GitHub user',
      },
      CLOUDFLARE_ACCOUNT_ID: { type: 'string' },
      CLOUDFLARE_API_TOKEN: {
        type: 'string',
        description: 'Workers AI token (secret)',
      },
      CLOUDFLARE_AI_MODEL: { type: 'string' },
      AI_MAX_ITEMS: { type: 'string' },
      AI_FORCE_REGENERATE: { type: 'string' },
      GITHUB_STEP_SUMMARY: {
        type: 'string',
        description: 'Actions summary path',
      },
    },
    { source: env },
  );
  const app = new Crust('github-stars-to-notion', {
    version: '0.1.0',
    description:
      'Sync public GitHub stars to Notion. Configure GITHUB_TOKEN, NOTION_TOKEN and NOTION_DATA_SOURCE_ID; set GITHUB_STAR_USER or GITHUB_REPOSITORY_OWNER. Optional AI settings: see README.',
  })
    .provide(environment())
    .extend(help())
    .extend(skill({ autoUpdate: false, defaultScope: 'project' }))
    .add(
      defineCommand(
        'init',
        { description: 'Create local non-secret settings (requires a build).' },
        (command) =>
          command
            .flags({ name: 'user', type: 'string', description: 'GitHub user' })
            .flags({
              name: 'data-source-id',
              type: 'string',
              description: 'Notion data source ID',
            })
            .flags({
              name: 'non-interactive',
              type: 'boolean',
              description: 'Require settings as flags; never prompt',
            })
            .action(async ({ flags, rawArgs, stdout }) => {
              if (rawArgs.length)
                throw new Error('Unexpected positional arguments');
              await initialize(
                dependencies.cwd ?? process.cwd(),
                {
                  user: flags.user,
                  dataSourceId: flags['data-source-id'],
                  nonInteractive: flags['non-interactive'],
                },
                dependencies.templateDir,
              );
              stdout(
                'Created .stars-to-notion/.env.example and config.json. Supply GITHUB_TOKEN and NOTION_TOKEN through your environment.',
              );
            }),
      ),
    )
    .action(
      handler(function* ({ rawArgs, ctx, stdout }) {
        if (rawArgs.length)
          return yield* Effect.fail(
            new Error('Unexpected positional arguments'),
          );
        syncCode = yield* syncProgram(() => ctx.environment, {
          ...dependencies,
          write: dependencies.write ?? stdout,
        });
        return syncCode;
      }),
    );
  return { app, exitCode: () => syncCode };
}

export async function runCli(
  argv: string[],
  env: Environment = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const { write = console.log, writeError = console.error } = dependencies;
  const { app, exitCode } = createCli(env, dependencies);
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
  return cliCode || exitCode();
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
