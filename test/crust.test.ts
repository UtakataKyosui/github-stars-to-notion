import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { withProgressSink } from '@crustjs/progress';
import { captureExecute } from '@crustjs/testing';
import { runInteractive } from '@crustjs/testing/interactive';
import { createCli, main, runCli } from '../src/cli.ts';

const templateDir = new URL('../templates/', import.meta.url);
const id = 'a'.repeat(32);
const credentials = {
  GITHUB_TOKEN: 'github-secret',
  NOTION_TOKEN: 'notion-secret',
};

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'stars-crust-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('init scaffolds non-secret settings, refuses overwrite, and sync honors env precedence', async (t) => {
  const cwd = await workspace(t);
  const { app } = createCli(credentials, { cwd, templateDir });
  const result = await app.at(['init']).run({
    flags: {
      user: 'example',
      'data-source-id': id,
      'non-interactive': true,
    },
  });
  assert.equal(result.status, 'completed');
  assert.match(result.stdout, /Created/);
  const configPath = join(cwd, '.stars-to-notion/config.json');
  const original = await readFile(configPath, 'utf8');
  assert.deepEqual(JSON.parse(original), {
    GITHUB_STAR_USER: 'example',
    NOTION_DATA_SOURCE_ID: id,
  });
  const example = await readFile(
    join(cwd, '.stars-to-notion/.env.example'),
    'utf8',
  );
  assert.match(example, /GITHUB_STAR_USER=example/);
  assert.doesNotMatch(original + example, /github-secret|notion-secret/);
  const repeated = await app.at(['init']).run({
    flags: {
      user: 'other',
      'data-source-id': id,
      'non-interactive': true,
    },
  });
  assert.equal(repeated.status, 'failed');
  assert.equal(await readFile(configPath, 'utf8'), original);

  for (const [extra, expected] of [
    [{}, 'example'],
    [{ GITHUB_REPOSITORY_OWNER: 'owner' }, 'owner'],
    [
      { GITHUB_STAR_USER: 'explicit', GITHUB_REPOSITORY_OWNER: 'owner' },
      'explicit',
    ],
  ] as const) {
    const outcome = await createCli(
      { ...credentials, ...extra },
      {
        cwd,
        interactive: false,
        runSync: async (config) => {
          assert.equal(config.user, expected);
          assert.equal(config.dataSourceId, id);
        },
      },
    ).app.run([]);
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.result, 0);
    assert.match(outcome.stdout, /Basic sync completed/);
  }
  await main(
    {
      ...credentials,
      GITHUB_STAR_USER: 'env-user',
      NOTION_DATA_SOURCE_ID: 'b'.repeat(32),
    },
    {
      cwd,
      interactive: false,
      write: () => {},
      runSync: async (config) =>
        assert.equal(config.dataSourceId, 'b'.repeat(32)),
    },
  );
});

test('interactive init prompts for both settings without running synchronization', async (t) => {
  const cwd = await workspace(t);
  const { app } = createCli(
    {},
    {
      cwd,
      templateDir,
      runSync: () => assert.fail('init must not sync'),
    },
  );
  const session = runInteractive(app, ['init']);
  await session.waitFor(/GitHub user\?/);
  session.type('example');
  session.keys('return');
  await session.waitFor(/Notion data source ID\?/);
  session.type(id);
  session.keys('return');
  await session.done;
  assert.equal(
    JSON.parse(
      await readFile(join(cwd, '.stars-to-notion/config.json'), 'utf8'),
    ).GITHUB_STAR_USER,
    'example',
  );
});

test('invalid init and parser errors never sync or expose credentials', async (t) => {
  const cwd = await workspace(t);
  const { app } = createCli(credentials, {
    cwd,
    templateDir,
    runSync: () => assert.fail('must not sync'),
  });
  for (const args of [
    ['init', '--non-interactive'],
    [
      'init',
      '--non-interactive',
      '--user',
      'invalid/name',
      '--data-source-id',
      id,
    ],
    [
      'init',
      '--non-interactive',
      '--user',
      'example',
      '--data-source-id',
      'invalid',
    ],
    ['--unknown'],
  ]) {
    const result = await captureExecute(app, args);
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /github-secret|notion-secret/,
    );
  }
  await assert.rejects(readFile(join(cwd, '.stars-to-notion/config.json')), {
    code: 'ENOENT',
  });
  const help = await captureExecute(app, ['--help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /Environment:/);
  assert.match(help.stdout, /skills/);
  assert.doesNotMatch(help.stdout, /github-secret|notion-secret/);
});

test('corrupt settings fail safely while help remains available', async (t) => {
  const cwd = await workspace(t);
  const dependencies = {
    cwd,
    templateDir,
    interactive: false,
    runSync: () => assert.fail('must not sync'),
  };
  await createCli({}, dependencies)
    .app.at(['init'])
    .run({
      flags: { user: 'example', 'data-source-id': id, 'non-interactive': true },
    });
  await writeFile(join(cwd, '.stars-to-notion/config.json'), '{corrupt-secret');
  const output: string[] = [];
  assert.equal(
    await main(credentials, {
      ...dependencies,
      write: (text) => output.push(text),
    }),
    1,
  );
  assert.match(output.join('\n'), /Could not read local settings/);
  assert.doesNotMatch(output.join('\n'), /corrupt-secret/);
  assert.equal(
    await runCli(['--help'], {}, { ...dependencies, write: () => {} }),
    0,
  );
});

test('progress cleans up on success and failures without changing sync counts or exposing errors', async (t) => {
  const cwd = await workspace(t);
  for (const kind of ['success', 'ai', 'error']) {
    let terminal = '';
    const reports: string[] = [];
    const code = await withProgressSink(
      {
        isTTY: true,
        write(text) {
          terminal += text;
          return true;
        },
      },
      () =>
        main(
          {
            ...credentials,
            GITHUB_STAR_USER: 'example',
            NOTION_DATA_SOURCE_ID: id,
          },
          {
            cwd,
            interactive: true,
            write: (text) => reports.push(text),
            runSync: async (_config, { stats }) => {
              if (kind === 'ai') stats.ai_failed = 1;
              if (kind === 'error') throw new Error('private-error');
            },
          },
        ),
    );
    assert.equal(code, kind === 'success' ? 0 : 1);
    assert.ok(terminal.includes('\x1b[?25l'));
    assert.ok(terminal.includes('\x1b[?25h'));
    assert.match(terminal, kind === 'success' ? /✓/ : /✗/);
    assert.doesNotMatch(
      terminal + reports.join('\n'),
      /private-error|github-secret|notion-secret/,
    );
    assert.match(
      reports[0],
      kind === 'error' ? /\| failed \| 1 \|/ : /\| failed \| 0 \|/,
    );
  }
});
