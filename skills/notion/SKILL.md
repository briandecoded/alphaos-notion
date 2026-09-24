---
name: notion
description: Read, search, and reference the user's Notion workspace with the notion_search / notion_read tools or the `bb notion` CLI, and show pages as inline cards. Use whenever the user mentions a Notion page or database, one of their pinned Notion pages by name, or asks what is in Notion.
---

# Notion

The alphaOS Notion plugin gives you the user's Notion workspace through an
internal integration. Anything the integration is shared with can be read;
nothing is written.

## Reading

Prefer the native tools when they are in your tool set:

| Tool | Use |
| --- | --- |
| `notion_search` | Find pages/databases by keyword. Returns ids, kinds, URLs. |
| `notion_read` | Page → Markdown. Database → table of the most recent rows. Pass an id or a notion.so URL; `refresh: true` bypasses the cache. |

The same operations exist as CLI commands for shells and scripts:

```
bb notion status                 # connection + pinned pages
bb notion search <query> [--json]
bb notion read <id-or-url> [--refresh] [--json]
bb notion pins [--json]
bb notion pin <id-or-url> [label]
bb notion unpin <id>
```

`bb notion status` lists the pinned pages with their ids. When the user names
one of their pinned pages, use that id directly instead of searching.

## Referencing a page in a reply

Put a card in your answer so the user can open the page natively in bb:

```
::notion{id="<page-id>" title="Roadmap"}
```

Rules: the directive goes on its own line, outside code blocks; `id` is the
dashed or undashed page id (a full notion.so URL also works); `title` is a
short fallback label. Add one card per distinct page you cite, not per
sentence. A plain notion.so link opens in a browser, so use the card for any
page the user may want to read.

## When a page is not readable

A 404 from Notion almost always means the page is not shared with the
integration. Tell the user to open the page in Notion → `…` → Connections →
add the integration, then retry with `refresh: true`.
