import { describe, expect, it, vi } from "vitest";
import { archiveSynthesisResearch, createSynthesisResearch, SYNTHESIS_DATABASE_ID } from "./synthesis";
import type { NotionClient } from "./api";

const sourceId = "6d0bff21-115b-82ad-be58-07d012373956";
const pageId = "3f00ff21-115b-81ab-abcd-123456789abc";
const input = { quickSearchId: "11111111-1111-4111-8111-111111111111", question: "What changed?", answer: "A".repeat(3_600), sources: [{ url: "https://example.com/source", title: "Source" }], mode: "reasoning", model: "gpt6_sol_thinking", backendUuid: "pplx-1" };

describe("synthesisOS Notion write", () => {
  it("creates in the exact data source and reads the full answer back", async () => {
    const written: Record<string, unknown>[] = [];
    const request = vi.fn(async (path: string, init?: { body?: Record<string, unknown> }) => {
      if (path.endsWith("/query")) return { results: [] };
      if (path === "/pages") {
        written.push(...(init?.body?.children as Record<string, unknown>[]));
        expect(init?.body?.parent).toEqual({ type: "data_source_id", data_source_id: sourceId });
        expect(JSON.stringify(init?.body?.properties)).toContain(`quick_search_id=${input.quickSearchId}`);
        return { id: pageId, url: `https://www.notion.so/${pageId}` };
      }
      if (path.endsWith("/children")) { written.push(...(init?.body?.children as Record<string, unknown>[])); return {}; }
      throw new Error(path);
    });
    const client = {
      getDatabaseDetail: async (id: string) => { expect(id).toBe(SYNTHESIS_DATABASE_ID); return { dataSourceId: sourceId, columns: [{ name: "Title", type: "title" }, { name: "Document Notes", type: "rich_text" }] }; },
      request,
      getPage: async () => ({ id: pageId, url: `https://www.notion.so/${pageId}`, parent: { data_source_id: sourceId } }),
      getBlocks: async () => ({ truncated: false, blocks: written.map((block) => {
        const paragraph = block.paragraph as { rich_text?: { text?: { content: string } }[] } | undefined;
        return { ...block, paragraph: paragraph ? { rich_text: paragraph.rich_text?.map((part) => ({ plain_text: part.text?.content })) } : undefined };
      }) }),
    } as unknown as NotionClient;
    const result = await createSynthesisResearch(client, input);
    expect(result).toEqual({ id: pageId, url: `https://www.notion.so/${pageId}`, existing: false });
    expect(written).toHaveLength(4); // two answer paragraphs, heading, linked source
    expect(JSON.stringify(written[3])).toContain("https://example.com/source");
  });

  it("returns an existing row with the same quick-search id", async () => {
    const request = vi.fn(async () => ({ results: [{ id: pageId, url: `https://www.notion.so/${pageId}` }] }));
    const client = { getDatabaseDetail: async () => ({ dataSourceId: sourceId, columns: [{ name: "Title", type: "title" }, { name: "Document Notes", type: "rich_text" }] }), request } as unknown as NotionClient;
    expect(await createSynthesisResearch(client, input)).toMatchObject({ id: pageId, existing: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("archives only a page with the matching quick-search marker", async () => {
    let archived = false;
    const client = {
      getDatabaseDetail: async () => ({ dataSourceId: sourceId }),
      getPage: async () => ({ parent: { data_source_id: sourceId }, properties: { "Document Notes": { rich_text: [{ plain_text: `quick_search_id=${input.quickSearchId}` }] } }, archived }),
      request: async (path: string, options: { method: string; body: { archived: boolean } }) => { expect(path).toBe(`/pages/${pageId}`); expect(options.body).toEqual({ archived: true }); archived = true; return {}; },
    } as unknown as NotionClient;
    expect(await archiveSynthesisResearch(client, pageId, input.quickSearchId)).toEqual({ archived: true });
    await expect(archiveSynthesisResearch(client, pageId, "33333333-3333-4333-8333-333333333333")).rejects.toThrow(/not the requested/);
  });
});
