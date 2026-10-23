import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readConfig, sync, SyncError } from './sync.mjs';

export async function main(env = process.env, { runSync = sync, write = console.log, append = appendFile } = {}) {
  const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
  let failure;
  try {
    await runSync(readConfig(env), { stats });
  } catch (error) {
    stats.failed++;
    failure = error instanceof SyncError ? error.message : 'Unexpected sync failure';
  }
  const report = [
    '## GitHub Stars → Notion', '',
    '| Result | Count |', '| --- | ---: |',
    ...Object.entries(stats).map(([key, value]) => `| ${key} | ${value} |`),
    '', failure ? `Sync stopped: ${failure}` : 'Sync completed.', '',
  ].join('\n');
  write(report);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      await append(env.GITHUB_STEP_SUMMARY, report, 'utf8');
    } catch {
      write('Could not write the Actions step summary.');
      return 1;
    }
  }
  return failure ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
