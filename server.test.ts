import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const PAGE_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const DB_ID = "11111111-2222-4333-8444-555555555555";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A tiny fake of the Notion API: one page, one database with one row. */
function fakeNotion() {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/users/me")) return json({ object: "user", name: "bb", bot: { workspace_name: "Alpha" } });
    if (url.endsWith("/search")) {
      return json({
        results: [
          { object: "page", id: PAGE_ID, url: "https://www.notion.so/p", last_edited_time: "2026-09-01T00:00:00.000Z", icon: { type: "emoji", emoji: "🎮" }, properties: { Name: { type: "title", title: [{ plain_text: "Launch plan" }] } } },
          { object: "database", id: DB_ID, url: "https://www.notion.so/d", title: [{ plain_text: "Roadmap" }], icon: { type: "emoji", emoji: "🎲" } },
        ],
      });
    }
    if (url.includes(`/pages/${PAGE_ID}`)) {
      return json({
        object: "page",
        id: PAGE_ID,
        url: "https://www.notion.so/p",
        last_edited_time: "2026-09-01T00:00:00.000Z",
        parent: { type: "database_id", database_id: DB_ID },
        properties: { Name: { type: "title", title: [{ plain_text: "Launch plan" }] }, Status: { type: "status", status: { name: "Done" } } },
      });
    }
    if (url.includes(`/pages/${DB_ID}`)) return json({ object: "error", status: 404, code: "object_not_found", message: "Could not find page" }, 404);
    if (url.includes(`/databases/${DB_ID}`)) return json({ object: "database", id: DB_ID, url: "https://www.notion.so/d", title: [{ plain_text: "Roadmap" }], data_sources: [{ id: "ds1" }] });
    if (url.endsWith(`/data_sources/ds1`)) return json({ object: "data_source", id: "ds1", properties: { Status: { type: "status" }, Name: { type: "title" } } });
    if (url.endsWith(`/data_sources/ds1/query`)) {
      return json({ results: [{ object: "page", id: PAGE_ID, url: "https://www.notion.so/p", properties: { Name: { type: "title", title: [{ plain_text: "Launch plan" }] }, Status: { type: "status", status: { name: "Done" } } } }], has_more: false });
    }
    if (url.includes(`/blocks/${PAGE_ID}/children`)) {
      return json({ results: [{ id: "b1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Arc" }] } }, { id: "b2", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Body" }] } }], has_more: false });
    }
    return json({ object: "error", message: `unexpected ${url}` }, 500);
  });
  return { fetchImpl, urls };
}

describe("notion plugin backend", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports needs-configuration without a token", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "notion" });
    await plugin(bb);
    expect(harness.needsConfigurationMessages.length).toBe(1);
    const status = await harness.behavior.callRpc("status", null);
    expect(status).toMatchObject({ configured: false });
    const pins = (await harness.behavior.callRpc("pins_list", null)) as { pins: { label: string }[] };
    expect(pins.pins).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("searches, reads, caches, and renders through every surface", async () => {
    const notion = fakeNotion();
    vi.stubGlobal("fetch", notion.fetchImpl);
    const { bb, harness } = createFakePluginHost({ pluginId: "notion", settings: { notionApiKey: "secret_x" } });
    await plugin(bb);
    expect(harness.needsConfigurationMessages.length).toBe(0);

    const search = (await harness.behavior.callRpc("search", { query: "game" })) as { items: { id: string; kind: string }[] };
    expect(search.items.map((item) => item.kind)).toEqual(["page", "database"]);

    const page = (await harness.behavior.callRpc("page_get", { id: PAGE_ID })) as { page: { title: string; markdown: string; parentTitle: string | null; properties: { name: string }[] } };
    expect(page.page.title).toBe("Launch plan");
    expect(page.page.markdown).toBe("## Arc\n\nBody");
    expect(page.page.parentTitle).toBe("Roadmap");
    expect(page.page.properties.map((cell) => cell.name)).toEqual(["Status"]);

    const before = notion.urls.length;
    await harness.behavior.callRpc("page_get", { id: PAGE_ID });
    expect(notion.urls.length).toBe(before); // served from cache

    const database = (await harness.behavior.callRpc("database_get", { id: DB_ID })) as { database: { columns: { name: string }[]; rows: { title: string }[] } };
    expect(database.database.columns[0]!.name).toBe("Name");
    expect(database.database.rows[0]!.title).toBe("Launch plan");

    const cli = await harness.behavior.runCli(["read", `https://www.notion.so/x-${DB_ID.replace(/-/g, "")}`]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("| Name | Status |");
    expect(cli.stdout).toContain("[Launch plan](https://www.notion.so/p)");

    const tool = await harness.behavior.callAgentTool("notion_read", { page: PAGE_ID });
    expect(String(typeof tool === "string" ? tool : JSON.stringify(tool))).toContain("# Launch plan");

    const pinned = await harness.behavior.runCli(["pin", PAGE_ID, "Game"]);
    expect(pinned.exitCode).toBe(0);
    expect(harness.realtimeSignals.some((signal) => signal.channel === "pins-changed")).toBe(true);
    const pins = (await harness.behavior.callRpc("pins_list", null)) as { pins: { label: string }[] };
    expect(pins.pins.map((pin) => pin.label)).toEqual(["Game"]);

    // An empty @ query lists the pins.
    const mention = harness.registrations.mentionProviders[0]!;
    expect(mention.id).toBe("page");
    const items = await mention.search({ trigger: "@", query: "", projectId: null, threadId: null });
    expect(items.map((item) => item.title)).toEqual(["Game"]);
    const resolved = await mention.resolve(PAGE_ID);
    expect(resolved.context).toContain("<notion-page");
    expect(resolved.context).toContain("## Arc");

    await harness.lifecycle.dispose();
  });
});
