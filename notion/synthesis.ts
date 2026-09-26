import type { NotionClient } from "./api";

export const SYNTHESIS_DATABASE_ID = "4efbff21-115b-83e0-ac9d-0171b44f0252";

export interface SynthesisResearchInput {
  quickSearchId: string;
  question: string;
  answer: string;
  sources: { url: string; title: string }[];
  mode: string;
  model: string | null;
  backendUuid: string | null;
}

function chunks(text: string, size = 1_800): string[] {
  const chars = Array.from(text);
  const parts: string[] = [];
  for (let index = 0; index < chars.length; index += size) parts.push(chars.slice(index, index + size).join(""));
  return parts;
}

function paragraph(text: string, url?: string) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text, ...(url ? { link: { url } } : {}) } }] } };
}

export async function createSynthesisResearch(client: NotionClient, input: SynthesisResearchInput): Promise<{ id: string; url: string; existing: boolean }> {
  const database = await client.getDatabaseDetail(SYNTHESIS_DATABASE_ID, { limit: 1 });
  const sourceId = database.dataSourceId;
  if (!sourceId || !database.columns.some((column) => column.name === "Title" && column.type === "title") || !database.columns.some((column) => column.name === "Document Notes" && column.type === "rich_text")) {
    throw new Error("The synthesisOS Notion database schema is unavailable or has changed.");
  }

  const marker = `quick_search_id=${input.quickSearchId}`;
  const prior = await client.request<{ results?: { id: string; url?: string }[] }>(`/data_sources/${sourceId}/query`, {
    method: "POST",
    body: { page_size: 1, filter: { property: "Document Notes", rich_text: { contains: marker } } },
  });
  if (prior.results?.[0]?.id) return { id: prior.results[0].id, url: prior.results[0].url ?? `https://www.notion.so/${prior.results[0].id.replace(/-/g, "")}`, existing: true };

  const answerBlocks = chunks(input.answer).map((part) => paragraph(part));
  const blocks: Record<string, unknown>[] = [...answerBlocks];
  if (input.sources.length) {
    blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Sources" } }] } });
    for (const source of input.sources) blocks.push(paragraph(source.title.slice(0, 1_800) || source.url, source.url));
  }
  const provenance = `${marker}; backend_uuid=${input.backendUuid ?? "unavailable"}; mode=${input.mode}; actual_model=${input.model ?? "unverified"}; source_count=${input.sources.length}`;
  const create = await client.request<{ id: string; url?: string }>("/pages", {
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: sourceId },
      properties: {
        Title: { title: [{ text: { content: input.question.slice(0, 500) } }] },
        "Document Notes": { rich_text: [{ text: { content: provenance } }] },
        Summary: { rich_text: [{ text: { content: Array.from(input.answer).slice(0, 500).join("") } }] },
        Author: { rich_text: [{ text: { content: "Perplexity via synthesisOS" } }] },
        Category: { select: { name: "Articles" } },
        "Full Title": { rich_text: [{ text: { content: input.question.slice(0, 1_800) } }] },
      },
      children: blocks.slice(0, 100),
    },
  });
  for (let index = 100; index < blocks.length; index += 100) {
    await client.request(`/blocks/${create.id}/children`, { method: "PATCH", body: { children: blocks.slice(index, index + 100) } });
  }
  const page = await client.getPage(create.id);
  const parent = (page.parent ?? {}) as Record<string, unknown>;
  if (parent.data_source_id !== sourceId) throw new Error(`Created Notion page ${create.id}, but its parent could not be verified.`);
  const { blocks: savedBlocks, truncated } = await client.getBlocks(create.id);
  const returnedAnswer = savedBlocks.slice(0, answerBlocks.length).map((block) => {
    const value = block.paragraph as { rich_text?: { plain_text?: string; text?: { content?: string } }[] } | undefined;
    return (value?.rich_text ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("");
  }).join("");
  if (truncated || returnedAnswer !== input.answer || savedBlocks.length < blocks.length) {
    throw new Error(`Created Notion page ${create.id}, but the complete answer could not be read back. Retry Save to inspect the existing page.`);
  }
  return { id: create.id, url: typeof page.url === "string" ? page.url : create.url ?? `https://www.notion.so/${create.id.replace(/-/g, "")}`, existing: false };
}

/** Archive only a page carrying the caller's quick-search marker in this data source. */
export async function archiveSynthesisResearch(client: NotionClient, id: string, quickSearchId: string): Promise<{ archived: true }> {
  const database = await client.getDatabaseDetail(SYNTHESIS_DATABASE_ID, { limit: 1 });
  const page = await client.getPage(id);
  const parent = (page.parent ?? {}) as Record<string, unknown>;
  const notes = JSON.stringify((page.properties as Record<string, unknown> | undefined)?.["Document Notes"] ?? {});
  if (!database.dataSourceId || parent.data_source_id !== database.dataSourceId || !notes.includes(`quick_search_id=${quickSearchId}`)) {
    throw new Error("The page is not the requested synthesisOS quick search.");
  }
  await client.request(`/pages/${id}`, { method: "PATCH", body: { archived: true } });
  const verified = await client.getPage(id);
  if (verified.archived !== true) throw new Error("Notion did not confirm that the quick-search page was archived.");
  return { archived: true };
}
