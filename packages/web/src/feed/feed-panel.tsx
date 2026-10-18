import { ArrowDown, ArrowLeftRight, Loader2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client.ts";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { cn } from "../lib/cn.ts";
import { fmtInt } from "../lib/format.ts";
import { isPlayerId } from "../lib/ids.ts";
import { seatLabel } from "../lib/seats.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import { useFeed, useLayout, useMatch, useSeats, useUi } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import { Button } from "../ui/button.tsx";
import { Who } from "./bits.tsx";
import { FeedCard } from "./cards.tsx";
import {
  FILTER_CHIPS,
  filterFeed,
  mergeEntries,
  turnIndex,
  windowOf,
  type FeedView,
} from "./filter.ts";
import { TurnIndex } from "./thought.tsx";

// The diplomatic feed (phase-3 design §4.3 "Feed", §4.2.4 pair mode): cards in time order up to the
// playhead, following it (the list keeps to its bottom unless the viewer scrolled up), filter chips,
// a player multi-select, and the pair mode (`?pair=pA,pB`: everything between two players). Only
// the last 300 cards are rendered; "Older" shows 300 more, then pages from the feed route when the
// client does not hold the start of the match yet. Clicking a card moves the playhead to it.

const WINDOW = 300;
const PAGE = 200;
const STICK_PX = 48;

function Chip({
  pressed,
  onClick,
  title,
  children,
}: {
  readonly pressed: boolean;
  readonly onClick: () => void;
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors",
        pressed
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-secondary/60 text-secondary-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

function PairPicker({ onDone }: { readonly onDone: () => void }) {
  const seats = useSeats();
  const id = useMatch((s) => s.id);
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const ok = a !== "" && b !== "" && a !== b && isPlayerId(a) && isPlayerId(b);
  const select = (value: string, set: (v: string) => void, label: string) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => set(e.target.value)}
      className="bg-secondary text-secondary-foreground h-7 min-w-0 flex-1 rounded-md border px-1.5 text-xs"
    >
      <option value="">Pick a player…</option>
      {seats.map((s) => (
        <option key={s.seat} value={s.seat}>
          {seatLabel(s)}
        </option>
      ))}
    </select>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {select(a, setA, "First player")}
      <ArrowLeftRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
      {select(b, setB, "Second player")}
      <Button
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!ok || id === null}
        onClick={() => {
          if (!ok || id === null || !isPlayerId(a) || !isPlayerId(b)) return;
          uiActions.setPair(id, [a, b]);
          onDone();
        }}
      >
        Show
      </Button>
    </div>
  );
}

function Controls() {
  const filter = useUi((s) => s.feedFilter);
  const players = useUi((s) => s.feedPlayers);
  const pair = useUi((s) => s.pair);
  const id = useMatch((s) => s.id);
  const seats = useSeats();
  const [picking, setPicking] = useState(false);
  if (pair !== null) {
    return (
      <div className="bg-gold/10 border-gold/40 flex items-start gap-2 rounded-lg border p-2 text-sm">
        <ArrowLeftRight className="text-gold mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 leading-snug" data-testid="pair-banner">
          Everything between <Who id={pair[0]} /> and <Who id={pair[1]} />, in time order: what each
          said to the other, and what each was thinking.
        </p>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label="Leave the pair view"
          onClick={() => {
            if (id !== null) uiActions.setPair(id, null);
          }}
        >
          <X />
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <fieldset className="flex flex-wrap gap-1">
        <legend className="sr-only">Show</legend>
        {FILTER_CHIPS.map((c) => (
          <Chip
            key={c.id}
            pressed={filter === c.id}
            title={c.hint}
            onClick={() => uiActions.setFeedFilter(c.id)}
          >
            {c.label}
          </Chip>
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap items-center gap-1">
        <legend className="sr-only">Players</legend>
        {seats.map((s) => (
          <Chip
            key={s.seat}
            pressed={players.includes(s.seat)}
            title={`Only what involves ${seatLabel(s)}`}
            onClick={() => uiActions.toggleFeedPlayer(s.seat)}
          >
            <PlayerGlyph color={s.color} size={10} />
            <span className="font-mono">{s.seat}</span>
          </Chip>
        ))}
        {players.length === 0 ? null : (
          <button
            type="button"
            onClick={() => uiActions.clearFeedPlayers()}
            className="text-muted-foreground hover:text-foreground px-1 text-xs underline-offset-2 hover:underline"
          >
            everyone
          </button>
        )}
        <button
          type="button"
          aria-expanded={picking}
          onClick={() => setPicking((p) => !p)}
          className="text-primary hover:text-primary/80 ml-auto flex items-center gap-1 px-1 text-xs font-medium"
        >
          <ArrowLeftRight className="size-3" aria-hidden="true" /> Between two…
        </button>
      </fieldset>
      {picking ? <PairPicker onDone={() => setPicking(false)} /> : null}
    </div>
  );
}

/** The nearest ancestor that scrolls vertically (the panel's column), else the page. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p !== null; p = p.parentElement) {
    const o = window.getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

function emptyText(view: FeedView, total: number): string {
  if (view.pair !== null) return "Nothing has passed between these two yet.";
  if (total === 0) return "Nothing has happened yet.";
  return "Nothing matches this filter yet.";
}

type OlderState = "idle" | "loading" | "done" | "error";

function FeedBody({ id }: { readonly id: string | null }) {
  const feed = useFeed();
  const filter = useUi((s) => s.feedFilter);
  const players = useUi((s) => s.feedPlayers);
  const pair = useUi((s) => s.pair);
  const showBots = useUi((s) => s.showBots);
  const selected = useUi((s) => s.selectedItem);
  const complete = useMatch((s) => s.loaded.complete);
  const layout = useLayout();
  const botsOnly = useMatch((s) => (s.meta?.seats ?? []).every((x) => x.kind !== "llm"));

  const [limit, setLimit] = useState(WINDOW);
  const [older, setOlder] = useState<readonly FeedEntry[]>([]);
  const [olderState, setOlderState] = useState<OlderState>("idle");

  const all = useMemo(() => mergeEntries(older, feed), [older, feed]);
  const view = useMemo<FeedView>(
    () => ({ filter, players, pair, showBots, botsOnly }),
    [filter, players, pair, showBots, botsOnly],
  );
  const list = useMemo(() => filterFeed(all, view), [all, view]);
  const index = useMemo(() => turnIndex(all), [all]);
  const { shown, hidden } = windowOf(list, limit);

  // Following the playhead: the list keeps to its bottom while the viewer is there; once they
  // scroll up it stays put and counts the cards that arrive below.
  const listRef = useRef<HTMLOListElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const length = useRef(list.length);
  const lastView = useRef(view);
  const [stuck, setStuck] = useState(true);
  const [seen, setSeen] = useState(0);
  const behind = stuck ? 0 : Math.max(0, list.length - seen);

  useEffect(() => {
    // The layouts mount their own panels, so the scrolling ancestor is fixed for this mount.
    const el = scrollParent(listRef.current);
    const listEl = listRef.current;
    scroller.current = el;
    if (el === null || listEl === null) return undefined;
    let stuckNow = true;
    // Only the viewer unsticks the list: a scroll that follows their own input (wheel, touch,
    // keys, the scrollbar). Cards measured late by `content-visibility`, the window sliding, or a
    // shorter feed after a seek move the bottom without them, and the list follows it.
    let inputAt = Number.NEGATIVE_INFINITY;
    const onInput = (e: Event): void => {
      if (e.type !== "pointerdown" || e.target === el) inputAt = performance.now();
    };
    const onScroll = (): void => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      if (atBottom && !stuckNow) {
        stuckNow = true;
        setStuck(true);
        setSeen(0);
      } else if (!atBottom && stuckNow && performance.now() - inputAt < 1_000) {
        stuckNow = false;
        setStuck(false);
        setSeen(length.current);
      } else if (!atBottom && stuckNow) {
        el.scrollTop = el.scrollHeight;
      }
    };
    const grown = new ResizeObserver(() => {
      if (stuckNow) el.scrollTop = el.scrollHeight;
    });
    grown.observe(listEl);
    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    for (const type of inputs) el.addEventListener(type, onInput, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      grown.disconnect();
      for (const type of inputs) el.removeEventListener(type, onInput);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  const last = shown.at(-1)?.item.id ?? null;
  useLayoutEffect(() => {
    length.current = list.length;
    const el = scroller.current;
    if (el === null || last === null) return;
    const viewChanged = lastView.current !== view;
    lastView.current = view;
    if (stuck || viewChanged) el.scrollTop = el.scrollHeight;
  }, [last, list.length, view, stuck]);

  const toBottom = (): void => {
    const el = scroller.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  };

  const showOlder = (): void => {
    if (hidden > 0) {
      setLimit((n) => n + WINDOW);
      return;
    }
    const first = all[0];
    if (id === null || complete || olderState === "loading" || olderState === "done") return;
    setOlderState("loading");
    api
      .feed(id, first === undefined ? { limit: PAGE } : { before: first.seq, limit: PAGE })
      .then((page) => {
        setOlder((cur) => mergeEntries(page.items, cur));
        setLimit((n) => n + page.items.length);
        setOlderState(page.more ? "idle" : "done");
      })
      .catch(() => setOlderState("error"));
  };
  const canPage = hidden > 0 || (!complete && olderState !== "done");

  const body = (
    <TurnIndex value={index}>
      <ol ref={listRef} aria-label="Feed items" className="flex flex-col gap-2">
        {canPage && shown.length > 0 ? (
          <li className="flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              className="text-xs"
              disabled={olderState === "loading"}
              onClick={showOlder}
            >
              {olderState === "loading" ? (
                <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" />
              ) : null}
              {hidden > 0
                ? `Older (${fmtInt(hidden)} more)`
                : olderState === "error"
                  ? "Older… (failed, retry)"
                  : "Older…"}
            </Button>
          </li>
        ) : null}
        {shown.map((e) => (
          <li key={e.item.id}>
            <FeedCard entry={e} selected={selected === e.item.id} />
          </li>
        ))}
      </ol>
      {shown.length > 0 ? null : (
        <p className="text-muted-foreground py-6 text-center text-sm">
          {feed.length === 0 && !complete ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" /> Loading the
              feed…
            </span>
          ) : (
            emptyText(view, feed.length)
          )}
        </p>
      )}
    </TurnIndex>
  );

  return (
    <div className="relative flex flex-col gap-2 [overflow-anchor:none]" data-testid="feed">
      <div
        className={cn(
          "bg-card z-10 flex flex-col gap-1.5 pb-1",
          layout === "phone" ? null : "sticky -top-3 -mt-3 pt-3",
        )}
      >
        <Controls />
      </div>
      {layout === "phone" ? (
        <div className="max-h-[70dvh] overflow-y-auto overscroll-contain rounded-lg">{body}</div>
      ) : (
        body
      )}
      {behind > 0 ? (
        <div className="pointer-events-none sticky bottom-0 flex justify-center pb-1">
          <Button size="sm" className="pointer-events-auto h-7 shadow-md" onClick={toBottom}>
            <ArrowDown aria-hidden="true" /> {fmtInt(behind)} new
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function FeedPanel() {
  // A new match starts a new feed (its window, older pages and scroll state).
  const id = useMatch((s) => s.id);
  return <FeedBody key={id ?? ""} id={id} />;
}
