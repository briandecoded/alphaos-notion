// A small Notion REST client (API version 2025-09-03) plus the shape
// normalizers the plugin's RPC, CLI, mention provider, and agent tools share.
// Only `fetch` is used, so the same code runs in the bb server and in tests
// with a stubbed fetch.
import { blocksToMarkdown, notionUrl, richTextToMarkdown, type NotionBlock, type NotionRichText } from "./markdown";

export const NOTION_VERSION = "2025-09-03";
const API = "https://api.notion.com/v1";

export type NotionIcon = { kind: "emoji" | "url"; value: string } | null;
export type NotionKind = "page" | "database";

export interface NotionSummary {
  id: string;
  kind: NotionKind;
  title: string;
  icon: NotionIcon;
  url: string;
  lastEditedAt: string | null;
  /** Title of the containing page/database when Notion tells us; else null. */
  parentTitle: string | null;
}

export interface NotionCell {
  name: string;
  type: string;
  /** Plain display text; "" when empty. */
  text: string;
  /** Multi-value properties (multi_select, people, relation, files). */
  values: string[];
  /** Checkbox state; null for other property types. */
  checked: boolean | null;
  /** Single URL when the value is link-like (url, email, files). */
  href: string | null;
}

export interface NotionPageDetail extends NotionSummary {
  kind: "page";
  parent: { type: string; id: string | null };
  properties: NotionCell[];
  markdown: string;
  /** True when the block fetch hit its cap and content is incomplete. */
  truncated: boolean;
}

export interface NotionDatabaseColumn {
  name: string;
  type: string;
}

export interface NotionDatabaseRow {
  id: string;
  title: string;
  icon: NotionIcon;
  url: string;
  lastEditedAt: string | null;
  cells: NotionCell[];
}

export interface NotionDatabaseDetail extends NotionSummary {
  kind: "database";
  description: string;
  dataSourceId: string | null;
  columns: NotionDatabaseColumn[];
  rows: NotionDatabaseRow[];
  hasMore: boolean;
}

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

type Json = Record<string, unknown>;

/** Accepts a dashed/undashed UUID or any notion.so / app.notion.com / notion.site URL. */
export function normalizeNotionId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const dashed = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (dashed.test(trimmed)) return trimmed.toLowerCase();
  const bare = /^[0-9a-f]{32}$/i;
  const toDashed = (hex: string) =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
  if (bare.test(trimmed)) return toDashed(trimmed);
  let path = trimmed;
  try {
    const url = new URL(trimmed);
    // ?p=<id> (peek links) and ?v= view ids; the page id is the last 32 hex of the path or of `p`.
    const peek = url.searchParams.get("p");
    if (peek && bare.test(peek)) return toDashed(peek);
    path = url.pathname;
  } catch {
    // not a URL; fall through to a loose scan
  }
  const matches = path.match(/[0-9a-f]{32}/gi);
  if (matches && matches.length > 0) return toDashed(matches[matches.length - 1]!);
  const dashedInPath = path.match(dashed.source.replace(/\^|\$/g, ""));
  if (dashedInPath) return dashedInPath[0].toLowerCase();
  return null;
}

export function iconOf(value: unknown): NotionIcon {
  if (!value || typeof value !== "object") return null;
  const icon = value as Json;
  if (icon.type === "emoji" && typeof icon.emoji === "string") return { kind: "emoji", value: icon.emoji };
  const inner = (icon.external ?? icon.file ?? icon.custom_emoji) as Json | undefined;
  const url = inner?.url;
  return typeof url === "string" ? { kind: "url", value: url } : null;
}

function plainRich(value: unknown): string {
  return Array.isArray(value) ? (value as NotionRichText[]).map((item) => item.plain_text ?? "").join("") : "";
}

function titleOfPage(page: Json): string {
  const properties = (page.properties ?? {}) as Record<string, Json>;
  for (const property of Object.values(properties)) {
    if (property.type === "title") return plainRich(property.title) || "Untitled";
  }
  return "Untitled";
}

function dateText(date: Json | null | undefined): string {
  if (!date || typeof date.start !== "string") return "";
  return typeof date.end === "string" && date.end ? `${date.start} → ${date.end}` : date.start;
}

function namesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const record = entry as Json;
      if (typeof record.name === "string") return record.name;
      if (typeof record.plain_text === "string") return record.plain_text;
      return "";
    })
    .filter((name) => name !== "");
}

/** Flatten one Notion property value for display and search. */
export function cellOf(name: string, property: Json): NotionCell {
  const type = typeof property.type === "string" ? property.type : "unknown";
  const cell: NotionCell = { name, type, text: "", values: [], checked: null, href: null };
  const value = property[type];
  switch (type) {
    case "title":
    case "rich_text":
      cell.text = richTextToMarkdown(value as NotionRichText[]);
      break;
    case "number":
      cell.text = typeof value === "number" ? String(value) : "";
      break;
    case "select":
    case "status":
      cell.text = value && typeof value === "object" && typeof (value as Json).name === "string" ? ((value as Json).name as string) : "";
      break;
    case "multi_select":
      cell.values = namesOf(value);
      cell.text = cell.values.join(", ");
      break;
    case "date":
      cell.text = dateText(value as Json | null);
      break;
    case "checkbox":
      cell.checked = Boolean(value);
      cell.text = cell.checked ? "Yes" : "No";
      break;
    case "url":
    case "email":
    case "phone_number":
      cell.text = typeof value === "string" ? value : "";
      cell.href = type === "email" && cell.text ? `mailto:${cell.text}` : type === "url" ? cell.text || null : null;
      break;
    case "people":
      cell.values = namesOf(value);
      cell.text = cell.values.join(", ");
      break;
    case "files": {
      const files = Array.isArray(value) ? (value as Json[]) : [];
      cell.values = files.map((file) => (typeof file.name === "string" ? file.name : "file"));
      const first = files[0];
      const inner = (first?.file ?? first?.external) as Json | undefined;
      cell.href = typeof inner?.url === "string" ? (inner.url as string) : null;
      cell.text = cell.values.join(", ");
      break;
    }
    case "relation": {
      const relations = Array.isArray(value) ? (value as Json[]) : [];
      cell.values = relations.map((relation) => (typeof relation.id === "string" ? relation.id : "")).filter(Boolean);
      cell.text = relations.length === 0 ? "" : `${relations.length} linked`;
      break;
    }
    case "rollup": {
      const rollup = (value ?? {}) as Json;
      const inner = rollup[typeof rollup.type === "string" ? rollup.type : ""];
      if (typeof inner === "number") cell.text = String(inner);
      else if (Array.isArray(inner)) cell.text = `${inner.length} items`;
      else if (inner && typeof inner === "object") cell.text = dateText(inner as Json);
      break;
    }
    case "formula": {
      const formula = (value ?? {}) as Json;
      const inner = formula[typeof formula.type === "string" ? formula.type : ""];
      if (typeof inner === "string" || typeof inner === "number") cell.text = String(inner);
      else if (typeof inner === "boolean") cell.text = inner ? "Yes" : "No";
      else if (inner && typeof inner === "object") cell.text = dateText(inner as Json);
      break;
    }
    case "created_time":
    case "last_edited_time":
      cell.text = typeof value === "string" ? value : "";
      break;
    case "created_by":
    case "last_edited_by":
      cell.text = value && typeof value === "object" && typeof (value as Json).name === "string" ? ((value as Json).name as string) : "";
      break;
    case "unique_id": {
      const unique = (value ?? {}) as Json;
      cell.text = typeof unique.number === "number" ? `${typeof unique.prefix === "string" ? `${unique.prefix}-` : ""}${unique.number}` : "";
      break;
    }
    default:
      cell.text = "";
  }
  return cell;
}

export interface NotionClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Maximum blocks fetched per page (including nested children). */
  maxBlocks?: number;
  /** Maximum nesting depth followed for `has_children`. */
  maxDepth?: number;
}

export class NotionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBlocks: number;
  private readonly maxDepth: number;

  constructor(
    private readonly token: string,
    options: NotionClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBlocks = options.maxBlocks ?? 800;
    this.maxDepth = options.maxDepth ?? 4;
  }

  async request<T = Json>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${API}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: Json = {};
      try {
        parsed = text ? (JSON.parse(text) as Json) : {};
      } catch {
        parsed = {};
      }
      if (!response.ok) {
        const message = typeof parsed.message === "string" ? parsed.message : `Notion API ${response.status}`;
        const code = typeof parsed.code === "string" ? parsed.code : null;
        throw new NotionApiError(message, response.status, code);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The integration's identity (bot user), used as a connection check. */
  async me(): Promise<{ name: string | null; workspace: string | null }> {
    const user = await this.request<Json>("/users/me");
    const bot = (user.bot ?? {}) as Json;
    const owner = (bot.owner ?? {}) as Json;
    return {
      name: typeof user.name === "string" ? user.name : null,
      workspace: typeof bot.workspace_name === "string" ? bot.workspace_name : owner.type === "workspace" ? "workspace" : null,
    };
  }

  async search(query: string, limit = 10, signal?: AbortSignal): Promise<NotionSummary[]> {
    const body: Json = {
      page_size: Math.min(Math.max(limit, 1), 50),
      sort: { direction: "descending", timestamp: "last_edited_time" },
    };
    if (query.trim() !== "") body.query = query.trim();
    const result = await this.request<{ results?: Json[] }>("/search", { method: "POST", body, signal });
    const items: NotionSummary[] = [];
    const seen = new Set<string>();
    for (const object of result.results ?? []) {
      const summary = summarize(object);
      if (!summary || seen.has(summary.id)) continue;
      seen.add(summary.id);
      items.push(summary);
    }
    return items;
  }

  async getPage(id: string, signal?: AbortSignal): Promise<Json> {
    return this.request<Json>(`/pages/${id}`, { signal });
  }

  async getDatabase(id: string, signal?: AbortSignal): Promise<Json> {
    return this.request<Json>(`/databases/${id}`, { signal });
  }

  /** Try the page endpoint first, then the database endpoint. */
  async getObject(id: string, signal?: AbortSignal): Promise<{ kind: NotionKind; object: Json }> {
    try {
      const object = await this.getPage(id, signal);
      return { kind: "page", object };
    } catch (error) {
      if (!(error instanceof NotionApiError) || (error.status !== 404 && error.status !== 400)) throw error;
      const object = await this.getDatabase(id, signal);
      return { kind: "database", object };
    }
  }

  async getSummary(id: string, signal?: AbortSignal): Promise<NotionSummary> {
    const { object } = await this.getObject(id, signal);
    const summary = summarize(object);
    if (!summary) throw new NotionApiError("Unsupported Notion object", 500, null);
    return summary;
  }

  async getBlocks(id: string, signal?: AbortSignal): Promise<{ blocks: NotionBlock[]; truncated: boolean }> {
    let budget = this.maxBlocks;
    let truncated = false;
    const fetchChildren = async (parentId: string, depth: number): Promise<NotionBlock[]> => {
      const blocks: NotionBlock[] = [];
      let cursor: string | null = null;
      do {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        const size = Math.min(100, budget);
        const query = `page_size=${size}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
        const page: { results?: NotionBlock[]; has_more?: boolean; next_cursor?: string | null } = await this.request(
          `/blocks/${parentId}/children?${query}`,
          { signal },
        );
        const results = page.results ?? [];
        budget -= results.length;
        for (const block of results) {
          if (block.has_children && block.type !== "child_page" && block.type !== "child_database") {
            if (depth < this.maxDepth) block.children = await fetchChildren(block.id, depth + 1);
            else truncated = true;
          }
          blocks.push(block);
        }
        cursor = page.has_more ? (page.next_cursor ?? null) : null;
      } while (cursor);
      return blocks;
    };
    const blocks = await fetchChildren(id, 0);
    return { blocks, truncated };
  }

  async getPageDetail(id: string, signal?: AbortSignal): Promise<NotionPageDetail> {
    const page = await this.getPage(id, signal);
    const summary = summarize(page);
    if (!summary || summary.kind !== "page") throw new NotionApiError("Not a page", 400, null);
    const { blocks, truncated } = await this.getBlocks(id, signal);
    const parent = (page.parent ?? {}) as Json;
    const parentType = typeof parent.type === "string" ? parent.type : "unknown";
    const parentId = typeof parent[parentType] === "string" ? (parent[parentType] as string) : null;
    let parentTitle: string | null = null;
    if (parentId && (parentType === "page_id" || parentType === "database_id" || parentType === "data_source_id")) {
      parentTitle = await this.titleOf(parentType, parentId, signal);
    }
    const properties = Object.entries((page.properties ?? {}) as Record<string, Json>)
      .map(([name, property]) => cellOf(name, property))
      .filter((cell) => cell.type !== "title");
    return {
      ...summary,
      kind: "page",
      parentTitle,
      parent: { type: parentType, id: parentId },
      properties,
      markdown: blocksToMarkdown(blocks),
      truncated,
    };
  }

  private async titleOf(parentType: string, parentId: string, signal?: AbortSignal): Promise<string | null> {
    try {
      if (parentType === "page_id") return titleOfPage(await this.getPage(parentId, signal));
      if (parentType === "database_id") return plainRich((await this.getDatabase(parentId, signal)).title) || "Untitled";
      const source = await this.request<Json>(`/data_sources/${parentId}`, { signal });
      return plainRich(source.title) || "Untitled";
    } catch {
      return null;
    }
  }

  async getDatabaseDetail(id: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<NotionDatabaseDetail> {
    const database = await this.getDatabase(id, options.signal);
    const summary = summarize(database);
    if (!summary || summary.kind !== "database") throw new NotionApiError("Not a database", 400, null);
    const sources = Array.isArray(database.data_sources) ? (database.data_sources as Json[]) : [];
    const dataSourceId = typeof sources[0]?.id === "string" ? (sources[0]!.id as string) : null;
    let columns: NotionDatabaseColumn[] = [];
    let rows: NotionDatabaseRow[] = [];
    let hasMore = false;
    if (dataSourceId) {
      const source = await this.request<Json>(`/data_sources/${dataSourceId}`, { signal: options.signal });
      const schema = (source.properties ?? {}) as Record<string, Json>;
      const ordered = Object.entries(schema).map(([name, property]) => ({
        name,
        type: typeof property.type === "string" ? property.type : "unknown",
      }));
      columns = [...ordered.filter((column) => column.type === "title"), ...ordered.filter((column) => column.type !== "title")];
      const query = await this.request<{ results?: Json[]; has_more?: boolean }>(`/data_sources/${dataSourceId}/query`, {
        method: "POST",
        body: {
          page_size: Math.min(Math.max(options.limit ?? 50, 1), 100),
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        },
        signal: options.signal,
      });
      hasMore = Boolean(query.has_more);
      rows = (query.results ?? []).map((page) => {
        const properties = (page.properties ?? {}) as Record<string, Json>;
        return {
          id: String(page.id ?? ""),
          title: titleOfPage(page),
          icon: iconOf(page.icon),
          url: typeof page.url === "string" ? page.url : notionUrl(String(page.id ?? "")),
          lastEditedAt: typeof page.last_edited_time === "string" ? page.last_edited_time : null,
          cells: columns.map((column) => (properties[column.name] ? cellOf(column.name, properties[column.name]!) : emptyCell(column))),
        };
      });
    }
    return {
      ...summary,
      kind: "database",
      description: plainRich(database.description),
      dataSourceId,
      columns,
      rows,
      hasMore,
    };
  }
}

function emptyCell(column: NotionDatabaseColumn): NotionCell {
  return { name: column.name, type: column.type, text: "", values: [], checked: column.type === "checkbox" ? false : null, href: null };
}

/** Normalize a page / database / data_source object from search or GET. */
export function summarize(object: Json): NotionSummary | null {
  const type = object.object;
  const id = typeof object.id === "string" ? object.id : null;
  if (!id) return null;
  if (type === "page") {
    return {
      id,
      kind: "page",
      title: titleOfPage(object),
      icon: iconOf(object.icon),
      url: typeof object.url === "string" ? object.url : notionUrl(id),
      lastEditedAt: typeof object.last_edited_time === "string" ? object.last_edited_time : null,
      parentTitle: null,
    };
  }
  if (type === "database") {
    return {
      id,
      kind: "database",
      title: plainRich(object.title) || "Untitled",
      icon: iconOf(object.icon),
      url: typeof object.url === "string" ? object.url : notionUrl(id),
      lastEditedAt: typeof object.last_edited_time === "string" ? object.last_edited_time : null,
      parentTitle: null,
    };
  }
  if (type === "data_source") {
    const parent = (object.parent ?? {}) as Json;
    const databaseId = typeof parent.database_id === "string" ? parent.database_id : null;
    if (!databaseId) return null;
    return {
      id: databaseId,
      kind: "database",
      title: plainRich(object.title) || "Untitled",
      icon: iconOf(object.icon),
      url: notionUrl(databaseId),
      lastEditedAt: typeof object.last_edited_time === "string" ? object.last_edited_time : null,
      parentTitle: null,
    };
  }
  return null;
}

/** Markdown rendering of a database for agents and mention context. */
export function databaseToMarkdown(database: NotionDatabaseDetail, maxRows = 50): string {
  const lines: string[] = [];
  lines.push(`# ${database.icon?.kind === "emoji" ? `${database.icon.value} ` : ""}${database.title}`);
  if (database.description) lines.push("", database.description);
  lines.push("", `Source: ${database.url}`);
  const columns = database.columns.slice(0, 10);
  if (columns.length === 0 || database.rows.length === 0) {
    lines.push("", "_No rows visible to this integration._");
    return lines.join("\n");
  }
  lines.push("", `| ${columns.map((column) => column.name.replace(/\|/g, "\\|")).join(" | ")} |`);
  lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of database.rows.slice(0, maxRows)) {
    const cells = columns.map((column) => {
      const cell = row.cells.find((candidate) => candidate.name === column.name);
      if (!cell) return "";
      if (cell.type === "title") return `[${cell.text || "Untitled"}](${row.url})`;
      if (cell.type === "checkbox") return cell.checked ? "✅" : "—";
      return cell.text.replace(/\|/g, "\\|").replace(/\n/g, " ");
    });
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (database.hasMore || database.rows.length > maxRows) lines.push("", `_Showing ${Math.min(maxRows, database.rows.length)} most recently edited rows._`);
  return lines.join("\n");
}

/** Markdown rendering of a page for agents and mention context. */
export function pageToMarkdown(page: NotionPageDetail): string {
  const lines: string[] = [];
  lines.push(`# ${page.icon?.kind === "emoji" ? `${page.icon.value} ` : ""}${page.title}`);
  lines.push("", `Source: ${page.url}`);
  if (page.parentTitle) lines.push(`In: ${page.parentTitle}`);
  const shown = page.properties.filter((cell) => cell.text !== "");
  if (shown.length > 0) {
    lines.push("");
    for (const cell of shown) lines.push(`- **${cell.name}:** ${cell.text}`);
  }
  if (page.markdown) lines.push("", page.markdown);
  if (page.truncated) lines.push("", "_Content truncated: the page is longer than the fetch budget._");
  return lines.join("\n");
}
