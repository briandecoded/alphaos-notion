// bb-plugin-notion — backend.
//
// Talks to the Notion API with an internal-integration token, caches what it
// reads in the plugin's own SQLite file, and exposes that to four surfaces:
// the app (RPC), the composer (@-mentions), agents (native tools + `bb notion`
// CLI), and inline cards in assistant replies (the `::notion{}` directive the
// skill teaches).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  NotionApiError,
  NotionClient,
  databaseToMarkdown,
  normalizeNotionId,
  pageToMarkdown,
  type NotionDatabaseDetail,
  type NotionPageDetail,
  type NotionSummary,
} from "./notion/api";
import { clampMarkdown } from "./notion/markdown";
import { archiveSynthesisResearch, createSynthesisResearch } from "./notion/synthesis";

// ---------- wire schemas ----------

const iconSchema = z.object({ kind: z.enum(["emoji", "url"]), value: z.string() }).nullable();
const kindSchema = z.enum(["page", "database"]);
export const summarySchema = z.object({
  id: z.string(),
  kind: kindSchema,
  title: z.string(),
  icon: iconSchema,
  url: z.string(),
  lastEditedAt: z.string().nullable(),
  parentTitle: z.string().nullable(),
});
const cellSchema = z.object({
  name: z.string(),
  type: z.string(),
  text: z.string(),
  values: z.array(z.string()),
  checked: z.boolean().nullable(),
  href: z.string().nullable(),
});
const pageSchema = summarySchema.extend({
  kind: z.literal("page"),
  parent: z.object({ type: z.string(), id: z.string().nullable() }),
  properties: z.array(cellSchema),
  markdown: z.string(),
  truncated: z.boolean(),
});
const databaseSchema = summarySchema.extend({
  kind: z.literal("database"),
  description: z.string(),
  dataSourceId: z.string().nullable(),
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      icon: iconSchema,
      url: z.string(),
      lastEditedAt: z.string().nullable(),
      cells: z.array(cellSchema),
    }),
  ),
  hasMore: z.boolean(),
});
const pinSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: kindSchema.nullable(),
  icon: iconSchema,
  title: z.string().nullable(),
  url: z.string(),
});
export type Pin = z.infer<typeof pinSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type PageDetail = z.infer<typeof pageSchema>;
export type DatabaseDetail = z.infer<typeof databaseSchema>;
export type Cell = z.infer<typeof cellSchema>;

export const rpcContract = defineRpcContract({
  synthesis_create: {
    input: z.object({
      quickSearchId: z.string().uuid(), question: z.string().min(1).max(500), answer: z.string().min(1).max(200_000),
      sources: z.array(z.object({ url: z.string().url(), title: z.string() })).max(100), mode: z.string().max(40),
      model: z.string().nullable(), backendUuid: z.string().nullable(),
    }).strict(),
    output: z.object({ id: z.string(), url: z.string(), existing: z.boolean() }),
  },
  synthesis_archive: {
    input: z.object({ id: z.string().uuid(), quickSearchId: z.string().uuid() }).strict(),
    output: z.object({ archived: z.literal(true) }),
  },
  status: {
    input: z.null(),
    output: z.object({
      configured: z.boolean(),
      workspace: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
  pins_list: { input: z.null(), output: z.object({ pins: z.array(pinSchema) }) },
  pin_add: {
    input: z.object({ input: z.string().trim().min(1), label: z.string().trim().max(80).optional() }).strict(),
    output: pinSchema,
  },
  pin_remove: { input: z.object({ id: z.string() }).strict(), output: z.object({ removed: z.boolean() }) },
  search: {
    input: z.object({ query: z.string().max(200), limit: z.number().int().min(1).max(50).optional() }).strict(),
    output: z.object({ items: z.array(summarySchema) }),
  },
  resolve: { input: z.object({ input: z.string().trim().min(1) }).strict(), output: summarySchema },
  page_get: {
    input: z.object({ id: z.string(), refresh: z.boolean().optional() }).strict(),
    output: z.object({ page: pageSchema, fetchedAt: z.string() }),
  },
  database_get: {
    input: z.object({ id: z.string(), refresh: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    output: z.object({ database: databaseSchema, fetchedAt: z.string() }),
  },
  recents_list: { input: z.null(), output: z.object({ items: z.array(summarySchema) }) },
  recents_touch: { input: summarySchema, output: z.object({ ok: z.literal(true) }) },
});

/** Realtime channels the app listens on. */
export const PINS_CHANGED = "pins-changed";
export const RECENTS_CHANGED = "recents-changed";

/** Pins start empty; add them from the sidebar page or with `bb notion pin`. */
const DEFAULT_PINS: { id: string; label: string }[] = [];

const MENTION_CONTEXT_MAX = 24_000;
const TOOL_OUTPUT_MAX = 60_000;

type StoredPin = { id: string; label: string };

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    notionApiKey: {
      type: "string",
      label: "Notion integration token",
      description:
        "Internal integration secret from notion.so/my-integrations. Share the pages you want visible with that integration (children inherit the share).",
      secret: true,
    },
    cacheMinutes: {
      type: "select",
      label: "Cache pages for",
      description: "How long a fetched page or database is reused before it is re-read from Notion. Refresh in the viewer always bypasses this.",
      options: ["1", "5", "15", "60"],
      default: "5",
    },
  });

  // ---------- storage ----------
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS recents (id TEXT PRIMARY KEY, payload TEXT NOT NULL, opened_at INTEGER NOT NULL)`,
  ]);
  const cacheRead = db.prepare<[string], { payload: string; fetched_at: number }>(`SELECT payload, fetched_at FROM cache WHERE key = ?`);
  const cacheWrite = db.prepare<[string, string, number]>(`INSERT OR REPLACE INTO cache (key, payload, fetched_at) VALUES (?, ?, ?)`);
  const recentsRead = db.prepare<[], { payload: string }>(`SELECT payload FROM recents ORDER BY opened_at DESC LIMIT 12`);
  const recentsWrite = db.prepare<[string, string, number]>(`INSERT OR REPLACE INTO recents (id, payload, opened_at) VALUES (?, ?, ?)`);
  const recentsTrim = db.prepare(`DELETE FROM recents WHERE id NOT IN (SELECT id FROM recents ORDER BY opened_at DESC LIMIT 40)`);

  function cached<T>(key: string, maxAgeMs: number): { value: T; fetchedAt: number } | null {
    const row = cacheRead.get(key);
    if (!row) return null;
    if (Date.now() - row.fetched_at > maxAgeMs) return null;
    try {
      return { value: JSON.parse(row.payload) as T, fetchedAt: row.fetched_at };
    } catch {
      return null;
    }
  }
  function remember(key: string, value: unknown): number {
    const now = Date.now();
    cacheWrite.run(key, JSON.stringify(value), now);
    return now;
  }

  // ---------- client ----------
  let client: NotionClient | null = null;
  let clientToken = "";
  let identity: { workspace: string | null; checkedAt: number; error: string | null } | null = null;

  async function getClient(): Promise<NotionClient | null> {
    const { notionApiKey } = await settings.get();
    const token = (notionApiKey ?? "").trim();
    if (token === "") {
      client = null;
      clientToken = "";
      return null;
    }
    if (!client || clientToken !== token) {
      client = new NotionClient(token);
      clientToken = token;
      identity = null;
    }
    return client;
  }
  async function requireClient(): Promise<NotionClient> {
    const ready = await getClient();
    if (!ready) throw new Error("Notion is not connected. Add the integration token under Extensions → Plugins → Notion.");
    return ready;
  }
  async function cacheTtlMs(): Promise<number> {
    const { cacheMinutes } = await settings.get();
    return Math.max(1, Number(cacheMinutes) || 5) * 60_000;
  }
  function describeError(error: unknown): string {
    if (error instanceof NotionApiError) {
      if (error.status === 401) return "Notion rejected the integration token.";
      if (error.status === 404) return "Notion could not find that page, or it is not shared with the integration.";
      return `Notion: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  const initial = await settings.get();
  if (!(initial.notionApiKey ?? "").trim()) {
    bb.status.needsConfiguration("Add your Notion integration token under Extensions → Plugins → Notion.");
  }
  settings.onChange(() => {
    client = null;
    clientToken = "";
    identity = null;
  });

  // ---------- reads ----------
  async function summaryOf(id: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<NotionSummary> {
    const ttl = await cacheTtlMs();
    if (!options.refresh) {
      const hit = cached<NotionSummary>(`summary:${id}`, ttl);
      if (hit) return hit.value;
    }
    const notion = await requireClient();
    const summary = await notion.getSummary(id, options.signal);
    remember(`summary:${id}`, summary);
    return summary;
  }
  async function resolveInput(input: string, signal?: AbortSignal): Promise<NotionSummary> {
    const id = normalizeNotionId(input);
    if (!id) throw new Error(`"${input}" is not a Notion page id or URL.`);
    return summaryOf(id, { signal });
  }
  async function pageOf(id: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<{ page: NotionPageDetail; fetchedAt: number }> {
    const ttl = await cacheTtlMs();
    if (!options.refresh) {
      const hit = cached<NotionPageDetail>(`page:${id}`, ttl);
      if (hit) return { page: hit.value, fetchedAt: hit.fetchedAt };
    }
    const notion = await requireClient();
    const page = await notion.getPageDetail(id, options.signal);
    const fetchedAt = remember(`page:${id}`, page);
    remember(`summary:${id}`, stripSummary(page));
    return { page, fetchedAt };
  }
  async function databaseOf(
    id: string,
    options: { refresh?: boolean; limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ database: NotionDatabaseDetail; fetchedAt: number }> {
    const ttl = await cacheTtlMs();
    const key = `db:${id}:${options.limit ?? 50}`;
    if (!options.refresh) {
      const hit = cached<NotionDatabaseDetail>(key, ttl);
      if (hit) return { database: hit.value, fetchedAt: hit.fetchedAt };
    }
    const notion = await requireClient();
    const database = await notion.getDatabaseDetail(id, { limit: options.limit, signal: options.signal });
    const fetchedAt = remember(key, database);
    remember(`summary:${id}`, stripSummary(database));
    return { database, fetchedAt };
  }
  function stripSummary(detail: NotionSummary): NotionSummary {
    return {
      id: detail.id,
      kind: detail.kind,
      title: detail.title,
      icon: detail.icon,
      url: detail.url,
      lastEditedAt: detail.lastEditedAt,
      parentTitle: detail.parentTitle,
    };
  }
  /** Markdown for agents/mentions: page body or database table. */
  async function markdownOf(input: string, options: { refresh?: boolean; maxChars: number; signal?: AbortSignal }): Promise<string> {
    const summary = await resolveInput(input, options.signal);
    const markdown =
      summary.kind === "page"
        ? pageToMarkdown((await pageOf(summary.id, { refresh: options.refresh, signal: options.signal })).page)
        : databaseToMarkdown((await databaseOf(summary.id, { refresh: options.refresh, signal: options.signal })).database);
    const clamped = clampMarkdown(markdown, options.maxChars);
    return clamped.truncated ? `${clamped.text}\n\n_[truncated — open ${summary.url} for the rest]_` : clamped.text;
  }

  // ---------- pins ----------
  async function readPins(): Promise<StoredPin[]> {
    const stored = await bb.storage.kv.get<StoredPin[]>("pins");
    if (stored) return stored;
    await bb.storage.kv.set("pins", DEFAULT_PINS);
    return DEFAULT_PINS;
  }
  async function writePins(pins: StoredPin[]): Promise<void> {
    await bb.storage.kv.set("pins", pins);
    bb.realtime.publish(PINS_CHANGED, { count: pins.length });
  }
  async function enrichPins(pins: StoredPin[]): Promise<Pin[]> {
    const ttl = 24 * 60 * 60_000; // labels are stable; a day-old summary is fine for a pin row
    return Promise.all(
      pins.map(async (pin) => {
        let summary = cached<NotionSummary>(`summary:${pin.id}`, ttl)?.value ?? null;
        if (!summary) {
          try {
            summary = await summaryOf(pin.id);
          } catch (error) {
            bb.log.debug(`pin ${pin.id}: ${describeError(error)}`);
          }
        }
        return {
          id: pin.id,
          label: pin.label,
          kind: summary?.kind ?? null,
          icon: summary?.icon ?? null,
          title: summary?.title ?? null,
          url: summary?.url ?? `https://www.notion.so/${pin.id.replace(/-/g, "")}`,
        };
      }),
    );
  }

  // ---------- recents ----------
  function listRecents(): NotionSummary[] {
    const items: NotionSummary[] = [];
    for (const row of recentsRead.all()) {
      try {
        items.push(JSON.parse(row.payload) as NotionSummary);
      } catch {
        // skip corrupt rows
      }
    }
    return items;
  }
  function touchRecent(summary: NotionSummary): void {
    recentsWrite.run(summary.id, JSON.stringify(stripSummary(summary)), Date.now());
    recentsTrim.run();
    bb.realtime.publish(RECENTS_CHANGED, { id: summary.id });
  }

  // ---------- RPC ----------
  bb.rpc.register(rpcContract, {
    async synthesis_create(input) {
      return createSynthesisResearch(await requireClient(), input);
    },
    async synthesis_archive({ id, quickSearchId }) {
      return archiveSynthesisResearch(await requireClient(), id, quickSearchId);
    },
    async status() {
      const notion = await getClient();
      if (!notion) return { configured: false, workspace: null, error: null };
      if (!identity || Date.now() - identity.checkedAt > 5 * 60_000) {
        try {
          const me = await notion.me();
          identity = { workspace: me.workspace ?? me.name, checkedAt: Date.now(), error: null };
        } catch (error) {
          identity = { workspace: null, checkedAt: Date.now(), error: describeError(error) };
        }
      }
      return { configured: true, workspace: identity.workspace, error: identity.error };
    },
    async pins_list() {
      return { pins: await enrichPins(await readPins()) };
    },
    async pin_add({ input, label }) {
      const summary = await resolveInput(input);
      const pins = (await readPins()).filter((pin) => pin.id !== summary.id);
      const stored = { id: summary.id, label: (label ?? "").trim() || summary.title };
      pins.push(stored);
      await writePins(pins);
      return (await enrichPins([stored]))[0]!;
    },
    async pin_remove({ id }) {
      const pins = await readPins();
      const remaining = pins.filter((pin) => pin.id !== id);
      if (remaining.length === pins.length) return { removed: false };
      await writePins(remaining);
      return { removed: true };
    },
    async search({ query, limit }) {
      const notion = await requireClient();
      const items = await notion.search(query, limit ?? 12);
      for (const item of items) remember(`summary:${item.id}`, item);
      return { items };
    },
    async resolve({ input }) {
      return resolveInput(input);
    },
    async page_get({ id, refresh }) {
      const result = await pageOf(id, { refresh });
      return { page: result.page, fetchedAt: new Date(result.fetchedAt).toISOString() };
    },
    async database_get({ id, refresh, limit }) {
      const result = await databaseOf(id, { refresh, limit });
      return { database: result.database, fetchedAt: new Date(result.fetchedAt).toISOString() };
    },
    async recents_list() {
      return { items: listRecents() };
    },
    async recents_touch(summary) {
      touchRecent(summary);
      return { ok: true as const };
    },
  });

  // ---------- composer @-mentions ----------
  bb.ui.registerMentionProvider({
    id: "page",
    label: "Notion",
    triggers: ["@"],
    async search({ query }) {
      const notion = await getClient();
      if (!notion) return [];
      const trimmed = query.trim();
      if (trimmed === "") {
        const pins = await enrichPins(await readPins());
        return pins.map((pin) => ({
          id: pin.id,
          title: pin.label,
          subtitle: pin.kind === "database" ? "Notion database" : "Notion page",
          icon: pin.icon?.kind === "emoji" ? pin.icon.value : undefined,
        }));
      }
      const items = await notion.search(trimmed, 8);
      return items.map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.kind === "database" ? "Notion database" : "Notion page",
        icon: item.icon?.kind === "emoji" ? item.icon.value : undefined,
      }));
    },
    async resolve(itemId) {
      const context = await markdownOf(itemId, { maxChars: MENTION_CONTEXT_MAX });
      return { context: `<notion-page id="${itemId}">\n${context}\n</notion-page>` };
    },
  });

  // ---------- agent tools ----------
  const directiveHelp =
    'When you reference a Notion page in a reply, add an inline card with the directive `::notion{id="<page-id>" title="<title>"}` on its own line so the user can open it in the side panel.';
  bb.agents.registerTool({
    name: "notion_search",
    description: "Search the user's Notion workspace for pages and databases by keyword. Returns ids, titles, kinds, and URLs.",
    instructions: `Use notion_search to find Notion pages before reading them. ${directiveHelp}`,
    presentation: { label: { pending: "Searching Notion", completed: "Searched Notion" } },
    parameters: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(25).optional() }),
    async execute({ query, limit }, { signal }) {
      const notion = await requireClient();
      const items = await notion.search(query, limit ?? 10, signal);
      for (const item of items) remember(`summary:${item.id}`, item);
      if (items.length === 0) return `No Notion results for "${query}".`;
      return items
        .map((item) => `- ${item.icon?.kind === "emoji" ? `${item.icon.value} ` : ""}${item.title} (${item.kind}) — id ${item.id} — ${item.url}`)
        .join("\n");
    },
  });
  bb.agents.registerTool({
    name: "notion_read",
    description: "Read a Notion page (as Markdown) or database (as a table of recent rows) by id or URL.",
    instructions: `notion_read returns page content the user already has in Notion; cite it rather than guessing. ${directiveHelp}`,
    presentation: { label: { pending: "Reading Notion page", completed: "Read Notion page" } },
    parameters: z.object({ page: z.string().min(1).describe("Page or database id, or a notion.so URL"), refresh: z.boolean().optional() }),
    async execute({ page, refresh }, { signal }) {
      return markdownOf(page, { refresh, maxChars: TOOL_OUTPUT_MAX, signal });
    },
  });

  // ---------- CLI ----------
  const usage = [
    "Usage:",
    "  bb notion status [--json]",
    "  bb notion search <query> [--json]",
    "  bb notion read <id-or-url> [--refresh] [--json]",
    "  bb notion pins [--json]",
    "  bb notion pin <id-or-url> [label]",
    "  bb notion unpin <id>",
  ].join("\n");
  bb.cli.register({
    name: "notion",
    summary: "Read, search, and pin Notion pages and databases",
    commands: [
      { name: "status", summary: "Connection state and pinned pages", usage: "bb notion status [--json]" },
      { name: "search", summary: "Search the workspace", usage: "bb notion search <query> [--json]" },
      { name: "read", summary: "Print a page as Markdown (or a database as a table)", usage: "bb notion read <id-or-url> [--refresh] [--json]" },
      { name: "pins", summary: "List pinned pages", usage: "bb notion pins [--json]" },
      { name: "pin", summary: "Pin a page to the Notion sidebar page", usage: "bb notion pin <id-or-url> [label]" },
      { name: "unpin", summary: "Remove a pin", usage: "bb notion unpin <id>" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const refresh = argv.includes("--refresh");
      const [command, ...args] = argv.filter((arg) => arg !== "--json" && arg !== "--refresh");
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value, null, 2) : text });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "status": {
            const notion = await getClient();
            const pins = await enrichPins(await readPins());
            if (!notion) return reply({ configured: false, pins }, "Not connected: add the Notion integration token under Extensions → Plugins → Notion.");
            let line = "Connected";
            try {
              const me = await notion.me();
              line = `Connected as ${me.name ?? "integration"}${me.workspace ? ` (${me.workspace})` : ""}`;
            } catch (error) {
              line = `Token set but Notion returned an error: ${describeError(error)}`;
            }
            return reply(
              { configured: true, pins },
              [line, "", "Pinned:", ...pins.map((pin) => `  ${pin.icon?.kind === "emoji" ? `${pin.icon.value} ` : ""}${pin.label}  ${pin.id}  (${pin.kind ?? "unknown"})`)].join("\n"),
            );
          }
          case "search": {
            const query = args.join(" ").trim();
            if (query === "") return fail(usage);
            const notion = await requireClient();
            const items = await notion.search(query, 15, ctx.signal);
            for (const item of items) remember(`summary:${item.id}`, item);
            return reply(
              items,
              items.length === 0
                ? "No results."
                : items.map((item) => `${item.icon?.kind === "emoji" ? `${item.icon.value} ` : ""}${item.title}  [${item.kind}]  ${item.id}`).join("\n"),
            );
          }
          case "read": {
            const target = args[0];
            if (!target) return fail(usage);
            const summary = await resolveInput(target, ctx.signal);
            const markdown = await markdownOf(target, { refresh, maxChars: 900_000, signal: ctx.signal });
            return reply({ ...summary, markdown }, markdown);
          }
          case "pins": {
            const pins = await enrichPins(await readPins());
            return reply(pins, pins.length === 0 ? "No pins." : pins.map((pin) => `${pin.label}  ${pin.id}  (${pin.kind ?? "unknown"})`).join("\n"));
          }
          case "pin": {
            const target = args[0];
            if (!target) return fail(usage);
            const summary = await resolveInput(target, ctx.signal);
            const label = args.slice(1).join(" ").trim() || summary.title;
            const pins = (await readPins()).filter((pin) => pin.id !== summary.id);
            pins.push({ id: summary.id, label });
            await writePins(pins);
            return reply({ id: summary.id, label }, `Pinned ${label} (${summary.id})`);
          }
          case "unpin": {
            const id = args[0] ? normalizeNotionId(args[0]) : null;
            if (!id) return fail(usage);
            const pins = await readPins();
            const remaining = pins.filter((pin) => pin.id !== id);
            if (remaining.length === pins.length) return fail(`No pin with id ${id}. Run "bb notion pins".`);
            await writePins(remaining);
            return reply({ removed: true, id }, `Unpinned ${id}`);
          }
        }
        return fail(usage);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  });

  bb.onDispose(() => {
    client = null;
    bb.log.info("disposed");
  });
  bb.log.info("loaded");
}
