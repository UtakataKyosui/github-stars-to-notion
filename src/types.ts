export type Environment = Readonly<Record<string, string | undefined>>;

export interface AiConfig {
  invalid?: false;
  accountId: string;
  token: string;
  model: string;
  maxItems: number;
  force: boolean;
}

export type AiSettings = AiConfig | { invalid: true };

export interface SyncConfig {
  user: string;
  dataSourceId: string;
  githubToken: string;
  notionToken: string;
  ai?: AiSettings;
}

export interface SyncStats {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  ai_generated?: number;
  ai_skipped?: number;
  ai_failed?: number;
  ai_deferred?: number;
  [counter: string]: number | undefined;
}

export interface Repository {
  id: number;
  private: boolean;
  full_name: string;
  html_url: string;
  description: string | null;
  topics?: string[];
}

export interface Star {
  repo: Repository;
  starredAt: string;
}

export interface RichText {
  type?: string;
  plain_text?: string;
  text?: { content: string };
}

export interface NotionProperty {
  type?: string;
  title?: RichText[];
  rich_text?: RichText[];
  url?: string | null;
  date?: { start: string; end?: string | null } | null;
  multi_select?: { name: string }[];
}

export interface NotionPage {
  id: string;
  archived?: boolean;
  in_trash?: boolean;
  properties: Record<string, NotionProperty>;
}

export interface NotionSchema {
  properties: Record<
    string,
    {
      type: string;
      multi_select?: { options: { name: string }[] };
    }
  >;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  retrySafe?: boolean;
  readme?: boolean;
  signal?: AbortSignal;
}

export interface ApiDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
  signal?: AbortSignal;
}

export interface ApiClientLike {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<unknown>;
}

export interface SummaryDependencies extends ApiDependencies {
  github: ApiClientLike;
  notion: ApiClientLike;
  schema: NotionSchema;
  stars: Map<string, Star>;
  existing: Map<string, NotionPage>;
  stats: SyncStats;
}

export interface SyncDependencies {
  github?: ApiClientLike;
  notion?: ApiClientLike;
  aiDeps?: ApiDependencies;
  stats?: SyncStats;
  signal?: AbortSignal;
}
