import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Summary } from "../server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type NotionRpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export function useNotionRpc(): NotionRpc {
  return useRpc<typeof rpcContract>();
}

export type IconValue = Summary["icon"];

/** Session target for the nav page's right-pane viewer tab (a JSON object). */
export type ViewerTarget = { id: string; title: string };
export const VIEWER_TAB = {
  panelId: "notion",
  id: "viewer",
  experimental_target: {
    validate(value: JsonValue): value is ViewerTarget {
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as { id?: unknown }).id === "string" &&
        typeof (value as { title?: unknown }).title === "string"
      );
    },
  },
} as const;

/** Thread panel params carry the page id (persisted with the tab); title is optional there. */
export function targetFromParams(params: JsonValue | null): ViewerTarget | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const id = (params as { id?: unknown }).id;
  if (typeof id !== "string" || id === "") return null;
  const title = (params as { title?: unknown }).title;
  return { id, title: typeof title === "string" ? title : "" };
}

const NOTION_HOSTS = new Set(["notion.so", "www.notion.so", "app.notion.com", "notion.site"]);

/** Page id when a URL points at Notion; null for everything else. */
export function notionIdFromHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!NOTION_HOSTS.has(host) && !host.endsWith(".notion.site")) return null;
  const peek = url.searchParams.get("p");
  const candidates = [peek ?? "", url.pathname];
  for (const candidate of candidates) {
    const match = candidate.match(/[0-9a-f]{32}/gi);
    if (match && match.length > 0) {
      const hex = match[match.length - 1]!.toLowerCase();
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }
  return null;
}

/** Emoji or image icon with a neutral fallback glyph. */
export function IconGlyph({ icon, kind, className }: { icon: IconValue; kind?: Summary["kind"] | null; className?: string }) {
  if (icon?.kind === "emoji") {
    return (
      <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center leading-none", className)}>
        {icon.value}
      </span>
    );
  }
  if (icon?.kind === "url") {
    return <img src={icon.value} alt="" aria-hidden="true" className={cn("inline-block shrink-0 rounded-sm object-cover", className)} />;
  }
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center text-muted-foreground", className)}>
      <Icon name={kind === "database" ? "ListTodo" : "Edit"} className="size-[1em]" />
    </span>
  );
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: days > 300 ? "numeric" : undefined });
}

export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="status" className={cn("rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground", className)}>
      {children}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
      <Icon name="Loading" className="size-4 animate-spin" />
      {label}
    </div>
  );
}

/** Intercepts clicks on Notion links inside rendered markdown so they stay in the viewer. */
export function NotionLinkScope({ onNavigate, children, className }: { onNavigate: (id: string) => void; children: ReactNode; className?: string }) {
  const onClickCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const id = notionIdFromHref(anchor.href);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      onNavigate(id);
    },
    [onNavigate],
  );
  return (
    <div className={className} onClickCapture={onClickCapture}>
      {children}
    </div>
  );
}

/** Debounced value for search inputs. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Latest-wins async loader keyed by a request token. */
export function useLatest<T>() {
  const token = useRef(0);
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "error"; value: T | null; error: string | null }>({
    status: "idle",
    value: null,
    error: null,
  });
  const run = useCallback((task: () => Promise<T>, options: { keepValue?: boolean } = {}) => {
    const mine = ++token.current;
    setState((previous) => ({ status: "loading", value: options.keepValue ? previous.value : null, error: null }));
    task().then(
      (value) => {
        if (token.current === mine) setState({ status: "ready", value, error: null });
      },
      (cause: unknown) => {
        if (token.current === mine) setState((previous) => ({ status: "error", value: previous.value, error: cause instanceof Error ? cause.message : String(cause) }));
      },
    );
  }, []);
  return { ...state, run };
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
