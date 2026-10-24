import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { main } from '../src/cli.ts';
import {
  ApiClient,
  ApiError,
  MANUAL_PROPERTY_TYPES,
  NOTION_VERSION,
  PROPERTY_TYPES,
  propertiesFor,
  readConfig,
  sync,
} from '../src/sync.ts';
import type { NotionSchema, Repository } from '../src/types.ts';
import {
  type FixtureOption,
  type FixturePage,
  type FixtureProperties,
  type FixtureStar,
  type RequestBody,
  textContent,
} from './helpers.ts';

interface MockCall {
  url: URL;
  method: string | undefined;
  body: RequestBody;
  headers: Record<string, string>;
}
interface FixtureSchema extends NotionSchema {
  properties: NotionSchema['properties'] & {
    'GitHub Topics': {
      type: string;
      multi_select: { options: FixtureOption[] };
    };
  };
}
interface FixtureState {
  stars: FixtureStar[];
  pages: FixturePage[];
  calls: MockCall[];
  waits: number[];
  schema: FixtureSchema;
}
interface FixtureOptions {
  stars?: FixtureStar[];
  pages?: FixturePage[];
  pageSize?: number;
  schema?: Record<string, string | undefined>;
  topicOptions?: FixtureOption[];
  intercept?: (
    call: MockCall,
    state: FixtureState,
  ) => Response | undefined | Promise<Response | undefined>;
}

const env = {
  GITHUB_STAR_USER: 'UtakataKyosui',
  GITHUB_TOKEN: 'test-github-secret',
  NOTION_DATA_SOURCE_ID: '01234567-89ab-cdef-0123-456789abcdef',
  NOTION_TOKEN: 'test-notion-secret',
};
const config = readConfig(env);
const star = (
  id: number,
  overrides: Record<string, unknown> = {},
): FixtureStar => ({
  starred_at: '2026-10-01T00:00:00Z',
  repo: {
    id,
    full_name: `owner/repo-${id}`,
    html_url: `https://github.com/owner/repo-${id}`,
    description: 'A useful repository',
    private: false,
    ...overrides,
  } as Repository,
});
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const pageFor = (row: FixtureStar): FixturePage => ({
  id: `page-${row.repo.id}`,
  properties: propertiesFor(String(row.repo.id), {
    repo: row.repo,
    starredAt: row.starred_at,
  }) as FixtureProperties,
});

// Exercise production HTTP adapters and synchronization together, with no network access.
function fixture({
  stars = [star(1)],
  pages = [],
  pageSize = 100,
  schema = { ...PROPERTY_TYPES, ...MANUAL_PROPERTY_TYPES },
  topicOptions = [],
  intercept,
}: FixtureOptions = {}) {
  const state: FixtureState = {
    stars,
    pages: structuredClone(pages),
    calls: [],
    waits: [],
    schema: {
      properties: Object.fromEntries(
        Object.entries(schema).map(([name, type]) => [name, { type }]),
      ),
    } as FixtureSchema,
  };
  if (state.schema.properties['GitHub Topics']) {
    state.schema.properties['GitHub Topics'].multi_select = {
      options: structuredClone(topicOptions),
    };
  }
  const savedProperties = (properties: FixtureProperties) => {
    const saved = structuredClone(properties);
    const options =
      state.schema.properties['GitHub Topics'].multi_select.options;
    saved['GitHub Topics'].multi_select = saved[
      'GitHub Topics'
    ].multi_select.map(({ name }) => {
      let option = options.find((option) => option.name === name);
      if (!option) {
        option = { id: `option-${options.length}`, name, color: 'default' };
        options.push(option);
      }
      return structuredClone(option);
    });
    return saved;
  };
  const fetchImpl: typeof fetch = async (url, options = {}) => {
    assert.ok(typeof url === 'string');
    const parsed = new URL(url);
    const body = (
      options.body ? JSON.parse(String(options.body)) : undefined
    ) as RequestBody;
    const call = {
      url: parsed,
      method: options.method,
      body,
      headers: options.headers as Record<string, string>,
    };
    state.calls.push(call);
    const override = await intercept?.(call, state);
    if (override !== undefined) return override;
    if (parsed.host === 'api.github.com') {
      const offset = (Number(parsed.searchParams.get('page')) - 1) * 100;
      return json(state.stars.slice(offset, offset + 100));
    }
    if (parsed.pathname.endsWith('/query')) {
      const selected = body.filter
        ? state.pages.filter(
            (page) =>
              page.properties['Repository ID'].rich_text
                .map(textContent)
                .join('') === body.filter?.rich_text.equals,
          )
        : state.pages;
      const offset = Number(body.start_cursor ?? 0);
      const results = selected.slice(offset, offset + pageSize);
      return json({
        results,
        has_more: offset + pageSize < selected.length,
        next_cursor: String(offset + pageSize),
      });
    }
    if (parsed.pathname.startsWith('/v1/data_sources/')) {
      return json(state.schema);
    }
    if (parsed.pathname === '/v1/pages') {
      const page = {
        id: `new-page-${state.pages.length}`,
        properties: savedProperties(body.properties),
      };
      state.pages.push(page);
      return json(page);
    }
    if (options.method === 'PATCH') {
      const page = state.pages.find(
        (p) => parsed.pathname === `/v1/pages/${p.id}`,
      );
      assert.ok(page, 'page to update exists');
      Object.assign(page.properties, savedProperties(body.properties));
      return json(page);
    }
    throw new Error('Unexpected mock request');
  };
  const deps = {
    fetchImpl,
    sleep: async (ms: number) => {
      state.waits.push(ms);
    },
  };
  const github = new ApiClient('GitHub', env.GITHUB_TOKEN, deps);
  const notion = new ApiClient('Notion', env.NOTION_TOKEN, deps);
  const writes = () =>
    state.calls.filter(
      (c) => c.method === 'PATCH' || c.url.pathname === '/v1/pages',
    );
  return { ...state, github, notion, writes };
}

test('initial sync creates rows; rerun skips without creating duplicates', async () => {
  const f = fixture({ stars: [star(1), star(2)] });
  assert.deepEqual(await sync(config, f), {
    created: 2,
    updated: 0,
    skipped: 0,
    failed: 0,
  });
  assert.deepEqual(await sync(config, f), {
    created: 0,
    updated: 0,
    skipped: 2,
    failed: 0,
  });
  assert.equal(f.pages.length, 2);
  const creation = f.writes()[0];
  assert.deepEqual(creation.body.parent, {
    type: 'data_source_id',
    data_source_id: config.dataSourceId,
  });
  assert.equal(creation.headers['Notion-Version'], NOTION_VERSION);
  const github = f.calls.find((c) => c.url.host === 'api.github.com');
  assert.ok(github);
  assert.equal(github.url.pathname, '/users/UtakataKyosui/starred');
  assert.equal(github.headers.Accept, 'application/vnd.github.star+json');
});

test('topics are normalized and deduplicated across repositories and reruns', async () => {
  const f = fixture({
    stars: [
      star(1, {
        topics: [
          ' JavaScript ',
          'javascript',
          'ＪａｖａＳｃｒｉｐｔ',
          '',
          '  ',
          'node-js',
        ],
      }),
      star(2, { topics: ['node-js', 'JAVASCRIPT'] }),
    ],
  });
  assert.equal((await sync(config, f)).created, 2);
  assert.deepEqual(
    f.pages[0].properties['GitHub Topics'].multi_select.map((x) => x.name),
    ['javascript', 'node-js'],
  );
  assert.equal(
    f.schema.properties['GitHub Topics'].multi_select.options.length,
    2,
  );
  assert.equal((await sync(config, f)).skipped, 2);
  assert.equal(
    f.schema.properties['GitHub Topics'].multi_select.options.length,
    2,
  );
  assert.equal(f.pages.length, 2);
  assert.equal(f.writes().length, 2);
});

test('existing option spelling is reused and option order, IDs and colors do not trigger updates', async () => {
  const old = pageFor(star(1, { topics: ['javascript', 'node-js'] }));
  old.properties['GitHub Topics'].multi_select = [
    { id: 'node', name: 'node-js', color: 'blue' },
    { id: 'js', name: 'JavaScript', color: 'red' },
  ];
  const f = fixture({
    pages: [old],
    stars: [
      star(1, { topics: ['JAVASCRIPT', 'node-js'] }),
      star(2, { topics: ['javascript'] }),
    ],
    topicOptions: old.properties['GitHub Topics'].multi_select,
  });
  assert.deepEqual(await sync(config, f), {
    created: 1,
    updated: 0,
    skipped: 1,
    failed: 0,
  });
  assert.equal(
    f.schema.properties['GitHub Topics'].multi_select.options.length,
    2,
  );
  assert.equal(f.pages[1].properties['GitHub Topics'].multi_select[0].id, 'js');
});

test('topic additions, removals and clearing preserve manual Tags, Category and page body', async () => {
  const old = pageFor(star(1, { topics: ['old-topic', 'retained'] }));
  old.properties.Tags = {
    multi_select: [{ id: 'manual', name: 'Favorite', color: 'red' }],
  };
  old.properties.Category = {
    select: { id: 'category', name: 'Development', color: 'blue' },
  };
  old.children = [{ paragraph: 'manual notes' }];
  const f = fixture({
    pages: [old],
    stars: [star(1, { topics: ['new-topic', 'retained'] })],
  });
  for (const topics of [['new-topic', 'retained'], []]) {
    f.stars[0].repo.topics = topics;
    assert.equal((await sync(config, f)).updated, 1);
    assert.deepEqual(
      f.pages[0].properties['GitHub Topics'].multi_select.map((x) => x.name),
      topics,
    );
    assert.deepEqual(f.pages[0].properties.Tags, old.properties.Tags);
    assert.deepEqual(f.pages[0].properties.Category, old.properties.Category);
    assert.deepEqual(f.pages[0].children, old.children);
    assert.equal((await sync(config, f)).skipped, 1);
  }
  for (const call of f.writes()) {
    assert.ok(!('Tags' in call.body.properties));
    assert.ok(!('Category' in call.body.properties));
  }
});

test('repositories with empty or omitted topics sync and old pages are backfilled in place', async () => {
  const old = pageFor(star(1));
  Reflect.deleteProperty(old.properties, 'GitHub Topics');
  const f = fixture({
    stars: [star(1), star(2, { topics: [] })],
    pages: [old],
  });
  assert.deepEqual(await sync(config, f), {
    created: 1,
    updated: 1,
    skipped: 0,
    failed: 0,
  });
  assert.equal(f.pages[0].id, old.id);
  for (const page of f.pages)
    assert.deepEqual(page.properties['GitHub Topics'], { multi_select: [] });
  assert.equal((await sync(config, f)).skipped, 2);
});

test('topic name and selection limits accept boundaries after normalization and deduplication', async () => {
  const topics = Array.from({ length: 99 }, (_, i) => `topic-${i}`);
  topics.push('😀'.repeat(50));
  const f = fixture({ stars: [star(1, { topics: [...topics, ...topics] })] });
  assert.equal((await sync(config, f)).created, 1);
  assert.equal(f.pages[0].properties['GitHub Topics'].multi_select.length, 100);
});

test('invalid topics fail before any writes, without silently dropping or truncating data', async (t) => {
  for (const topics of [
    null,
    'javascript',
    [123],
    ['a,b'],
    ['a\nb'],
    ['a'.repeat(101)],
    ['😀'.repeat(51)],
    ['ａ，ｂ'],
    Array.from({ length: 101 }, (_, i) => `topic-${i}`),
  ]) {
    await t.test(JSON.stringify(topics).slice(0, 60), async () => {
      const f = fixture({ stars: [star(1), star(2, { topics })] });
      await assert.rejects(sync(config, f), /topic/);
      assert.equal(f.writes().length, 0);
    });
  }
});

test('classification properties must exist with correct types before any write', async (t) => {
  for (const name of ['GitHub Topics', 'Tags', 'Category']) {
    for (const type of [undefined, 'rich_text']) {
      await t.test(`${name}: ${type ?? 'missing'}`, async () => {
        const schema: Record<string, string | undefined> = {
          ...PROPERTY_TYPES,
          ...MANUAL_PROPERTY_TYPES,
          [name]: type,
        };
        if (!type) delete schema[name];
        const f = fixture({ schema });
        await assert.rejects(sync(config, f), /Notion schema/);
        assert.equal(f.writes().length, 0);
      });
    }
  }
});

test('ambiguous normalized schema options stop before writes', async () => {
  const f = fixture({
    topicOptions: [{ name: 'JavaScript' }, { name: 'javascript' }],
  });
  await assert.rejects(sync(config, f), /duplicate normalized option names/);
  assert.equal(f.writes().length, 0);
});

test('rename, transfer, description and star date changes update the same page, preserving manual fields', async () => {
  const old = pageFor(star(1));
  old.properties.Notes = { rich_text: [{ text: { content: 'keep me' } }] };
  old.properties.Tags = { multi_select: [{ name: 'favorite' }] };
  old.children = [{ paragraph: 'manual body' }];
  const f = fixture({
    pages: [old],
    stars: [
      {
        ...star(1, {
          full_name: 'new-owner/new-name',
          description: null,
          html_url: 'https://github.com/new-owner/new-name',
        }),
        starred_at: '2026-10-02T00:00:00Z',
      },
    ],
  });
  assert.equal((await sync(config, f)).updated, 1);
  assert.equal(f.pages[0].id, old.id);
  assert.deepEqual(f.pages[0].properties.Notes, old.properties.Notes);
  assert.deepEqual(f.pages[0].properties.Tags, old.properties.Tags);
  assert.deepEqual(f.pages[0].children, old.children);
  assert.deepEqual(f.pages[0].properties.Description.rich_text, []);
  assert.deepEqual(
    Object.keys(f.writes()[0].body.properties),
    Object.keys(PROPERTY_TYPES),
  );
});

test('Notion plain_text and equivalent ISO dates do not cause unnecessary updates', async () => {
  const page = pageFor(star(1));
  for (const name of ['Name', 'Description', 'Repository ID'] as const) {
    const property = page.properties[name];
    const plain = (text: import('../src/types.ts').RichText) => ({
      plain_text: textContent(text),
    });
    if (property.title) property.title = property.title.map(plain);
    if (property.rich_text) property.rich_text = property.rich_text.map(plain);
  }
  page.properties['Starred At'].date.start = '2026-10-01T00:00:00.000+00:00';
  const f = fixture({ pages: [page] });
  assert.equal((await sync(config, f)).skipped, 1);
  assert.equal(f.writes().length, 0);
});

test('zero stars and unstarred repositories never delete Notion pages', async () => {
  const f = fixture({ stars: [], pages: [pageFor(star(1))] });
  assert.deepEqual(await sync(config, f), {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  });
  assert.equal(f.pages.length, 1);
  assert.equal(f.writes().length, 0);
});

test('GitHub and Notion pagination include all rows; repeated input IDs are deduplicated', async () => {
  const stars = Array.from({ length: 101 }, (_, i) => star(i + 1));
  stars.push(star(1));
  const f = fixture({
    stars,
    pages: stars.slice(0, 100).map(pageFor),
    pageSize: 33,
  });
  assert.deepEqual(await sync(config, f), {
    created: 1,
    updated: 0,
    skipped: 100,
    failed: 0,
  });
  assert.equal(f.pages.length, 101);
  assert.equal(
    f.calls.filter((c) => c.url.host === 'api.github.com').length,
    2,
  );
  assert.equal(
    f.calls.filter((c) => c.url.pathname.endsWith('/query')).length,
    4,
  );
});

test('private repositories are excluded even if provided by GitHub', async () => {
  const f = fixture({ stars: [star(1, { private: true })] });
  await sync(config, f);
  assert.equal(f.writes().length, 0);
});

test('invalid schema, malformed source rows and existing duplicate IDs fail before any write', async (t) => {
  for (const options of [
    { schema: { ...PROPERTY_TYPES, 'Repository ID': 'number' } },
    { stars: [star(1), star(2, { id: '2' })] },
    { pages: [pageFor(star(2)), { ...pageFor(star(2)), id: 'another-page' }] },
  ]) {
    await t.test(JSON.stringify(Object.keys(options)), async () => {
      const f = fixture(options);
      await assert.rejects(sync(config, f));
      assert.equal(f.writes().length, 0);
    });
  }
});

test('manually created rows without a Repository ID are preserved', async () => {
  const manual = pageFor(star(2));
  manual.properties['Repository ID'].rich_text = [];
  const f = fixture({ pages: [manual] });
  await sync(config, f);
  assert.equal(f.pages.length, 2);
  assert.deepEqual(f.pages[0], manual);
});

test('a partial failure can be rerun without duplicating completed work', async () => {
  let fail = true;
  const f = fixture({
    stars: [star(1), star(2)],
    intercept(call) {
      if (
        fail &&
        call.url.pathname === '/v1/pages' &&
        textContent(call.body.properties['Repository ID'].rich_text[0]) === '2'
      )
        return json({}, 400);
    },
  });
  const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
  await assert.rejects(sync(config, { ...f, stats }), /HTTP 400/);
  assert.equal(stats.created, 1);
  fail = false;
  assert.deepEqual(await sync(config, f), {
    created: 1,
    updated: 0,
    skipped: 1,
    failed: 0,
  });
  assert.equal(f.pages.length, 2);
});

test('lost successful create response is reconciled without a second POST', async () => {
  const f = fixture({
    intercept(call, state) {
      if (call.url.pathname === '/v1/pages') {
        state.pages.push({
          id: 'saved-before-timeout',
          properties: call.body.properties,
        });
        throw new Error('Network timeout with secret content');
      }
    },
  });
  assert.equal((await sync(config, f)).created, 1);
  assert.equal(f.writes().length, 1);
  assert.equal(f.pages.length, 1);
});

test('ambiguous topic creates reconcile existing selections and preserve concurrent manual edits', async (t) => {
  for (const topics of [['typescript', 'node-js'], ['stale-topic']]) {
    await t.test(topics.join(', '), async () => {
      const saved = pageFor(star(1, { topics }));
      saved.properties['GitHub Topics'].multi_select.reverse();
      saved.properties.Tags = { multi_select: [{ name: 'Keep This' }] };
      saved.properties.Category = { select: { name: 'Tools' } };
      const f = fixture({
        stars: [star(1, { topics: ['typescript', 'node-js'] })],
        intercept(call, state) {
          if (call.url.pathname === '/v1/pages') {
            state.pages.push(structuredClone(saved));
            throw new Error('Response lost after creation');
          }
        },
      });
      assert.equal((await sync(config, f)).created, 1);
      assert.equal(
        f.calls.filter((c) => c.url.pathname === '/v1/pages').length,
        1,
      );
      assert.equal(
        f.calls.filter((c) => c.method === 'PATCH').length,
        topics.includes('stale-topic') ? 1 : 0,
      );
      assert.equal(f.pages.length, 1);
      assert.deepEqual(f.pages[0].properties.Tags, saved.properties.Tags);
      assert.deepEqual(
        f.pages[0].properties.Category,
        saved.properties.Category,
      );
      assert.deepEqual(
        f.pages[0].properties['GitHub Topics'].multi_select
          .map((x) => x.name)
          .sort(),
        ['node-js', 'typescript'],
      );
    });
  }
});

test('ambiguous create with delayed visibility is checked again, never recreated', async () => {
  let saved: FixturePage | undefined;
  let checks = 0;
  const f = fixture({
    intercept(call, state) {
      if (call.url.pathname === '/v1/pages') {
        saved = { id: 'eventually-visible', properties: call.body.properties };
        return json({}, 503);
      }
      if (call.body?.filter && ++checks === 2) {
        assert.ok(saved);
        state.pages.push(saved);
      }
    },
  });
  await sync(config, f);
  assert.equal(checks, 2);
  assert.equal(f.writes().length, 1);
});

test('unresolved create stops; unknown outcome is not treated as success', async () => {
  const f = fixture({
    intercept(call) {
      if (call.url.pathname === '/v1/pages') return json({}, 503);
    },
  });
  await assert.rejects(sync(config, f), /outcome is unknown/);
  assert.equal(f.writes().length, 1);
  assert.equal(f.calls.filter((c) => c.body?.filter).length, 3);
});

test('invalid successful create JSON is reconciled as an ambiguous write', async () => {
  const f = fixture({
    intercept(call, state) {
      if (call.url.pathname === '/v1/pages') {
        state.pages.push({ id: 'saved', properties: call.body.properties });
        return new Response('broken json');
      }
    },
  });
  await sync(config, f);
  assert.equal(f.writes().length, 1);
});

test('failed reconciliation retains the unknown-create recovery instruction and repository ID', async () => {
  const f = fixture({
    intercept(call) {
      if (call.url.pathname === '/v1/pages') return json({}, 503);
      if (call.body?.filter) return json({}, 401);
    },
  });
  await assert.rejects(
    sync(config, f),
    /create outcome is unknown for Repository ID 1/,
  );
  assert.equal(f.writes().length, 1);
});

test('safe reads retry 429/503 and network failure; errors and tokens stay out of messages', async () => {
  const waits: number[] = [];
  let calls = 0;
  const client = new ApiClient('Notion', 'secret', {
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async () => {
      calls++;
      if (calls === 1)
        return json({ message: 'secret' }, 429, { 'Retry-After': '2' });
      if (calls === 2) return json({}, 503);
      if (calls === 3) throw new Error('secret');
      return json({ ok: true });
    },
  });
  assert.deepEqual(
    await client.request('/data_sources/id/query', {
      method: 'POST',
      body: {},
    }),
    { ok: true },
  );
  assert.equal(calls, 4);
  assert.ok(waits.includes(2000));
  assert.ok(waits.includes(4000));
});

test('authentication errors are not retried; oversized Retry-After is respected by stopping', async (t) => {
  for (const [status, headers, expected] of [
    [401, {}, 1],
    [403, {}, 1],
    [429, { 'Retry-After': '3600' }, 1],
    [503, {}, 4],
  ] as [number, HeadersInit, number][]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const client = new ApiClient('GitHub', 'secret', {
        sleep: async () => {},
        fetchImpl: async () => {
          calls++;
          return json({ message: 'secret' }, status, headers);
        },
      });
      await assert.rejects(client.request('/users/test/starred'), (error) => {
        assert.ok(error instanceof ApiError);
        assert.ok(!error.message.includes('secret'));
        return true;
      });
      assert.equal(calls, expected);
    });
  }
});

test('GitHub primary rate limit reset is honored', async () => {
  let calls = 0;
  const waits: number[] = [];
  const client = new ApiClient('GitHub', 'secret', {
    now: () => 10_000,
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async () =>
      ++calls === 1
        ? json({}, 403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '12',
          })
        : json([]),
  });
  await client.request('/users/test/starred');
  assert.deepEqual(waits, [2000]);
});

test('text is split without losing Unicode and oversized inputs fail before writes', async () => {
  const description = '😀'.repeat(2001);
  const f = fixture({ stars: [star(1, { description })] });
  await sync(config, f);
  const chunks = f.pages[0].properties.Description.rich_text;
  assert.equal(chunks.map(textContent).join(''), description);
  assert.ok(chunks.every((x) => textContent(x).length <= 2000));
  const huge = fixture({
    stars: [star(1), star(2, { description: 'a'.repeat(180_001) })],
  });
  await assert.rejects(sync(config, huge), /limits/);
  assert.equal(huge.writes().length, 0);
});

test('invalid pagination fails before writes', async () => {
  const f = fixture({
    intercept(call) {
      if (call.url.pathname.endsWith('/query'))
        return json({ results: [], has_more: true, next_cursor: 'same' });
    },
  });
  await assert.rejects(sync(config, f), /pagination/);
  assert.equal(f.writes().length, 0);
});

test('configuration is validated without echoing invalid values', () => {
  for (const key of Object.keys(env))
    assert.throws(
      () => readConfig({ ...env, [key]: '' }),
      /Missing configuration/,
    );
  assert.throws(() => readConfig({ ...env, GITHUB_STAR_USER: 'bad/secret' }), {
    message: 'Invalid GITHUB_STAR_USER',
  });
  assert.throws(() => readConfig({ ...env, NOTION_DATA_SOURCE_ID: 'secret' }), {
    message: 'Invalid NOTION_DATA_SOURCE_ID',
  });
});

test('default user is the repository owner, while an explicit user takes priority over the owner and actor', () => {
  for (const value of [undefined, '', '   ']) {
    assert.equal(
      readConfig({
        ...env,
        GITHUB_STAR_USER: value,
        GITHUB_REPOSITORY_OWNER: 'UtakataKyosui',
        GITHUB_ACTOR: 'another-user',
      }).user,
      'UtakataKyosui',
    );
  }
  assert.equal(
    readConfig({
      ...env,
      GITHUB_STAR_USER: ' octocat ',
      GITHUB_REPOSITORY_OWNER: 'UtakataKyosui',
    }).user,
    'octocat',
  );
  assert.throws(
    () =>
      readConfig({
        ...env,
        GITHUB_STAR_USER: undefined,
        GITHUB_ACTOR: 'another-user',
      }),
    /Missing configuration/,
  );
  assert.throws(
    () =>
      readConfig({
        ...env,
        GITHUB_STAR_USER: 'bad/secret',
        GITHUB_REPOSITORY_OWNER: 'UtakataKyosui',
      }),
    /Invalid GITHUB_STAR_USER/,
  );
});

test('CLI passes the repository owner as the default synchronization user', async () => {
  let actualUser: string | undefined;
  const code = await main(
    { ...env, GITHUB_STAR_USER: '', GITHUB_REPOSITORY_OWNER: 'UtakataKyosui' },
    {
      runSync: async (config) => {
        actualUser = config.user;
      },
      write: () => {},
    },
  );
  assert.equal(code, 0);
  assert.equal(actualUser, 'UtakataKyosui');
});

test('CLI reports partial counts, returns failure, and suppresses unexpected error details', async () => {
  const logs: string[] = [];
  const reports: string[] = [];
  const code = await main(
    { ...env, GITHUB_STEP_SUMMARY: '/fake/summary' },
    {
      runSync: async (_config, { stats }) => {
        stats.created = 2;
        throw new Error('test-notion-secret');
      },
      write: (text) => logs.push(text),
      append: async (_path, text) => reports.push(text),
    },
  );
  assert.equal(code, 1);
  assert.match(reports[0], /\| created \| 2 \|/);
  assert.match(reports[0], /\| failed \| 1 \|/);
  assert.ok(!logs.join('').includes('test-notion-secret'));
  assert.equal(
    await main(env, { runSync: async () => {}, write: () => {} }),
    0,
  );
});

test('workflow serializes scheduled/manual runs, pins Actions, and keeps CI free of secrets', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/sync.yml', import.meta.url),
    'utf8',
  );
  const ci = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /cron: '17 0 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /concurrency:\n {2}group: stars-to-notion-sync\n {2}cancel-in-progress: false/,
  );
  assert.doesNotMatch(workflow, /^ {2}(push|pull_request):/m);
  for (const yaml of [workflow, ci]) {
    for (const line of yaml.matchAll(/uses: (\S+)/g))
      assert.match(line[1], /^actions\/[\w-]+@[a-f\d]{40}$/);
    assert.match(yaml, /contents: read/);
    assert.match(yaml, /timeout-minutes:/);
  }
  assert.doesNotMatch(ci, /secrets\.|npm run sync/);
  assert.match(ci, /pull_request:/);
  assert.match(ci, /npm test/);
});
