import { describe, expect, it } from "vitest";
import { blocksToMarkdown, clampMarkdown, richTextToMarkdown, type NotionBlock } from "./markdown";

const text = (content: string, annotations: Record<string, boolean> = {}, href: string | null = null) => ({
  type: "text",
  plain_text: content,
  href,
  annotations,
});

function block(type: string, rich: unknown[], extra: Record<string, unknown> = {}, children?: NotionBlock[]): NotionBlock {
  return { id: `${type}-${Math.random().toString(36).slice(2, 7)}`, type, [type]: { rich_text: rich, ...extra }, has_children: Boolean(children), children };
}

describe("richTextToMarkdown", () => {
  it("applies annotations and links without swallowing whitespace", () => {
    expect(richTextToMarkdown([text("bold ", { bold: true }), text("plain")])).toBe("**bold** plain");
    expect(richTextToMarkdown([text("code", { code: true })])).toBe("`code`");
    expect(richTextToMarkdown([text("site", {}, "https://example.com")])).toBe("[site](https://example.com)");
    expect(richTextToMarkdown([text("both", { bold: true, italic: true })])).toBe("***both***");
  });
  it("renders page mentions as Notion links", () => {
    expect(richTextToMarkdown([{ type: "mention", plain_text: "Roadmap", mention: { type: "page", page: { id: "11111111-2222-4333-8444-555555555555" } } }])).toBe(
      "[Roadmap](https://www.notion.so/11111111222243338444555555555555)",
    );
  });
});

describe("blocksToMarkdown", () => {
  it("renders headings, lists, todos, quotes, code, and dividers", () => {
    const markdown = blocksToMarkdown([
      block("heading_1", [text("Title")]),
      block("paragraph", [text("Hello ", {}), text("world", { bold: true })]),
      block("bulleted_list_item", [text("one")]),
      block("bulleted_list_item", [text("two")], {}, [block("bulleted_list_item", [text("nested")])]),
      block("numbered_list_item", [text("first")]),
      block("numbered_list_item", [text("second")]),
      block("to_do", [text("done")], { checked: true }),
      block("to_do", [text("open")], { checked: false }),
      block("quote", [text("quoted")]),
      block("callout", [text("note")], { icon: { type: "emoji", emoji: "💡" } }),
      block("code", [text("const a = 1;")], { language: "typescript" }),
      { id: "d", type: "divider", divider: {} },
    ]);
    expect(markdown).toBe(
      [
        "# Title",
        "",
        "Hello **world**",
        "",
        "- one",
        "- two",
        "  - nested",
        "1. first",
        "2. second",
        "- [x] done",
        "- [ ] open",
        "",
        "> quoted",
        "",
        "> 💡 note",
        "",
        "```typescript",
        "const a = 1;",
        "```",
        "",
        "---",
      ].join("\n"),
    );
  });

  it("renders tables and child pages", () => {
    const table: NotionBlock = {
      id: "t",
      type: "table",
      table: { has_column_header: true },
      has_children: true,
      children: [
        { id: "r1", type: "table_row", table_row: { cells: [[text("Name")], [text("Status")]] } },
        { id: "r2", type: "table_row", table_row: { cells: [[text("Draft")], [text("In progress")]] } },
      ],
    };
    const child: NotionBlock = { id: "11111111-2222-4333-8444-555555555555", type: "child_page", child_page: { title: "Roadmap" } };
    expect(blocksToMarkdown([table, child])).toBe(
      ["| Name | Status |", "| --- | --- |", "| Draft | In progress |", "", "📄 [Roadmap](https://www.notion.so/11111111222243338444555555555555)"].join("\n"),
    );
  });

  it("flattens columns and skips unsupported blocks", () => {
    const columns: NotionBlock = {
      id: "cl",
      type: "column_list",
      column_list: {},
      has_children: true,
      children: [
        { id: "c1", type: "column", column: {}, has_children: true, children: [block("paragraph", [text("left")])] },
        { id: "c2", type: "column", column: {}, has_children: true, children: [block("paragraph", [text("right")])] },
      ],
    };
    expect(blocksToMarkdown([columns, { id: "u", type: "unsupported", unsupported: {} }])).toBe("left\n\nright");
  });
});

describe("clampMarkdown", () => {
  it("cuts on a line boundary", () => {
    const result = clampMarkdown("line one\nline two\nline three", 15);
    expect(result).toEqual({ text: "line one", truncated: true });
    expect(clampMarkdown("short", 100)).toEqual({ text: "short", truncated: false });
  });
});
