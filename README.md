# alphaOS Notion

Notion, rendered natively inside [bb](https://getbb.app), the agentic IDE.
Your pages and databases open in bb's own UI and theme instead of a browser
tab, and your agents can read them, cite them, and hand them back to you as
cards.

Free and open source (MIT). Landing page:
<https://briandecoded.com/alphaos-notion/>

## What it adds

- **A "Notion" sidebar page.** Pinned pages, recents, and workspace search on
  the left; the page or database opens in the right pane, drawn with bb's own
  Markdown renderer. Links between Notion pages stay inside the pane, with back
  and forward.
- **Databases as tables.** Title first, then the columns that have data. Click a
  row to open it.
- **Inline cards.** Agents write `::notion{id="…" title="…"}` in a reply and bb
  renders a card that opens the page in the viewer. The bundled skill teaches
  agents to do this.
- **@-mentions.** Type `@` in the composer, pick a Notion page, and its content
  is attached as context when you send. An empty `@` lists your pins.
- **Agent tools.** `notion_search` and `notion_read`, plus a CLI:

```
bb notion status                 # connection + pinned pages
bb notion search <query>
bb notion read <id-or-url> [--refresh]
bb notion pins
bb notion pin <id-or-url> [label]
bb notion unpin <id>
```

The viewer remains read-only and its "Open in Notion" button hands off for
editing. One scoped backend RPC, `synthesis_create`, lets the standalone
[synthesisOS plugin](https://github.com/alphaefficiency-dev/bb-plugin-synthesisos)
save an explicitly chosen Perplexity answer to Brian's synthesisOS database.
It validates the live data-source schema, checks the quick-search ID for an
existing row, writes the complete answer and linked sources, then reads the
page back before reporting success. A matching `synthesis_archive` method can
archive a quick-search page only when its marker and database parent match.
These methods do not expose a general Notion editor or change the read-only viewer.

## Install

Requires bb 0.41 or newer.

```
bb plugin install git:https://github.com/briandecoded/alphaos-notion
```

Then connect it to Notion:

1. Create an internal integration at <https://www.notion.so/my-integrations>.
   The **Read content** capability is enough.
2. In Notion, open each top-level page you want visible → `…` → Connections →
   add the integration. Child pages inherit the share.
3. Paste the integration secret in bb under **Extensions → Plugins → alphaOS
   Notion**, or run `bb plugin config notion set notionApiKey <secret>`.
4. Run `bb notion status` to confirm the connection, then pin your most-used
   pages with `bb notion pin <url>` or the pin button on the sidebar page.

The token is stored as a bb secret setting on your machine. It is never sent
anywhere except `api.notion.com`.

## Develop

```
npm install
npm run check      # typecheck + tests + SDK pin check
bb plugin install .
bb plugin dev      # rebuild and reload on save
```

## License

MIT © Brian Decoded
