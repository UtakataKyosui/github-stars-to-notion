import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { SyncError } from './sync.ts';
import type { Environment } from './types.ts';

// Parse data only: never mutate process.env or execute dotenv values.
export async function withDotEnv(
  env: Environment,
  cwd: string,
  file?: string,
): Promise<Environment> {
  let values: Environment;
  try {
    values = parseEnv(await readFile(resolve(cwd, file ?? '.env'), 'utf8'));
  } catch (error) {
    if (
      file === undefined &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return env;
    }
    // Filesystem errors can quote paths; parser errors can quote file contents.
    throw new SyncError(
      'Could not read the environment file. Check --env-file or .env.',
    );
  }
  return {
    ...values,
    ...Object.fromEntries(
      Object.entries(env).filter(([, value]) => value !== undefined),
    ),
  };
}
