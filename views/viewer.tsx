// The native Notion viewer: a page rendered through bb's own Markdown
// component, or a database as a table. Keeps its own back/forward history so
// links between Notion pages stay inside the pane.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Markdown, UrlLink, useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Cell, DatabaseDetail, PageDetail, Summary } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { EmptyState, IconGlyph, NotionLinkScope, Spinner, formatWhen, useLatest, useNotionRpc } from "./shared";

type Loaded = { kind: "page"; page: PageDetail; fetchedAt: string } | { kind: "database"; database: DatabaseDetail; fetchedAt: string };

export interface NotionViewerProps {
  rootId: string;
  /** Called when the user leaves the viewer (e.g. back to the browser list). */
  onExit?: () => void;
  exitLabel?: string;
  /** Open the current object in a sibling tab, when the surface supports it. */
  onOpenInNewTab?: (summary: Summary) => void;
  className?: string;
}

export function NotionViewer({ rootId, onExit, exitLabel = "Back", onOpenInNewTab, className }: NotionViewerProps) {
  const rpc = useNotionRpc();
  const [history, setHistory] = useState<{ stack: string[]; index: number }>({ stack: [rootId], index: 0 });
  const currentId = history.stack[history.index]!;
  const loader = useLatest<Loaded>();
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    setHistory({ stack: [rootId], index: 0 });
  }, [rootId]);

  const load = useCallback(
    (id: string, refresh: boolean) => {
      loader.run(
        async () => {
          const resolved = await rpc.call("resolve", { input: id });
          setSummary(resolved);
          void rpc.call("recents_touch", resolved).catch(() => undefined);
          if (resolved.kind === "database") {
            const result = await rpc.call("database_get", { id: resolved.id, refresh });
            return { kind: "database", database: result.database, fetchedAt: result.fetchedAt };
          }
          const result = await rpc.call("page_get", { id: resolved.id, refresh });
          return { kind: "page", page: result.page, fetchedAt: result.fetchedAt };
        },
        { keepValue: refresh },
      );
    },
    [rpc, loader.run],
  );

  useEffect(() => {
    setSummary(null);
    load(currentId, false);
  }, [currentId, load]);

  const navigate = useCallback((id: string) => {
    setHistory((previous) => {
      if (previous.stack[previous.index] === id) return previous;
      const stack = [...previous.stack.slice(0, previous.index + 1), id];
      return { stack, index: stack.length - 1 };
    });
  }, []);
  const canBack = history.index > 0;
  const canForward = history.index < history.stack.length - 1;

  const composer = useComposer();
  const addToChat = useCallback(() => {
    if (!summary) return;
    try {
      composer.insertMention({ provider: "page", id: summary.id, label: summary.title });
      toast.success(`Added ${summary.title} to the chat draft`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }, [composer, summary]);

  const title = summary?.title ?? (loader.value?.kind === "page" ? loader.value.page.title : loader.value?.database.title) ?? "";
  const icon = summary?.icon ?? null;
  const url = summary?.url ?? `https://www.notion.so/${currentId.replace(/-/g, "")}`;
  const parentTitle = loader.value?.kind === "page" ? loader.value.page.parentTitle : summary?.parentTitle ?? null;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {onExit ? (
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground" onClick={onExit} aria-label={exitLabel}>
            <Icon name="ChevronLeft" className="size-4" />
            <span className="hidden sm:inline">{exitLabel}</span>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={!canBack}
          onClick={() => setHistory((previous) => ({ ...previous, index: Math.max(0, previous.index - 1) }))}
          aria-label="Previous page"
        >
          <Icon name="ChevronLeft" className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          disabled={!canForward}
          onClick={() => setHistory((previous) => ({ ...previous, index: Math.min(previous.stack.length - 1, previous.index + 1) }))}
          aria-label="Next page"
        >
          <Icon name="ChevronRight" className="size-4" />
        </Button>
        <div className="min-w-0 flex-1 truncate px-1 text-sm">
          {parentTitle ? <span className="text-muted-foreground">{parentTitle} / </span> : null}
          <span className="font-medium text-foreground">{title}</span>
        </div>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={addToChat} disabled={!summary} aria-label="Add to chat as @-mention">
          <Icon name="MessageSquarePlus" className="size-4" />
        </Button>
        {onOpenInNewTab && summary ? (
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => onOpenInNewTab(summary)} aria-label="Open in a new tab">
            <Icon name="SectionAdd" className="size-4" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={() => load(currentId, true)}
          disabled={loader.status === "loading"}
          aria-label="Refresh from Notion"
        >
          <Icon name="Loading" className={cn("size-4", loader.status === "loading" && "animate-spin")} />
        </Button>
        <UrlLink
          href={url}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Open in Notion"
          title="Open in Notion"
        >
          <Icon name="FolderExport" className="size-4" />
        </UrlLink>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loader.status === "error" && loader.value === null ? (
          <div className="p-4">
            <EmptyState>
              <p className="text-destructive">{loader.error}</p>
              <p className="mt-2">
                Make sure the page is shared with the integration, or{" "}
                <UrlLink href={url} className="underline">
                  open it in Notion
                </UrlLink>
                .
              </p>
            </EmptyState>
          </div>
        ) : loader.value === null ? (
          <div className="p-4">
            <Spinner label="Loading from Notion…" />
          </div>
        ) : loader.value.kind === "page" ? (
          <PageBody page={loader.value.page} icon={icon} fetchedAt={loader.value.fetchedAt} onNavigate={navigate} stale={loader.status === "error" ? loader.error : null} />
        ) : (
          <DatabaseBody database={loader.value.database} icon={icon} fetchedAt={loader.value.fetchedAt} onNavigate={navigate} stale={loader.status === "error" ? loader.error : null} />
        )}
      </div>
    </div>
  );
}

function StaleNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      Showing the cached copy. Refresh failed: {message}
    </p>
  );
}

function PageBody({ page, icon, fetchedAt, onNavigate, stale }: { page: PageDetail; icon: Summary["icon"]; fetchedAt: string; onNavigate: (id: string) => void; stale: string | null }) {
  const shownProperties = page.properties.filter((cell) => cell.text !== "" || cell.checked !== null);
  return (
    <article className="mx-auto w-full max-w-3xl px-5 pb-10 pt-5">
      <StaleNotice message={stale} />
      <div className="mb-4 flex items-start gap-3">
        <IconGlyph icon={icon ?? page.icon} kind="page" className="mt-0.5 size-9 text-3xl" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold leading-tight text-foreground">{page.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {page.lastEditedAt ? `Edited ${formatWhen(page.lastEditedAt)}` : null}
            {page.lastEditedAt ? " · " : null}
            Synced {formatWhen(fetchedAt)}
          </p>
        </div>
      </div>
      {shownProperties.length > 0 ? (
        <dl className="mb-6 grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border bg-card px-4 py-3 text-sm">
          {shownProperties.map((cell) => (
            <PropertyRow key={cell.name} cell={cell} />
          ))}
        </dl>
      ) : null}
      {page.markdown === "" ? (
        <EmptyState>This page has no content yet.</EmptyState>
      ) : (
        <NotionLinkScope onNavigate={onNavigate}>
          <Markdown content={page.markdown} />
        </NotionLinkScope>
      )}
      {page.truncated ? <p className="mt-6 text-xs text-muted-foreground">This page is longer than the fetch budget; open it in Notion for the rest.</p> : null}
    </article>
  );
}

function PropertyRow({ cell }: { cell: Cell }) {
  return (
    <>
      <dt className="truncate text-muted-foreground">{cell.name}</dt>
      <dd className="min-w-0">
        <CellValue cell={cell} />
      </dd>
    </>
  );
}

function CellValue({ cell }: { cell: Cell }) {
  if (cell.type === "checkbox") {
    return (
      <span className={cn("inline-flex items-center gap-1", cell.checked ? "text-foreground" : "text-muted-foreground")}>
        <Icon name={cell.checked ? "CircleCheck" : "Circle"} className="size-4" />
        <span className="sr-only">{cell.checked ? "Yes" : "No"}</span>
      </span>
    );
  }
  if (cell.values.length > 0 && (cell.type === "multi_select" || cell.type === "people" || cell.type === "files")) {
    return (
      <span className="flex flex-wrap gap-1">
        {cell.values.map((value) => (
          <span key={value} className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground">
            {value}
          </span>
        ))}
      </span>
    );
  }
  if (cell.type === "select" || cell.type === "status") {
    return cell.text ? <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground">{cell.text}</span> : <span className="text-muted-foreground">—</span>;
  }
  if (cell.href) {
    return (
      <UrlLink href={cell.href} className="truncate text-foreground underline decoration-muted-foreground/50 underline-offset-2">
        {cell.text}
      </UrlLink>
    );
  }
  if (cell.type === "created_time" || cell.type === "last_edited_time") return <span>{formatWhen(cell.text) || cell.text}</span>;
  return cell.text ? <span className="break-words">{cell.text}</span> : <span className="text-muted-foreground">—</span>;
}

function DatabaseBody({
  database,
  icon,
  fetchedAt,
  onNavigate,
  stale,
}: {
  database: DatabaseDetail;
  icon: Summary["icon"];
  fetchedAt: string;
  onNavigate: (id: string) => void;
  stale: string | null;
}) {
  // Title first, then up to seven more columns that have at least one value.
  const columns = useMemo(() => {
    const filled = new Set<string>();
    for (const row of database.rows) for (const cell of row.cells) if (cell.text !== "" || cell.checked) filled.add(cell.name);
    const title = database.columns.filter((column) => column.type === "title");
    const rest = database.columns.filter((column) => column.type !== "title" && filled.has(column.name)).slice(0, 7);
    return [...title, ...rest];
  }, [database]);
  return (
    <section className="w-full px-4 pb-10 pt-5">
      <StaleNotice message={stale} />
      <div className="mb-4 flex items-start gap-3">
        <IconGlyph icon={icon ?? database.icon} kind="database" className="mt-0.5 size-9 text-3xl" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold leading-tight text-foreground">{database.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {database.rows.length} {database.hasMore ? "most recent rows" : database.rows.length === 1 ? "row" : "rows"} · Synced {formatWhen(fetchedAt)}
          </p>
          {database.description ? <p className="mt-2 text-sm text-muted-foreground">{database.description}</p> : null}
        </div>
      </div>
      {database.rows.length === 0 ? (
        <EmptyState>No rows are visible to the integration. Share the database with it in Notion.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[32rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                {columns.map((column) => (
                  <th key={column.name} className="whitespace-nowrap px-3 py-2 font-medium">
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {database.rows.map((row) => (
                <tr
                  key={row.id}
                  className="cursor-pointer border-b border-border last:border-b-0 hover:bg-accent/50"
                  onClick={() => onNavigate(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onNavigate(row.id);
                    }
                  }}
                  tabIndex={0}
                  role="link"
                  aria-label={`Open ${row.title}`}
                >
                  {columns.map((column) => {
                    const cell = row.cells.find((candidate) => candidate.name === column.name);
                    if (column.type === "title") {
                      return (
                        <td key={column.name} className="max-w-[20rem] px-3 py-2">
                          <span className="flex items-center gap-2">
                            <IconGlyph icon={row.icon} kind="page" className="size-4 text-base" />
                            <span className="truncate font-medium text-foreground">{row.title || "Untitled"}</span>
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td key={column.name} className="max-w-[16rem] truncate px-3 py-2 align-top text-foreground/90">
                        {cell ? <CellValue cell={cell} /> : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
