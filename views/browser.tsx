// Pinned pages, recents, and workspace search — the
// launcher every surface shows before a page is chosen.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Pin, Summary } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { EmptyState, IconGlyph, Spinner, errorText, formatWhen, useDebounced, useNotionRpc } from "./shared";

export interface NotionBrowserProps {
  onOpen: (target: { id: string; title: string }) => void;
  /** Tighter spacing for the thread side panel. */
  compact?: boolean;
  className?: string;
}

export function NotionBrowser({ onOpen, compact = false, className }: NotionBrowserProps) {
  const rpc = useNotionRpc();
  const [status, setStatus] = useState<{ configured: boolean; workspace: string | null; error: string | null } | null>(null);
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [recents, setRecents] = useState<Summary[]>([]);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 250);
  const [results, setResults] = useState<{ query: string; items: Summary[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPins = useCallback(() => {
    rpc.call("pins_list").then((result) => setPins(result.pins), (cause: unknown) => setError(errorText(cause)));
  }, [rpc]);
  const loadRecents = useCallback(() => {
    rpc.call("recents_list").then((result) => setRecents(result.items), () => undefined);
  }, [rpc]);
  useEffect(() => {
    rpc.call("status").then(setStatus, (cause: unknown) => setError(errorText(cause)));
    loadPins();
    loadRecents();
  }, [rpc, loadPins, loadRecents]);
  useRealtime("pins-changed", loadPins);
  useRealtime("recents-changed", loadRecents);

  useEffect(() => {
    if (debounced === "") {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    rpc.call("search", { query: debounced, limit: 12 }).then(
      (result) => {
        if (cancelled) return;
        setResults({ query: debounced, items: result.items });
        setSearching(false);
        setError(null);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(errorText(cause));
        setSearching(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [debounced, rpc]);

  const pinnedIds = new Set((pins ?? []).map((pin) => pin.id));
  const togglePin = async (summary: Summary) => {
    try {
      if (pinnedIds.has(summary.id)) {
        await rpc.call("pin_remove", { id: summary.id });
        toast.success(`Unpinned ${summary.title}`);
      } else {
        await rpc.call("pin_add", { input: summary.id });
        toast.success(`Pinned ${summary.title}`);
      }
      loadPins();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  const pad = compact ? "px-3" : "px-4 md:px-5";
  return (
    <div className={cn("h-full min-h-0 overflow-y-auto", className)}>
      <div className={cn("mx-auto w-full max-w-3xl pb-6", compact ? "pt-3" : "pt-4", pad)}>
        {status && !status.configured ? (
          <EmptyState className="mb-4">
            Notion is not connected yet. Add the integration token under <span className="text-foreground">Extensions → Plugins → Notion</span>.
          </EmptyState>
        ) : status?.error ? (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {status.error}
          </p>
        ) : null}

        <div className="relative">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Notion…"
            aria-label="Search Notion"
            className="pl-8"
            onKeyDown={(event) => {
              if (event.key === "Enter" && results?.items[0]) onOpen({ id: results.items[0].id, title: results.items[0].title });
              if (event.key === "Escape") setQuery("");
            }}
          />
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {debounced !== "" ? (
          <Section title={searching ? "Searching…" : results ? `Results for “${results.query}”` : "Search"}>
            {results === null && searching ? (
              <Spinner label="Searching Notion…" />
            ) : results && results.items.length === 0 ? (
              <EmptyState>Nothing matched. The integration only sees pages shared with it.</EmptyState>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {(results?.items ?? []).map((item) => (
                  <ResultRow key={item.id} item={item} pinned={pinnedIds.has(item.id)} onOpen={() => onOpen({ id: item.id, title: item.title })} onTogglePin={() => togglePin(item)} />
                ))}
              </ul>
            )}
          </Section>
        ) : (
          <>
            <Section title="Pinned">
              {pins === null ? (
                <Spinner />
              ) : pins.length === 0 ? (
                <EmptyState>
                  No pins yet. Search above and use the pin button, or run <code>bb notion pin &lt;url&gt;</code>.
                </EmptyState>
              ) : (
                <div className={cn("grid gap-2", compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2")}>
                  {pins.map((pin) => (
                    <PinCard key={pin.id} pin={pin} onOpen={() => onOpen({ id: pin.id, title: pin.label })} compact={compact} />
                  ))}
                </div>
              )}
            </Section>
            {recents.length > 0 ? (
              <Section title="Recent">
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                  {recents.slice(0, compact ? 6 : 10).map((item) => (
                    <ResultRow key={item.id} item={item} pinned={pinnedIds.has(item.id)} onOpen={() => onOpen({ id: item.id, title: item.title })} onTogglePin={() => togglePin(item)} />
                  ))}
                </ul>
              </Section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function PinCard({ pin, onOpen, compact }: { pin: Pin; onOpen: () => void; compact: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full items-center gap-3 rounded-lg border border-border bg-card text-left transition-colors hover:border-foreground/30 hover:bg-accent/40",
        compact ? "px-3 py-2" : "px-4 py-3",
      )}
    >
      <IconGlyph icon={pin.icon} kind={pin.kind} className={cn("shrink-0", compact ? "size-6 text-xl" : "size-8 text-2xl")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{pin.label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {pin.title && pin.title !== pin.label ? `${pin.title} · ` : ""}
          {pin.kind === "database" ? "Database" : pin.kind === "page" ? "Page" : "Not shared with the integration yet"}
        </span>
      </span>
      <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function ResultRow({ item, pinned, onOpen, onTogglePin }: { item: Summary; pinned: boolean; onOpen: () => void; onTogglePin: () => void }) {
  return (
    <li className="flex items-center gap-2 pr-1">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left hover:bg-accent/40">
        <IconGlyph icon={item.icon} kind={item.kind} className="size-5 text-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{item.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {item.kind === "database" ? "Database" : "Page"}
            {item.parentTitle ? ` · ${item.parentTitle}` : ""}
            {item.lastEditedAt ? ` · ${formatWhen(item.lastEditedAt)}` : ""}
          </span>
        </span>
      </button>
      <Button variant="ghost" size="icon" className={cn("size-7", pinned ? "text-foreground" : "text-muted-foreground")} onClick={onTogglePin} aria-label={pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}>
        <Icon name="Target" className="size-4" />
      </Button>
    </li>
  );
}
