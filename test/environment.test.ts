import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { type CliDependencies, createCli, runCli } from '../src/cli.ts';

const id = 'a'.repeat(32);
const dotenv = [
  '# Local test credentials',
  'export GITHUB_TOKEN="dotenv-github-secret"',
  "NOTION_TOKEN='dotenv-notion-secret'",
  `NOTION_DATA_SOURCE_ID=${id}`,
  'GITHUB_STAR_USER=file-user # trailing comment',
  `CLOUDFLARE_ACCOUNT_ID=${'b'.repeat(32)}`,
  'CLOUDFLARE_API_TOKEN=dotenv-ai-secret',
  'AI_MAX_ITEMS=3',
  'AI_FORCE_REGENERATE=true',
  'NODE_OPTIONS=--require=/must-not-execute.cjs',
].join('\n');

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'stars-env-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('CLI loads .env including AI settings without mutating process.env', async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, '.env'), dotenv);
  const before = { ...process.env };
  const { app } = createCli(
    {},
    {
      cwd,
      interactive: false,
      runSync: async (config) => {
        assert.ok(config.ai && !config.ai.invalid);
        assert.equal(config.user, 'file-user');
        assert.equal(config.githubToken, 'dotenv-github-secret');
        assert.equal(config.notionToken, 'dotenv-notion-secret');
        assert.equal(config.dataSourceId, id);
        assert.equal(config.ai.token, 'dotenv-ai-secret');
        assert.equal(config.ai.maxItems, 3);
        assert.equal(config.ai.force, true);
      },
    },
  );
  const result = await app.run([]);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /dotenv-.*secret/);
  assert.deepEqual({ ...process.env }, before);
});

test('shell environment overrides .env and --env-file selects only the requested file', async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, '.env'), 'GITHUB_TOKEN=wrong-default-token');
  await writeFile(join(cwd, 'custom.env'), dotenv);
  const result = await createCli(
    {
      GITHUB_TOKEN: 'shell-secret',
      GITHUB_STAR_USER: 'shell-user',
      NOTION_DATA_SOURCE_ID: 'c'.repeat(32),
      NOTION_TOKEN: undefined,
    },
    {
      cwd,
      interactive: false,
      runSync: async (config) => {
        assert.equal(config.githubToken, 'shell-secret');
        assert.equal(config.notionToken, 'dotenv-notion-secret');
        assert.equal(config.user, 'shell-user');
        assert.equal(config.dataSourceId, 'c'.repeat(32));
      },
    },
  ).app.run([], { flags: { 'env-file': 'custom.env' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 0);
});

test('optional .env may be absent; explicit missing and unreadable files fail safely before sync', async (t) => {
  const cwd = await workspace(t);
  const env = {
    GITHUB_TOKEN: 'shell-secret',
    NOTION_TOKEN: 'shell-secret',
    GITHUB_STAR_USER: 'example',
    NOTION_DATA_SOURCE_ID: id,
  };
  let calls = 0;
  const deps = {
    cwd,
    interactive: false,
    runSync: async () => {
      calls++;
    },
  };
  const initial = await createCli(env, deps).app.run([]);
  assert.equal(initial.status, 'completed');
  assert.equal(initial.result, 0);
  assert.equal(calls, 1);
  const explicit = await createCli(env, deps).app.run([], {
    flags: { 'env-file': 'missing-private-path.env' },
  });
  assert.equal(explicit.status, 'completed');
  assert.equal(explicit.result, 1);
  assert.match(explicit.stdout, /Could not read the environment file/);
  assert.doesNotMatch(explicit.stdout, /missing-private-path|shell-secret/);
  await mkdir(join(cwd, '.env'));
  const unreadable = await createCli(env, deps).app.run([]);
  assert.equal(unreadable.status, 'completed');
  assert.equal(unreadable.result, 1);
  assert.equal(calls, 1);
  assert.equal(
    (await createCli(env, deps).app.run([], { flags: { help: true } })).status,
    'handled',
  );
});

test('help and init ignore dotenv; invalid dotenv values never appear in reports', async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, '.env'),
    dotenv.replace(
      'GITHUB_STAR_USER=file-user',
      'GITHUB_STAR_USER=private/invalid-value',
    ),
  );
  const output: string[] = [];
  const deps: CliDependencies = {
    cwd,
    interactive: false,
    write: (text) => output.push(text),
    runSync: () => assert.fail('must not sync'),
  };
  assert.equal(
    await runCli(['--env-file', 'missing-private-path', '--help'], {}, deps),
    0,
  );
  assert.equal(await runCli([], {}, deps), 1);
  assert.match(output.join('\n'), /Invalid GITHUB_STAR_USER/);
  assert.doesNotMatch(
    output.join('\n'),
    /private\/invalid-value|dotenv-github-secret|dotenv-notion-secret|dotenv-ai-secret/,
  );
  const initialized = await createCli(
    {},
    {
      ...deps,
      templateDir: new URL('../templates/', import.meta.url),
    },
  )
    .app.at(['init'])
    .run({
      flags: { user: 'example', 'data-source-id': id, 'non-interactive': true },
    });
  assert.equal(initialized.status, 'completed');
});
