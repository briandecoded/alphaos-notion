import type { NotionClient } from "./api";
import { SYNTHESIS_DATABASE_ID } from "./synthesis";

export interface ConversationExchange {
  question: string;
  answer: string;
  sources: { url: string; title: string }[];
}
export interface SynthesisConversationInput {
  snapshotId: string;
  threadId: string;
  title: string;
  exchanges: ConversationExchange[];
}

type Block = Record<string, unknown>;
const text = (content: string, url?: string) => ({ type: "text", text: { content, ...(url ? { link: { url } } : {}) } });
const paragraph = (content: string, url?: string): Block => ({ object: "block", type: "paragraph", paragraph: { rich_text: [text(content, url)] } });
const heading = (content: string, level: 2 | 3): Block => ({ object: "block", type: `heading_${level}`, [`heading_${level}`]: { rich_text: [text(content)] } });
const chunks = (value: string): string[] => { const chars = Array.from(value); const out: string[] = []; for (let i = 0; i < chars.length; i += 1800) out.push(chars.slice(i, i + 1800).join("")); return out; };

export function conversationBlocks(exchanges: ConversationExchange[]): Block[] {
  const blocks: Block[] = [];
  for (const [index, exchange] of exchanges.entries()) {
    blocks.push(heading(`Question ${index + 1}`, 2));
    blocks.push(...chunks(exchange.question).map((part) => paragraph(part)));
    blocks.push(heading("Answer", 3));
    blocks.push(...chunks(exchange.answer).map((part) => paragraph(part)));
    if (exchange.sources.length) {
      blocks.push(heading(`Sources (${exchange.sources.length})`, 3));
      for (const source of exchange.sources) blocks.push(paragraph((source.title || source.url).slice(0, 1800), source.url));
    }
  }
  return blocks;
}

function comparableUrl(value: string | null) {
  if (!value) return null;
  const parsed = new URL(value);
  // Notion rewrites bare query flags (for example ?preview) to ?preview=.
  parsed.search = parsed.searchParams.toString();
  return parsed.toString();
}

function blockValue(block: Block) {
  const type = String(block.type ?? "");
  const item = block[type] as { rich_text?: { plain_text?: string; text?: { content?: string; link?: { url?: string } }; href?: string }[] } | undefined;
  const rich = item?.rich_text ?? [];
  return { type, parts: rich.map((entry) => ({ content: entry.plain_text ?? entry.text?.content ?? "", url: comparableUrl(entry.text?.link?.url ?? entry.href ?? null) })) };
}

async function verifyPage(client: NotionClient, pageId: string, sourceId: string, blocks: Block[]) {
  const page = await client.getPage(pageId);
  const parent = (page.parent ?? {}) as Record<string, unknown>;
  if (parent.data_source_id !== sourceId) throw new Error("The Notion page is outside the synthesisOS data source.");
  const read = await client.getBlocks(pageId);
  if (read.truncated) throw new Error("Notion returned an incomplete conversation page.");
  const existing = read.blocks.map((block) => blockValue(block as Block));
  const expected = blocks.map(blockValue);
  if (existing.length > expected.length || existing.some((value, index) => JSON.stringify(value) !== JSON.stringify(expected[index]))) {
    throw new Error("The existing Notion snapshot differs from this conversation. No content was overwritten.");
  }
  for (let index = existing.length; index < blocks.length; index += 100) {
    await client.request(`/blocks/${pageId}/children`, { method: "PATCH", body: { children: blocks.slice(index, index + 100) } });
  }
  if (existing.length !== expected.length) {
    const after = await client.getBlocks(pageId);
    if (after.truncated || after.blocks.length !== expected.length || after.blocks.some((block, index) => JSON.stringify(blockValue(block as Block)) !== JSON.stringify(expected[index]))) {
      throw new Error("Notion did not return the full saved conversation.");
    }
  }
  return page;
}

/** One idempotent, read-back-verified snapshot of a complete research conversation. */
export async function createSynthesisConversation(client: NotionClient, input: SynthesisConversationInput) {
  if (!input.exchanges.length || input.exchanges.some((item) => !item.question || !item.answer)) throw new Error("Only completed research exchanges can be saved to Notion.");
  const blocks = conversationBlocks(input.exchanges);
  if (blocks.length > 750) throw new Error("The conversation is too large to verify in one Notion page. Nothing was saved.");
  const database = await client.getDatabaseDetail(SYNTHESIS_DATABASE_ID, { limit: 1 });
  const sourceId = database.dataSourceId;
  if (!sourceId || !database.columns.some((column) => column.name === "Title" && column.type === "title") || !database.columns.some((column) => column.name === "Document Notes" && column.type === "rich_text")) {
    throw new Error("The synthesisOS Notion database schema is unavailable or has changed.");
  }
  const marker = `research_snapshot_id=${input.snapshotId}`;
  const prior = await client.request<{ results?: { id: string; url?: string }[] }>(`/data_sources/${sourceId}/query`, {
    method: "POST", body: { page_size: 1, filter: { property: "Document Notes", rich_text: { contains: marker } } },
  });
  const found = prior.results?.[0];
  if (found) {
    const page = await verifyPage(client, found.id, sourceId, blocks);
    return { id: found.id, url: typeof page.url === "string" ? page.url : found.url ?? `https://www.notion.so/${found.id.replace(/-/g, "")}`, existing: true };
  }
  const lastAnswer = input.exchanges.at(-1)!.answer;
  const created = await client.request<{ id: string; url?: string }>("/pages", {
    method: "POST", body: {
      parent: { type: "data_source_id", data_source_id: sourceId },
      properties: {
        Title: { title: [text(input.title.slice(0, 500))] },
        "Document Notes": { rich_text: [text(`${marker}; alphaos_thread_id=${input.threadId}; exchange_count=${input.exchanges.length}`)] },
        Summary: { rich_text: [text(Array.from(lastAnswer).slice(0, 500).join(""))] },
        Author: { rich_text: [text("Perplexity via synthesisOS")] },
        Category: { select: { name: "Articles" } },
        "Full Title": { rich_text: [text(input.title.slice(0, 1800))] },
      },
      children: blocks.slice(0, 100),
    },
  });
  const page = await verifyPage(client, created.id, sourceId, blocks);
  return { id: created.id, url: typeof page.url === "string" ? page.url : created.url ?? `https://www.notion.so/${created.id.replace(/-/g, "")}`, existing: false };
}

/** Archive only a matching research snapshot in the synthesisOS data source. */
export async function archiveSynthesisConversation(client: NotionClient, id: string, snapshotId: string): Promise<{ archived: true }> {
  const database = await client.getDatabaseDetail(SYNTHESIS_DATABASE_ID, { limit: 1 });
  const page = await client.getPage(id);
  const parent = (page.parent ?? {}) as Record<string, unknown>;
  const notes = JSON.stringify((page.properties as Record<string, unknown> | undefined)?.["Document Notes"] ?? {});
  if (!database.dataSourceId || parent.data_source_id !== database.dataSourceId || !notes.includes(`research_snapshot_id=${snapshotId}`)) {
    throw new Error("The page is not the requested synthesisOS conversation snapshot.");
  }
  await client.request(`/pages/${id}`, { method: "PATCH", body: { archived: true } });
  const verified = await client.getPage(id);
  if (verified.archived !== true) throw new Error("Notion did not confirm that the conversation snapshot was archived.");
  return { archived: true };
}
