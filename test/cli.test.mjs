import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, runCli } from '../src/cli.ts';

const env = {
  GITHUB_TOKEN: 'github-test-secret',
  NOTION_TOKEN: 'notion-test-secret',
  NOTION_DATA_SOURCE_ID: 'a'.repeat(32),
  GITHUB_REPOSITORY_OWNER: 'example',
};
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('Crust help bypasses configuration, synchronization and summary writing', async () => {
  const logs = [];
  const unexpected = () => {
    assert.fail('Help must have no sync side effects');
  };
  assert.equal(
    await runCli(
      ['--help'],
      { GITHUB_STEP_SUMMARY: '/unused' },
      {
        write: (text) => logs.push(text),
        runSync: unexpected,
        append: unexpected,
        writeError: unexpected,
      },
    ),
    0,
  );
  assert.match(logs.join('\n'), /Usage:/);
  assert.match(logs.join('\n'), /GITHUB_TOKEN/);
  assert.match(logs.join('\n'), /--help/);
});

test('Effect execution preserves success counts, summary append and invocation isolation', async () => {
  const logs = [];
  const writes = [];
  const deps = {
    runSync: async (config, { stats }) => {
      assert.equal(config.user, 'example');
      stats.created = 2;
    },
    write: (text) => logs.push(text),
    append: async (...args) => {
      writes.push(args);
    },
  };
  assert.equal(
    await main({ ...env, GITHUB_STEP_SUMMARY: '/summary' }, deps),
    0,
  );
  assert.deepEqual(writes, [['/summary', logs[0], 'utf8']]);
  assert.match(logs[0], /\| created \| 2 \|/);
  assert.match(logs[0], /AI disabled/);
  await main(env, { ...deps, runSync: async () => {} });
  assert.match(logs[1], /\| created \| 0 \|/);
});

test('Effect handles configuration and summary failures without leaking details', async () => {
  const logs = [];
  assert.equal(
    await main(
      {},
      {
        write: (text) => logs.push(text),
        runSync: () => assert.fail('Invalid configuration'),
      },
    ),
    1,
  );
  assert.match(logs[0], /Missing configuration: GITHUB_TOKEN/);
  assert.match(logs[0], /\| failed \| 1 \|/);
  assert.match(logs[0], /AI processing was not started/);
  assert.equal(
    await main(
      { ...env, GITHUB_STEP_SUMMARY: '/summary-secret' },
      {
        runSync: async () => {},
        write: (text) => logs.push(text),
        append: async () => {
          throw new Error('summary-secret');
        },
      },
    ),
    1,
  );
  assert.equal(logs.at(-1), 'Could not write the Actions step summary.');
  assert.doesNotMatch(logs.join('\n'), /summary-secret/);
});

test('actual entry point supports help and rejects invalid argv without echoing values', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'stars-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = join(dir, 'summary');
  // No credentials reach child processes; any accidental sync fails locally.
  const childEnv = { GITHUB_STEP_SUMMARY: summary };
  const help = execFileSync(process.execPath, [cliPath, '--help'], {
    env: childEnv,
    encoding: 'utf8',
  });
  assert.match(help, /Usage:/);
  for (const args of [
    ['--unknown=argv-secret'],
    ['positional-secret'],
    ['--', 'raw-secret'],
  ]) {
    assert.throws(
      () =>
        execFileSync(process.execPath, [cliPath, ...args], {
          env: childEnv,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      (error) => {
        assert.equal(error.status, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /--help/);
        assert.doesNotMatch(
          error.stderr,
          /secret|Sync stopped|Missing configuration/,
        );
        return true;
      },
    );
  }
  await assert.rejects(readFile(summary), { code: 'ENOENT' });
  assert.throws(
    () =>
      execFileSync(process.execPath, [cliPath], {
        env: {},
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stdout, /Missing configuration: GITHUB_TOKEN/);
      assert.equal(error.stderr, '');
      return true;
    },
  );
});

test('importing the CLI does not execute it', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)});`,
    ],
    { env: {}, encoding: 'utf8' },
  );
  assert.equal(output, '');
});

test('unexpected Effect defects reach the CLI boundary without exposing their message', async () => {
  const exitCode = process.exitCode;
  const errors = [];
  try {
    assert.equal(
      await main(env, {
        runSync: async () => {},
        write: () => {
          throw new Error('output-secret');
        },
        writeError: (text) => errors.push(text),
      }),
      1,
    );
    assert.match(errors.join('\n'), /CLI execution failure/);
    assert.doesNotMatch(errors.join('\n'), /output-secret|Error:|at /);
  } finally {
    process.exitCode = exitCode;
  }
});
