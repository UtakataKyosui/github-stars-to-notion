import { setTimeout as delay } from 'node:timers/promises';

export const NOTION_VERSION = '2025-09-03';
export const PROPERTY_TYPES = {
  Name: 'title',
  'Repository ID': 'rich_text',
  URL: 'url',
  Description: 'rich_text',
  'Starred At': 'date',
};

export class SyncError extends Error {}

export class ApiError extends SyncError {
  constructor(service, status, ambiguous = false) {
    // Never include response bodies, request URLs, tokens, or upstream messages.
    super(`${service}: ${status ? `HTTP ${status}` : 'network or invalid JSON response'}`);
    this.ambiguous = ambiguous;
  }
}

export function readConfig(env) {
  const required = ['GITHUB_TOKEN', 'NOTION_DATA_SOURCE_ID', 'NOTION_TOKEN'];
  for (const key of required) {
    if (!env[key]?.trim()) throw new SyncError(`Missing configuration: ${key}`);
  }
  const user = env.GITHUB_STAR_USER?.trim() || env.GITHUB_REPOSITORY_OWNER?.trim();
  if (!user) throw new SyncError('Missing configuration: GITHUB_STAR_USER or GITHUB_REPOSITORY_OWNER');
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(user)) {
    throw new SyncError('Invalid GITHUB_STAR_USER');
  }
  const id = env.NOTION_DATA_SOURCE_ID.trim().replaceAll('-', '');
  if (!/^[a-f\d]{32}$/i.test(id)) throw new SyncError('Invalid NOTION_DATA_SOURCE_ID');
  for (const key of ['GITHUB_TOKEN', 'NOTION_TOKEN']) {
    if (/[\r\n]/.test(env[key].trim())) throw new SyncError(`Invalid ${key}`);
  }
  return { user, dataSourceId: id, githubToken: env.GITHUB_TOKEN.trim(), notionToken: env.NOTION_TOKEN.trim() };
}

export class ApiClient {
  constructor(service, token, { fetchImpl = fetch, sleep = delay, now = Date.now } = {}) {
    this.service = service;
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.now = now;
  }

  async request(path, { method = 'GET', body, retrySafe = true } = {}) {
    const github = this.service === 'GitHub';
    const base = github ? 'https://api.github.com' : 'https://api.notion.com/v1';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!github) await this.sleep(350);
      let response;
      let data;
      try {
        response = await this.fetch(base + path, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            ...(github
              ? { Accept: 'application/vnd.github.star+json', 'X-GitHub-Api-Version': '2026-03-10' }
              : { 'Notion-Version': NOTION_VERSION }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.ok) data = await response.json();
      } catch {
        if (retrySafe && attempt < 3) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ApiError(this.service, undefined, !retrySafe);
      }
      if (response.ok) return data;
      const status = response.status;
      const retryAfter = response.headers.get('retry-after');
      const rateLimited = status === 429 || (github && status === 403
        && (retryAfter !== null || response.headers.get('x-ratelimit-remaining') === '0'));
      const transient = rateLimited || status >= 500;
      if (retrySafe && transient && attempt < 3) {
        const reset = response.headers.get('x-ratelimit-reset');
        let wait = 1000 * 2 ** attempt;
        if (retryAfter !== null) {
          wait = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - this.now();
        } else if (rateLimited && reset !== null) {
          wait = Number(reset) * 1000 - this.now();
        }
        // Do not retry earlier than the server allows or occupy a runner indefinitely.
        if (Number.isFinite(wait) && wait <= 120_000) {
          await this.sleep(Math.max(wait, 1000 * 2 ** attempt));
          continue;
        }
      }
      throw new ApiError(this.service, status, !retrySafe && status >= 500);
    }
  }
}

function invalid(message) {
  throw new SyncError(message);
}

export async function listStars(client, user) {
  const stars = new Map();
  for (let page = 1; ; page++) {
    const rows = await client.request(`/users/${encodeURIComponent(user)}/starred?per_page=100&page=${page}&sort=created&direction=asc`);
    if (!Array.isArray(rows)) invalid('Invalid GitHub Star list');
    for (const row of rows) {
      const repo = row.repo;
      if (!repo || !Number.isSafeInteger(repo.id) || repo.id <= 0 || typeof repo.private !== 'boolean'
        || typeof repo.full_name !== 'string' || !repo.full_name
        || typeof repo.html_url !== 'string' || !/^https:\/\/github\.com\//.test(repo.html_url)
        || (repo.description !== null && typeof repo.description !== 'string')
        || typeof row.starred_at !== 'string' || !Number.isFinite(Date.parse(row.starred_at))) invalid('Invalid GitHub Star entry');
      if (repo.private) continue;
      stars.set(String(repo.id), { repo, starredAt: row.starred_at });
    }
    if (rows.length < 100) return stars;
  }
}

export async function validateSchema(notion, dataSourceId) {
  const schema = await notion.request(`/data_sources/${dataSourceId}`);
  for (const [name, type] of Object.entries(PROPERTY_TYPES)) {
    if (schema?.properties?.[name]?.type !== type) invalid(`Notion schema: ${name} must be ${type}`);
  }
}

function textValue(items) {
  if (!Array.isArray(items)) invalid('Invalid Notion text property');
  return items.map(item => item.plain_text ?? item.text?.content ?? '').join('');
}

export async function queryPages(notion, dataSourceId, filter) {
  const pages = [];
  const cursors = new Set();
  let cursor;
  do {
    const result = await notion.request(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: { page_size: 100, ...(filter && { filter }), ...(cursor && { start_cursor: cursor }) },
    });
    if (!Array.isArray(result?.results) || typeof result.has_more !== 'boolean') invalid('Invalid Notion query response');
    for (const page of result.results) {
      if (typeof page.id !== 'string' || !page.properties || page.archived || page.in_trash) invalid('Invalid Notion page');
      pages.push(page);
    }
    if (!result.has_more) break;
    cursor = result.next_cursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) invalid('Invalid Notion pagination cursor');
    cursors.add(cursor);
  } while (true);
  return pages;
}

function indexPages(pages) {
  const index = new Map();
  for (const page of pages) {
    const id = textValue(page.properties['Repository ID']?.rich_text);
    if (!id) continue; // Allow manually created rows without a repository association.
    if (!/^[1-9]\d*$/.test(id)) invalid('Notion contains an invalid Repository ID');
    if (index.has(id)) invalid(`Notion contains duplicate Repository ID ${id}; resolve duplicates before retrying`);
    index.set(id, page);
  }
  return index;
}

function richText(value) {
  const chunks = [];
  let chunk = '';
  // Respect the 2,000 UTF-16-unit limit without splitting surrogate pairs.
  for (const char of value) {
    if (chunk.length + char.length > 1800) {
      chunks.push({ type: 'text', text: { content: chunk } });
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) chunks.push({ type: 'text', text: { content: chunk } });
  if (chunks.length > 100) invalid('GitHub text exceeds Notion property limits');
  return chunks;
}

export function propertiesFor(id, { repo, starredAt }) {
  return {
    Name: { title: richText(repo.full_name) },
    'Repository ID': { rich_text: richText(id) },
    URL: { url: repo.html_url },
    Description: { rich_text: richText(repo.description ?? '') },
    'Starred At': { date: { start: starredAt } },
  };
}

function matches(page, properties) {
  return Object.entries(PROPERTY_TYPES).every(([name, type]) => {
    const current = page.properties[name];
    const wanted = properties[name];
    if (!current) return false;
    if (type === 'date') return current.date?.end == null
      && Date.parse(current.date?.start) === Date.parse(wanted.date.start);
    if (type === 'url') return current.url === wanted.url;
    return textValue(current[type]) === textValue(wanted[type]);
  });
}

async function createPage(notion, dataSourceId, id, properties) {
  try {
    const page = await notion.request('/pages', {
      method: 'POST', retrySafe: false,
      body: { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties },
    });
    if (typeof page?.id !== 'string') throw new ApiError('Notion', undefined, true);
  } catch (error) {
    if (!(error instanceof ApiError) || !error.ambiguous) throw error;
    // A lost response can mean the POST succeeded. Never send another create here.
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await notion.sleep(1000 * 2 ** attempt);
        const pages = await queryPages(notion, dataSourceId, {
          property: 'Repository ID', rich_text: { equals: id },
        });
        const found = indexPages(pages).get(id);
        if (found) {
          if (!matches(found, properties)) {
            await notion.request(`/pages/${encodeURIComponent(found.id)}`, { method: 'PATCH', body: { properties } });
          }
          return;
        }
      }
    } catch {
      // A failed reconciliation is still an unknown create, not an ordinary read failure.
    }
    throw new SyncError(`Notion create outcome is unknown for Repository ID ${id}; check Notion and the recovery guide before rerunning`);
  }
}

export async function sync(config, { github, notion, stats = { created: 0, updated: 0, skipped: 0, failed: 0 } } = {}) {
  github ??= new ApiClient('GitHub', config.githubToken);
  notion ??= new ApiClient('Notion', config.notionToken);
  await validateSchema(notion, config.dataSourceId);
  const stars = await listStars(github, config.user);
  const existing = indexPages(await queryPages(notion, config.dataSourceId));
  // Validate/encode every input before the first write, including text limits.
  const desired = [...stars].map(([id, star]) => [id, propertiesFor(id, star)]);
  for (const [id, properties] of desired) {
    const page = existing.get(id);
    if (page && matches(page, properties)) {
      stats.skipped++;
    } else if (page) {
      await notion.request(`/pages/${encodeURIComponent(page.id)}`, { method: 'PATCH', body: { properties } });
      stats.updated++;
    } else {
      await createPage(notion, config.dataSourceId, id, properties);
      stats.created++;
    }
  }
  return stats;
}
