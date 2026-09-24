import { describe, expect, it } from "vitest";
import { NotionClient, cellOf, normalizeNotionId, summarize } from "./api";

const ID = "11111111-2222-4333-8444-555555555555";

describe("normalizeNotionId", () => {
  it("accepts dashed and undashed ids and Notion URLs", () => {
    expect(normalizeNotionId(ID)).toBe(ID);
    expect(normalizeNotionId(ID.replace(/-/g, ""))).toBe(ID);
    expect(normalizeNotionId("https://www.notion.so/Roadmap-11111111222243338444555555555555?v=abc")).toBe(ID);
    expect(normalizeNotionId("https://app.notion.com/p/11111111222243338444555555555555?pvs=204")).toBe(ID);
    expect(normalizeNotionId("https://www.notion.so/ws/Some-page-bbbbbbbbccccddddeeeeffffffffffff?p=11111111222243338444555555555555&pm=s")).toBe(ID);
    expect(normalizeNotionId("nonsense")).toBeNull();
  });
});

describe("cellOf", () => {
  it("flattens common property types", () => {
    expect(cellOf("Status", { type: "status", status: { name: "Done" } }).text).toBe("Done");
    expect(cellOf("Tags", { type: "multi_select", multi_select: [{ name: "Sales" }, { name: "ML" }] }).values).toEqual(["Sales", "ML"]);
    expect(cellOf("Workout", { type: "checkbox", checkbox: true })).toMatchObject({ checked: true, text: "Yes" });
    expect(cellOf("Date", { type: "date", date: { start: "2026-09-02", end: null } }).text).toBe("2026-09-02");
    expect(cellOf("URL", { type: "url", url: "https://x.y" }).href).toBe("https://x.y");
    expect(cellOf("Name", { type: "title", title: [{ type: "text", plain_text: "Day", annotations: {} }] }).text).toBe("Day");
  });
});

describe("NotionClient", () => {
  it("sends the auth headers and falls back from page to database", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes("/pages/")) return new Response(JSON.stringify({ object: "error", status: 404, code: "object_not_found", message: "nope" }), { status: 404 });
      return new Response(JSON.stringify({ object: "database", id: ID, title: [{ plain_text: "Roadmap" }], icon: { type: "emoji", emoji: "🎲" }, url: "https://www.notion.so/x" }), { status: 200 });
    };
    const client = new NotionClient("secret", { fetch: fetchImpl });
    const summary = await client.getSummary(ID);
    expect(summary).toMatchObject({ id: ID, kind: "database", title: "Roadmap", icon: { kind: "emoji", value: "🎲" } });
    expect(calls[0]!.headers.Authorization).toBe("Bearer secret");
    expect(calls[0]!.headers["Notion-Version"]).toBe("2025-09-03");
    expect(calls.map((call) => call.url)).toEqual([`https://api.notion.com/v1/pages/${ID}`, `https://api.notion.com/v1/databases/${ID}`]);
  });

  it("summarizes data_source search hits as their database", () => {
    expect(summarize({ object: "data_source", id: "ds", title: [{ plain_text: "Habits" }], parent: { database_id: "db1" } })).toMatchObject({ id: "db1", kind: "database", title: "Habits" });
    expect(summarize({ object: "user", id: "u" })).toBeNull();
  });
});
