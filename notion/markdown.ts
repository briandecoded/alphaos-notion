// Notion blocks → Markdown that bb's own chat renderer draws natively.
// Pure functions: no fetch, no bb API, unit-testable on their own.

export interface NotionRichText {
  type?: string;
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
  equation?: { expression?: string };
  mention?: { type?: string; page?: { id?: string }; database?: { id?: string }; date?: { start?: string; end?: string | null } };
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  /** Filled in by the fetcher when it recursed into `has_children`. */
  children?: NotionBlock[];
  [key: string]: unknown;
}

type Payload = Record<string, unknown>;

/** Canonical https link for a Notion object id (dashed or not). */
export function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

export function richTextToMarkdown(items: NotionRichText[] | undefined | null): string {
  if (!items || items.length === 0) return "";
  return items
    .map((item) => {
      let text = item.plain_text ?? "";
      if (item.type === "equation" && item.equation?.expression) return `$${item.equation.expression}$`;
      if (item.type === "mention" && item.mention) {
        const mention = item.mention;
        if (mention.type === "page" && mention.page?.id) return `[${text || "page"}](${notionUrl(mention.page.id)})`;
        if (mention.type === "database" && mention.database?.id) return `[${text || "database"}](${notionUrl(mention.database.id)})`;
        if (mention.type === "date" && mention.date?.start) {
          return mention.date.end ? `${mention.date.start} → ${mention.date.end}` : mention.date.start;
        }
      }
      if (text === "") return "";
      const a = item.annotations ?? {};
      if (a.code) text = `\`${text}\``;
      else {
        // Preserve leading/trailing whitespace outside the emphasis markers so
        // "**bold **text" never happens.
        const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
        const lead = match?.[1] ?? "";
        const core = match?.[2] ?? text;
        const trail = match?.[3] ?? "";
        let wrapped = core;
        if (core !== "") {
          if (a.bold) wrapped = `**${wrapped}**`;
          if (a.italic) wrapped = `*${wrapped}*`;
          if (a.strikethrough) wrapped = `~~${wrapped}~~`;
        }
        text = `${lead}${wrapped}${trail}`;
      }
      if (item.href) text = `[${text}](${item.href})`;
      return text;
    })
    .join("");
}

function payload(block: NotionBlock): Payload {
  const value = block[block.type];
  return value && typeof value === "object" ? (value as Payload) : {};
}

function richOf(block: NotionBlock, key = "rich_text"): string {
  return richTextToMarkdown(payload(block)[key] as NotionRichText[] | undefined);
}

function fileUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Payload;
  const inner = (record.file ?? record.external) as Payload | undefined;
  const url = inner?.url;
  return typeof url === "string" ? url : null;
}

function captionOf(block: NotionBlock): string {
  return richTextToMarkdown(payload(block).caption as NotionRichText[] | undefined);
}

function indent(text: string, spaces: number): string {
  if (text === "") return "";
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line === "" ? line : pad + line))
    .join("\n");
}

function iconText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const icon = value as Payload;
  if (icon.type === "emoji" && typeof icon.emoji === "string") return icon.emoji;
  return "";
}

function tableToMarkdown(block: NotionBlock): string {
  const rows = block.children ?? [];
  const hasHeader = Boolean(payload(block).has_column_header);
  const lines: string[] = [];
  const cellsOf = (row: NotionBlock): string[] => {
    const cells = payload(row).cells;
    if (!Array.isArray(cells)) return [];
    return cells.map((cell) => richTextToMarkdown(cell as NotionRichText[]).replace(/\|/g, "\\|").replace(/\n/g, " "));
  };
  const matrix = rows.filter((row) => row.type === "table_row").map(cellsOf);
  if (matrix.length === 0) return "";
  const width = Math.max(...matrix.map((row) => row.length), 1);
  const normalize = (row: string[]) => Array.from({ length: width }, (_, index) => row[index] ?? "");
  const header = hasHeader ? normalize(matrix[0]!) : Array.from({ length: width }, () => "");
  const body = hasHeader ? matrix.slice(1) : matrix;
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of body) lines.push(`| ${normalize(row).join(" | ")} |`);
  return lines.join("\n");
}

interface ConvertOptions {
  /** Nesting depth; list children indent by two spaces per level. */
  depth?: number;
}

/** Convert a block list (with fetched `children`) to Markdown. */
export function blocksToMarkdown(blocks: NotionBlock[], options: ConvertOptions = {}): string {
  const depth = options.depth ?? 0;
  const parts: string[] = [];
  let numbered = 0;

  const childrenMarkdown = (block: NotionBlock, nestedDepth: number): string =>
    block.children && block.children.length > 0 ? blocksToMarkdown(block.children, { depth: nestedDepth }) : "";

  for (const block of blocks) {
    if (block.type !== "numbered_list_item") numbered = 0;
    let text = "";
    switch (block.type) {
      case "paragraph":
        text = richOf(block);
        {
          const nested = childrenMarkdown(block, depth + 1);
          if (nested) text = `${text}\n\n${indent(nested, 2)}`;
        }
        break;
      case "heading_1":
      case "heading_2":
      case "heading_3": {
        const level = block.type === "heading_1" ? "#" : block.type === "heading_2" ? "##" : "###";
        text = `${level} ${richOf(block)}`;
        const nested = childrenMarkdown(block, depth);
        if (nested) text = `${text}\n\n${nested}`;
        break;
      }
      case "bulleted_list_item": {
        text = `- ${richOf(block)}`;
        const nested = childrenMarkdown(block, depth + 1);
        if (nested) text = `${text}\n${indent(nested, 2)}`;
        break;
      }
      case "numbered_list_item": {
        numbered += 1;
        text = `${numbered}. ${richOf(block)}`;
        const nested = childrenMarkdown(block, depth + 1);
        if (nested) text = `${text}\n${indent(nested, 3)}`;
        break;
      }
      case "to_do": {
        const checked = Boolean(payload(block).checked);
        text = `- [${checked ? "x" : " "}] ${richOf(block)}`;
        const nested = childrenMarkdown(block, depth + 1);
        if (nested) text = `${text}\n${indent(nested, 2)}`;
        break;
      }
      case "toggle": {
        text = `▸ **${richOf(block)}**`;
        const nested = childrenMarkdown(block, depth + 1);
        if (nested) text = `${text}\n\n${indent(nested, 2)}`;
        break;
      }
      case "quote": {
        const nested = childrenMarkdown(block, depth);
        const body = nested ? `${richOf(block)}\n\n${nested}` : richOf(block);
        text = body
          .split("\n")
          .map((line) => (line === "" ? ">" : `> ${line}`))
          .join("\n");
        break;
      }
      case "callout": {
        const icon = iconText(payload(block).icon);
        const nested = childrenMarkdown(block, depth);
        const body = nested ? `${richOf(block)}\n\n${nested}` : richOf(block);
        const lines = body.split("\n");
        text = lines
          .map((line, index) => {
            if (index === 0) return `> ${icon ? `${icon} ` : ""}${line}`;
            return line === "" ? ">" : `> ${line}`;
          })
          .join("\n");
        break;
      }
      case "code": {
        const language = typeof payload(block).language === "string" ? (payload(block).language as string) : "";
        const fence = language === "plain text" ? "" : language;
        text = `\`\`\`${fence}\n${richOf(block)}\n\`\`\``;
        const caption = captionOf(block);
        if (caption) text = `${text}\n\n*${caption}*`;
        break;
      }
      case "divider":
        text = "---";
        break;
      case "image": {
        const url = fileUrl(payload(block));
        const caption = captionOf(block);
        text = url ? `![${caption || "image"}](${url})` : "";
        if (url && caption) text = `${text}\n\n*${caption}*`;
        break;
      }
      case "video":
      case "audio":
      case "file":
      case "pdf": {
        const url = fileUrl(payload(block));
        const name = typeof payload(block).name === "string" ? (payload(block).name as string) : block.type;
        const caption = captionOf(block);
        text = url ? `📎 [${caption || name}](${url})` : "";
        break;
      }
      case "embed":
      case "bookmark":
      case "link_preview": {
        const url = typeof payload(block).url === "string" ? (payload(block).url as string) : "";
        const caption = captionOf(block);
        text = url ? `🔗 [${caption || url}](${url})` : "";
        break;
      }
      case "equation": {
        const expression = typeof payload(block).expression === "string" ? (payload(block).expression as string) : "";
        text = expression ? `$$\n${expression}\n$$` : "";
        break;
      }
      case "table":
        text = tableToMarkdown(block);
        break;
      case "table_row":
        // Rendered by the parent table.
        text = "";
        break;
      case "column_list":
      case "column":
      case "synced_block":
      case "template":
        text = childrenMarkdown(block, depth);
        break;
      case "child_page": {
        const title = typeof payload(block).title === "string" ? (payload(block).title as string) : "Untitled";
        text = `📄 [${title}](${notionUrl(block.id)})`;
        break;
      }
      case "child_database": {
        const title = typeof payload(block).title === "string" ? (payload(block).title as string) : "Untitled database";
        text = `🗂️ [${title}](${notionUrl(block.id)})`;
        break;
      }
      case "link_to_page": {
        const link = payload(block);
        const id = typeof link.page_id === "string" ? link.page_id : typeof link.database_id === "string" ? link.database_id : null;
        text = id ? `↗ [Linked page](${notionUrl(id)})` : "";
        break;
      }
      case "table_of_contents":
      case "breadcrumb":
      case "unsupported":
        text = "";
        break;
      default:
        text = richOf(block);
        break;
    }
    if (text !== "") parts.push(text);
  }

  // Tight lists: consecutive list items join with one newline, everything else
  // with a blank line.
  let output = "";
  let previousWasList = false;
  for (const part of parts) {
    const isList = /^(\s*)([-*]|\d+\.)\s/.test(part);
    if (output === "") output = part;
    else output += (previousWasList && isList ? "\n" : "\n\n") + part;
    previousWasList = isList;
  }
  return output;
}

/** Trim markdown to a byte budget without cutting inside a line. */
export function clampMarkdown(markdown: string, maxChars: number): { text: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { text: markdown, truncated: false };
  const cut = markdown.lastIndexOf("\n", maxChars);
  return { text: markdown.slice(0, cut > maxChars / 2 ? cut : maxChars), truncated: true };
}
