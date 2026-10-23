import { join } from 'node:path';
import { resolveArtifactDir } from '@crustjs/core';
import { scaffold } from '@crustjs/create';
import { input } from '@crustjs/prompts';
import { createStore } from '@crustjs/store';
import { readConfig, SyncError } from './sync.ts';
import type { Environment } from './types.ts';

// Only non-secret destination settings are persisted. Credentials remain in env.
function settingsStore(cwd: string) {
  return createStore({
    dirPath: join(cwd, '.stars-to-notion'),
    name: 'config',
    access: 'private',
    fields: {
      GITHUB_STAR_USER: { type: 'string', default: '' },
      NOTION_DATA_SOURCE_ID: { type: 'string', default: '' },
    },
  });
}

export async function withLocalSettings(env: Environment, cwd: string) {
  try {
    const saved = await settingsStore(cwd).read();
    return {
      ...env,
      GITHUB_STAR_USER:
        env.GITHUB_STAR_USER?.trim() ||
        env.GITHUB_REPOSITORY_OWNER?.trim() ||
        saved.GITHUB_STAR_USER,
      NOTION_DATA_SOURCE_ID:
        env.NOTION_DATA_SOURCE_ID?.trim() || saved.NOTION_DATA_SOURCE_ID,
    };
  } catch {
    throw new SyncError(
      'Could not read local settings (.stars-to-notion/config.json).',
    );
  }
}

export async function initialize(
  cwd: string,
  options: {
    user?: string;
    dataSourceId?: string;
    nonInteractive?: boolean;
  },
  template: string | URL = resolveArtifactDir('templates'),
) {
  if (options.nonInteractive && (!options.user || !options.dataSourceId)) {
    throw new Error(
      'init requires --user and --data-source-id in non-interactive mode.',
    );
  }
  const user = await input({
    message: 'GitHub user?',
    initial: options.user,
    validate: (value) => {
      validateSettings(value, 'a'.repeat(32));
    },
  });
  const dataSourceId = await input({
    message: 'Notion data source ID?',
    initial: options.dataSourceId,
    validate: (value) => {
      validateSettings(user, value);
    },
  });
  const config = validateSettings(user, dataSourceId);
  // abort refuses a non-empty directory; never overwrite an existing setup.
  await scaffold({
    template,
    dest: join(cwd, '.stars-to-notion'),
    context: { user: config.user, dataSourceId: config.dataSourceId },
    conflict: 'abort',
  });
  await settingsStore(cwd).write({
    GITHUB_STAR_USER: config.user,
    NOTION_DATA_SOURCE_ID: config.dataSourceId,
  });
}

function validateSettings(user: string, dataSourceId: string) {
  return readConfig({
    GITHUB_STAR_USER: user,
    NOTION_DATA_SOURCE_ID: dataSourceId,
    GITHUB_TOKEN: 'validation-only',
    NOTION_TOKEN: 'validation-only',
  });
}
