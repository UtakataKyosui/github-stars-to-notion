import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(
  new URL('../.crust/root/bin/github-stars-to-notion.js', import.meta.url),
);
const cwd = await mkdtemp(join(tmpdir(), 'stars-package-'));
// No credentials or inherited build variables reach the packaged command.
const options = { cwd, env: {}, encoding: 'utf8' as const, timeout: 10000 };
try {
  const help = execFileSync(process.execPath, [entry, '--help'], options);
  assert.match(help, /Environment:/);
  assert.match(help, /Agent skills:/);
  const id = 'a'.repeat(32);
  execFileSync(
    process.execPath,
    [
      entry,
      'init',
      '--non-interactive',
      '--user',
      'example',
      '--data-source-id',
      id,
    ],
    options,
  );
  const path = join(cwd, '.stars-to-notion/config.json');
  const config = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(config), {
    GITHUB_STAR_USER: 'example',
    NOTION_DATA_SOURCE_ID: id,
  });
  assert.match(
    await readFile(join(cwd, '.stars-to-notion/.env.example'), 'utf8'),
    /GITHUB_STAR_USER=example/,
  );
  const repeated = spawnSync(
    process.execPath,
    [
      entry,
      'init',
      '--non-interactive',
      '--user',
      'other',
      '--data-source-id',
      id,
    ],
    options,
  );
  assert.equal(repeated.status, 1);
  assert.equal(await readFile(path, 'utf8'), config);
  const missing = spawnSync(process.execPath, [entry], options);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Missing configuration: GITHUB_TOKEN/);
  await writeFile(join(cwd, '.env'), 'GITHUB_TOKEN=packaged-test-secret');
  const dotenv = spawnSync(process.execPath, [entry], options);
  assert.equal(dotenv.status, 1);
  assert.match(dotenv.stdout, /Missing configuration: NOTION_TOKEN/);
  assert.doesNotMatch(dotenv.stdout + dotenv.stderr, /packaged-test-secret/);
  await writeFile(join(cwd, 'custom.env'), 'NOTION_TOKEN=packaged-test-secret');
  const custom = spawnSync(
    process.execPath,
    [entry, '--env-file', 'custom.env'],
    options,
  );
  assert.equal(custom.status, 1);
  assert.match(custom.stdout, /Missing configuration: GITHUB_TOKEN/);
  const shell = spawnSync(process.execPath, [entry], {
    ...options,
    env: { GITHUB_TOKEN: '' },
  });
  assert.equal(shell.status, 1);
  assert.match(shell.stdout, /Missing configuration: GITHUB_TOKEN/);
  const invalid = spawnSync(
    process.execPath,
    [entry, '--invalid=private-value'],
    options,
  );
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-value/);
  const skill = await readFile(
    new URL(
      '../.crust/root/skills/github-stars-to-notion/SKILL.md',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(skill, /name: github-stars-to-notion/);
  assert.match(
    await readFile(
      new URL(
        '../.crust/root/skills/github-stars-to-notion/commands/init.md',
        import.meta.url,
      ),
      'utf8',
    ),
    /non-interactive/,
  );
  console.log('Packaged CLI, templates and generated skills verified.');
} finally {
  await rm(cwd, { recursive: true, force: true });
}
