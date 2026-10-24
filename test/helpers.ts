import assert from 'node:assert/strict';
import type {
  ApiClientLike,
  NotionPage,
  NotionProperty,
  Repository,
  RichText,
} from '../src/types.ts';

export interface FixtureOption {
  name: string;
  id?: string;
  color?: string;
}

type TextProperty = NotionProperty & { rich_text: RichText[] };

// HTTP fixtures retain Notion's extra wire fields and the known generated columns.
export interface FixtureProperties
  extends Record<
    string,
    NotionProperty & { select?: FixtureOption; multi_select?: FixtureOption[] }
  > {
  Name: NotionProperty & { title: RichText[] };
  Description: TextProperty;
  'Repository ID': TextProperty;
  'Starred At': NotionProperty & { date: { start: string } };
  'GitHub Topics': NotionProperty & { multi_select: FixtureOption[] };
  'AI Summary': TextProperty;
  'AI Model': TextProperty;
  'AI Input Hash': TextProperty;
  'AI Prompt Version': TextProperty;
  'AI Generated At': NotionProperty & { date: { start: string } };
}

export interface FixturePage extends NotionPage {
  properties: FixtureProperties;
  children?: unknown[];
}

export interface FixtureStar {
  starred_at: string;
  repo: Repository;
}

export interface RequestBody {
  properties: FixtureProperties;
  parent?: { type: string; data_source_id: string };
  filter?: { rich_text: { equals: string } };
  start_cursor?: string;
}

// The fake transport is the boundary that supplies a requested response type.
export function mockClient(
  request: (path: string) => unknown | Promise<unknown>,
  sleep: () => Promise<void> = async () => {},
): ApiClientLike {
  return {
    request: async <T>(path: string) => (await request(path)) as T,
    sleep,
  };
}

export function textContent(text: RichText): string {
  assert.ok(text.text);
  return text.text.content;
}
