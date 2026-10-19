import type { LucideIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";
import { GameTime } from "../common/game-time.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { cn } from "../lib/cn.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import { controls } from "../store/session.ts";
import { uiActions } from "../store/ui.ts";

// The frame every feed card shares: an icon and a kind, the time (a button that moves the playhead
// just after the item's log line), and the body; a click anywhere on the card that is not on one of
// its own controls does the same. Long player-authored text gets "more".

export type Tone = "plain" | "key" | "gold" | "betrayal" | "quiet";

const TONES: Readonly<Record<Tone, string>> = Object.freeze({
  plain: "bg-card",
  key: "bg-card border-primary/40",
  gold: "bg-gold/10 border-gold/50",
  betrayal: "bg-betrayal/10 border-betrayal/70",
  quiet: "bg-card/40 text-muted-foreground",
});

const isInteractive = (target: EventTarget): boolean =>
  target instanceof Element && target.closest("button, a, select, input, summary") !== null;

/** Moves the playhead just after a feed entry's line and marks it selected. */
export function seekTo(entry: FeedEntry): void {
  uiActions.selectItem(entry.item.id);
  controls.seekSeq(entry.seq, entry.item.t);
}

export function Shell({
  entry,
  icon: Icon,
  kind,
  tone = "plain",
  accent,
  selected,
  className,
  children,
}: {
  readonly entry: FeedEntry;
  readonly icon: LucideIcon;
  readonly kind: string;
  readonly tone?: Tone;
  /** A player colour for the left edge (a message's sender). */
  readonly accent?: string;
  readonly selected: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { item } = entry;
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- a pointer shortcut; the card's time is the keyboard control that does the same
    <article
      data-k={item.k}
      data-item={item.id}
      aria-label={kind}
      onClick={(e: MouseEvent) => {
        if (!isInteractive(e.target)) seekTo(entry);
      }}
      style={accent === undefined ? undefined : { borderLeftColor: accent }}
      className={cn(
        "hover:border-ring/60 cursor-pointer rounded-lg border p-2.5 text-sm [contain-intrinsic-size:auto_5rem] [content-visibility:auto]",
        accent === undefined ? null : "border-l-4",
        TONES[tone],
        selected && "ring-primary ring-2",
        className,
      )}
    >
      <header
        className={cn(
          "mb-1 flex items-center gap-1.5 text-xs",
          tone === "betrayal" ? "text-betrayal" : "text-muted-foreground",
        )}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate font-medium">{kind}</span>
        <button
          type="button"
          onClick={() => seekTo(entry)}
          title="Go to this moment"
          className="text-muted-foreground hover:text-foreground ml-auto shrink-0 font-mono tabular-nums underline-offset-2 hover:underline"
        >
          <GameTime t={item.t} />
        </button>
      </header>
      {children}
    </article>
  );
}

const LONG_CHARS = 420;
const LONG_LINES = 7;

/** Player-authored text with "more" when it is long. */
export function LongText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_CHARS || text.split("\n").length > LONG_LINES;
  return (
    <div className={className}>
      <PlainText text={text} className={cn("block", long && !open && "line-clamp-6")} />
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="text-primary hover:text-primary/80 mt-0.5 text-xs font-medium"
        >
          {open ? "less" : "more"}
        </button>
      ) : null}
    </div>
  );
}
