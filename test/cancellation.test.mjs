import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AI_PROPERTY_TYPES,
  generateSummary,
  readAiConfig,
  syncSummaries,
} from '../src/ai.ts';
import {
  ApiClient,
  ApiError,
  MANUAL_PROPERTY_TYPES,
  PROPERTY_TYPES,
  readConfig,
  sync,
} from '../src/sync.ts';

const ai = readAiConfig({
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'test',
});

const env = {
  GITHUB_TOKEN: 'test',
  NOTION_TOKEN: 'test',
  NOTION_DATA_SOURCE_ID: 'a'.repeat(32),
  GITHUB_REPOSITORY_OWNER: 'example',
};
const repo = {
  id: 1,
  private: false,
  full_name: 'owner/repo',
  html_url: 'https://github.com/owner/repo',
  description: null,
};
const schema = {
  properties: Object.fromEntries(
    Object.entries({
      ...PROPERTY_TYPES,
      ...MANUAL_PROPERTY_TYPES,
      ...AI_PROPERTY_TYPES,
    }).map(([name, type]) => [name, { type }]),
  ),
};

function pendingResponse(signal, controller) {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
    controller.abort();
  });
}

test('GitHub and AI requests abort without retries when the invocation is cancelled', async () => {
  for (const service of ['GitHub', 'Cloudflare']) {
    const controller = new AbortController();
    let calls = 0;
    let waits = 0;
    const dependencies = {
      signal: controller.signal,
      fetchImpl: (_url, { signal }) => {
        calls++;
        return pendingResponse(signal, controller);
      },
      sleep: async () => {
        waits++;
      },
    };
    const result =
      service === 'GitHub'
        ? new ApiClient(service, 'test', dependencies).request('/test')
        : generateSummary(ai, '{}', dependencies);
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(waits, 0);
  }
});

test('cancellation during retry backoff and Notion throttling prevents the next request', async () => {
  for (const service of ['GitHub', 'Notion', 'Cloudflare']) {
    const controller = new AbortController();
    let calls = 0;
    const dependencies = {
      signal: controller.signal,
      fetchImpl: async () => {
        calls++;
        setImmediate(() => controller.abort());
        return new Response('{}', {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      },
    };
    const result =
      service === 'Cloudflare'
        ? generateSummary(ai, '{}', dependencies)
        : new ApiClient(service, 'test', dependencies).request('/test');
    if (service === 'Notion') setImmediate(() => controller.abort());
    // A broken implementation would otherwise wait for the server's Retry-After.
    await assert.rejects(
      Promise.race([
        result,
        delay(200).then(() => {
          throw new Error('Cancellation did not stop waiting');
        }),
      ]),
      { name: 'AbortError' },
    );
    assert.equal(calls, service === 'Notion' ? 0 : 1);
  }
});

test('SIGINT stops the real synchronization before a Notion create or AI save', () => {
  for (const stage of ['stars', 'inference']) {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { setTimeout as delay } from 'node:timers/promises';
      import { runCli } from './src/cli.ts';
      import { AI_PROPERTY_TYPES } from './src/ai.ts';
      import { ApiClient, sync, PROPERTY_TYPES, MANUAL_PROPERTY_TYPES } from './src/sync.ts';
      const stage = ${JSON.stringify(stage)};
      const schema = { properties: Object.fromEntries(Object.entries({ ...PROPERTY_TYPES, ...MANUAL_PROPERTY_TYPES, ...AI_PROPERTY_TYPES }).map(([key, type]) => [key, { type }])) };
      let writes = 0;
      let inference = 0;
      const fetchImpl = async (url, options) => {
        const path = new URL(url).pathname;
        if ((stage === 'stars' && path.endsWith('/starred')) || (stage === 'inference' && url.includes('api.cloudflare.com'))) {
          console.log('cancelling', stage);
          setImmediate(() => process.kill(process.pid, 'SIGINT'));
          // Deliberately emulate a transport that settles after cancellation.
          await delay(30);
        }
        let body;
        if (url.includes('api.cloudflare.com')) {
          inference++;
          body = { success: true, result: { response: '開発を支援するツールです。' } };
        } else if (path.endsWith('/readme')) return new Response('# Tool');
        else if (path.endsWith('/starred')) body = [{ starred_at: '2026-10-01T00:00:00Z', repo: { id: 1, private: false, full_name: 'owner/repo', html_url: 'https://github.com/owner/repo', description: null } }];
        else if (path.endsWith('/query')) body = { results: [], has_more: false };
        else if (options.method === 'POST' || options.method === 'PATCH') {
          writes++;
          console.log('notion-write', writes);
          body = { id: 'page-1', properties: JSON.parse(options.body).properties };
        } else body = schema;
        return new Response(JSON.stringify(body));
      };
      const env = { GITHUB_TOKEN: 'test', NOTION_TOKEN: 'test', NOTION_DATA_SOURCE_ID: 'a'.repeat(32), GITHUB_REPOSITORY_OWNER: 'example', CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'test', GITHUB_STEP_SUMMARY: '/unused' };
      const sleep = async () => {};
      const code = await runCli([], env, {
        runSync: (config, options) => sync(config, {
          ...options,
          github: new ApiClient('GitHub', 'test', { fetchImpl, sleep }),
          notion: new ApiClient('Notion', 'test', { fetchImpl, sleep }),
          aiDeps: { fetchImpl, sleep },
        }),
        append: async () => console.log('summary-appended'),
      });
      await delay(60);
      console.log(JSON.stringify({ code, writes, inference }));
      process.exitCode = code;
    `,
      ],
      { encoding: 'utf8', timeout: 5000, env: {} },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 130, child.stderr);
    assert.doesNotMatch(
      child.stdout,
      /summary-appended|Basic sync completed|AI processing completed/,
    );
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.deepEqual(result, {
      code: 130,
      writes: stage === 'stars' ? 0 : 1,
      inference: stage === 'stars' ? 0 : 1,
    });
  }
});

test('cancellation during ambiguous-create reconciliation propagates without another query or POST', async () => {
  const controller = new AbortController();
  let queries = 0;
  let creates = 0;
  const notion = {
    async request(path) {
      if (path === '/pages') {
        creates++;
        throw new ApiError('Notion', undefined, true);
      }
      if (path.endsWith('/query')) {
        queries++;
        return { results: [], has_more: false };
      }
      return schema;
    },
    async sleep() {
      controller.abort();
    },
  };
  const github = {
    request: async () => [{ repo, starred_at: '2026-10-01T00:00:00Z' }],
  };
  await assert.rejects(
    sync(readConfig(env), { notion, github, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(creates, 1);
  assert.equal(queries, 1);
});

test('AI cancellation stops the remaining items without counting an item failure', async () => {
  const controller = new AbortController();
  const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
  let readmes = 0;
  let generations = 0;
  let saves = 0;
  const stars = new Map(
    ['1', '2'].map((id) => [id, { repo, starredAt: '2026-10-01T00:00:00Z' }]),
  );
  await assert.rejects(
    syncSummaries(ai, {
      schema,
      stats,
      stars,
      existing: new Map(['1', '2'].map((id) => [id, { id, properties: {} }])),
      signal: controller.signal,
      github: {
        request: async () => {
          readmes++;
          return '# Tool';
        },
      },
      notion: {
        request: async () => {
          saves++;
        },
      },
      fetchImpl: async () => {
        generations++;
        controller.abort();
        return new Response(
          JSON.stringify({
            success: true,
            result: { response: '開発用ツールです。' },
          }),
        );
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(readmes, 1);
  assert.equal(generations, 1);
  assert.equal(saves, 0);
  assert.equal(stats.ai_failed, 0);
});
