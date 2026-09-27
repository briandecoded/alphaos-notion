import { describe, expect, it, vi } from "vitest";
import type { NotionClient } from "./api";
import { archiveSynthesisConversation, conversationBlocks, createSynthesisConversation, type SynthesisConversationInput } from "./synthesis-conversation";

const sourceId = "6d0bff21-115b-82ad-be58-07d012373956";
const pageId = "11111111-1111-4111-8111-111111111111";
const input: SynthesisConversationInput = {
  snapshotId: "22222222-2222-5222-8222-222222222222", threadId: "thr_research", title: "First question",
  exchanges: [
    { question: "First question", answer: "First answer", sources: [{ title: "First source", url: "https://example.com/first" }] },
    { question: "Follow-up question", answer: "Follow-up answer", sources: [{ title: "Second source", url: "https://example.com/second" }] },
  ],
};

describe("complete conversation export", () => {
  it("writes all questions, answers and linked sources, then reads back exact content", async () => {
    const stored: Record<string, unknown>[] = [];
    const request = vi.fn(async (path: string, options: { body?: Record<string, unknown> } = {}) => {
      if (path.endsWith("/query")) return { results: [] };
      if (path === "/pages") {
        expect(options.body?.parent).toEqual({ type: "data_source_id", data_source_id: sourceId });
        expect(JSON.stringify(options.body?.properties)).toContain(`research_snapshot_id=${input.snapshotId}`);
        stored.push(...options.body!.children as Record<string, unknown>[]);
        return { id: pageId, url: `https://www.notion.so/${pageId}` };
      }
      if (path.endsWith("/children")) { stored.push(...options.body!.children as Record<string, unknown>[]); return {}; }
      throw new Error(path);
    });
    const getBlocks = vi.fn(async () => ({ truncated: false, blocks: stored.map((block) => {
      const type = String(block.type);
      const content = block[type] as { rich_text: { text: { content: string; link?: { url: string } } }[] };
      return { ...block, [type]: { rich_text: content.rich_text.map((part) => ({ plain_text: part.text.content, href: part.text.link?.url })) } };
    }) }));
    const client = {
      getDatabaseDetail: async () => ({ dataSourceId: sourceId, columns: [{ name: "Title", type: "title" }, { name: "Document Notes", type: "rich_text" }] }),
      request, getPage: async () => ({ id: pageId, url: `https://www.notion.so/${pageId}`, parent: { data_source_id: sourceId } }), getBlocks,
    } as unknown as NotionClient;
    const result = await createSynthesisConversation(client, input);
    expect(result).toEqual({ id: pageId, url: `https://www.notion.so/${pageId}`, existing: false });
    const content = JSON.stringify(stored);
    for (const value of ["First question", "First answer", "Follow-up question", "Follow-up answer", "https://example.com/first", "https://example.com/second"]) expect(content).toContain(value);
    expect(getBlocks).toHaveBeenCalled();
    expect(conversationBlocks(input.exchanges)).toHaveLength(stored.length);
    const replay = await createSynthesisConversation({ ...client, request: async (path: string) => path.endsWith("/query") ? { results: [{ id: pageId }] } : request(path) } as unknown as NotionClient, input);
    expect(replay.existing).toBe(true);
  });

  it("archives only a matching snapshot in the synthesisOS data source", async () => {
    let archived = false;
    const client = {
      getDatabaseDetail: async () => ({ dataSourceId: sourceId }),
      getPage: async () => ({ parent: { data_source_id: sourceId }, properties: { "Document Notes": { rich_text: [{ plain_text: `research_snapshot_id=${input.snapshotId}` }] } }, archived }),
      request: async (_path: string, init: { body: { archived: boolean } }) => { expect(init.body.archived).toBe(true); archived = true; return {}; },
    } as unknown as NotionClient;
    await expect(archiveSynthesisConversation(client, pageId, "33333333-3333-5333-8333-333333333333")).rejects.toThrow("not the requested");
    expect(await archiveSynthesisConversation(client, pageId, input.snapshotId)).toEqual({ archived: true });
  });

  it("rejects incomplete exchanges and oversized pages before a Notion write", async () => {
    const request = vi.fn();
    const client = { request } as unknown as NotionClient;
    await expect(createSynthesisConversation(client, { ...input, exchanges: [{ question: "Incomplete", answer: "", sources: [] }] })).rejects.toThrow("completed");
    await expect(createSynthesisConversation(client, { ...input, exchanges: [{ question: "Large", answer: "A".repeat(1_400_000), sources: [] }] })).rejects.toThrow("too large");
    expect(request).not.toHaveBeenCalled();
  });
});
