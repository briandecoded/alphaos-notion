// How the viewer and browser are composed on each bb surface:
// - the sidebar "Notion" page (browser on the left, viewer tab on the right),
// - the thread side-panel tab (browser → viewer in place, or a new tab per page),
// - the New-thread side panel (same, in-place only),
// - the ::notion{} card inside assistant messages.
import { useCallback, useEffect, useState } from "react";
import { experimental_useAppPanel, experimental_useFixedTabTarget, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { JsonValue, PluginMessageDirectiveProps, PluginNavPanelProps, PluginNewThreadPanelProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { Summary } from "../server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { NotionBrowser } from "./browser";
import { IconGlyph, VIEWER_TAB, formatWhen, notionIdFromHref, targetFromParams, useNotionRpc, type ViewerTarget } from "./shared";
import { NotionViewer } from "./viewer";

export const THREAD_ACTION_ID = "page";
export const NAV_PATH = "notion";

function idFromSubPath(subPath: string): string | null {
  const segment = subPath.split("/").filter(Boolean)[0];
  if (!segment) return null;
  return notionIdFromHref(`https://www.notion.so/${segment}`) ?? (/^[0-9a-f-]{32,36}$/i.test(segment) ? segment : null);
}

/** Sidebar page body: the browser. Selecting a page opens the right-pane viewer tab. */
export function NotionHome({ subPath }: PluginNavPanelProps) {
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const [inline, setInline] = useState<ViewerTarget | null>(null);

  const open = useCallback(
    (target: { id: string; title: string }) => {
      const accepted = panel.openFixedTab<ViewerTarget>({ surface: { kind: "current" }, tab: VIEWER_TAB, target: { id: target.id, title: target.title } });
      if (!accepted) setInline({ id: target.id, title: target.title });
    },
    [panel],
  );

  // Deep link: /plugins/notion/notion/<page-id> (used by cards when no thread panel exists).
  useEffect(() => {
    const id = idFromSubPath(subPath);
    if (id) {
      open({ id, title: "" });
      navigate.toPluginPanel(NAV_PATH, { subPath: "", replace: true });
    }
  }, [subPath, open, navigate]);

  if (inline) {
    return <NotionViewer rootId={inline.id} onExit={() => setInline(null)} exitLabel="Notion" className="h-full" />;
  }
  return <NotionBrowser onOpen={open} className="h-full" />;
}

/** The right-pane fixed tab on the sidebar page. */
export function NotionViewerTab(_props: PluginNavPanelProps) {
  const state = experimental_useFixedTabTarget<ViewerTarget>(VIEWER_TAB);
  const [local, setLocal] = useState<ViewerTarget | null>(null);
  const target = state?.target ?? local;
  if (!target) {
    return <NotionBrowser compact onOpen={(next) => setLocal({ id: next.id, title: next.title })} className="h-full" />;
  }
  return (
    <NotionViewer
      key={`${state?.sequence ?? "local"}:${target.id}`}
      rootId={target.id}
      onExit={() => {
        state?.clear();
        setLocal(null);
      }}
      exitLabel="Notion"
      className="h-full"
    />
  );
}

/** Thread side-panel tab. `params` carries `{ id }` when a specific page was requested. */
export function NotionThreadPanel({ params }: PluginThreadPanelProps) {
  const navigate = useBbNavigate();
  const initial = targetFromParams(params);
  const [local, setLocal] = useState<ViewerTarget | null>(initial);
  useEffect(() => setLocal(targetFromParams(params)), [params]);
  const openInNewTab = useCallback(
    (summary: Summary) => {
      navigate.openThreadPanel({ actionId: THREAD_ACTION_ID, title: summary.title, params: { id: summary.id, title: summary.title } });
    },
    [navigate],
  );
  if (!local) return <NotionBrowser compact onOpen={(next) => setLocal({ id: next.id, title: next.title })} className="h-full" />;
  return (
    <NotionViewer
      rootId={local.id}
      onExit={initial ? undefined : () => setLocal(null)}
      exitLabel="Notion"
      onOpenInNewTab={openInNewTab}
      className="h-full"
    />
  );
}

/** New-thread side panel: same as the thread tab, without sibling tabs. */
export function NotionNewThreadPanel({ params }: PluginNewThreadPanelProps) {
  const initial = targetFromParams(params);
  const [local, setLocal] = useState<ViewerTarget | null>(initial);
  if (!local) return <NotionBrowser compact onOpen={(next) => setLocal({ id: next.id, title: next.title })} className="h-full" />;
  return <NotionViewer rootId={local.id} onExit={initial ? undefined : () => setLocal(null)} exitLabel="Notion" className="h-full" />;
}

/** `::notion{id="…" title="…"}` inside an assistant message → a clickable card. */
export function NotionCard({ attributes }: PluginMessageDirectiveProps) {
  const rpc = useNotionRpc();
  const navigate = useBbNavigate();
  const rawId = attributes.id ?? attributes.url ?? "";
  const id = notionIdFromHref(rawId) ?? notionIdFromHref(`https://www.notion.so/${rawId}`);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    rpc.call("resolve", { input: id }).then(
      (result) => {
        if (!cancelled) setSummary(result);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, rpc]);

  if (!id) {
    return <span className="text-xs text-muted-foreground">(invalid Notion reference)</span>;
  }
  const title = summary?.title ?? attributes.title ?? "Notion page";
  const openIt = () => {
    const params: JsonValue = { id, title };
    const accepted = navigate.openThreadPanel({ actionId: THREAD_ACTION_ID, title, params });
    if (!accepted) navigate.toPluginPanel(NAV_PATH, { subPath: id.replace(/-/g, "") });
  };
  return (
    <button
      type="button"
      onClick={openIt}
      className={cn(
        "my-1 flex w-full max-w-md items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40",
      )}
      aria-label={`Open ${title} in the side panel`}
    >
      <IconGlyph icon={summary?.icon ?? null} kind={summary?.kind ?? "page"} className="size-7 text-xl" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {error ? error : summary ? `${summary.kind === "database" ? "Database" : "Page"}${summary.parentTitle ? ` · ${summary.parentTitle}` : ""}${summary.lastEditedAt ? ` · edited ${formatWhen(summary.lastEditedAt)}` : ""}` : "Notion"}
        </span>
      </span>
      <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
