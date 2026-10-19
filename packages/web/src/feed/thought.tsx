import type { FeedItemOf } from "@perfidia/protocol/spectator";
import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { createContext, useContext, useEffect, useId, useState } from "react";
import { api } from "../api/client.ts";
import { GameTime } from "../common/game-time.tsx";
import { PlainText } from "../common/plain-text.tsx";
import type { PlayerId } from "../lib/ids.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import { useMatch, useSeatLabel } from "../store/hooks.ts";
import { OpenTurnButton } from "../turns/open-turn.tsx";
import { turnKeyOf } from "./filter.ts";

// "What pN was thinking when it wrote this" (phase-3 design §4.1, the main irony device): under a
// message, collapsed, the sender's public thought of the turn it was sent in. The turn's item
// closes the turn, so it comes after the message: it is read from the feed the client holds, or,
// when the playhead has not reached the turn's end yet, from the feed route (the next turn items of
// the sender after the message), once per turn.

type TurnItem = FeedItemOf<"turn">;

/** Turn items of the feed by `seat:turn` (the feed panel provides it). */
export const TurnIndex = createContext<ReadonlyMap<string, FeedEntry>>(new Map());

type Lookup =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly item: TurnItem | null }
  | { readonly status: "error" };

/**
 * Turn items fetched from the feed route, by `timeline|match|seat|turn`. Only a found item is kept:
 * "not ended yet" and failures are asked again next time (the turn may have ended since).
 */
const remote = new Map<string, Promise<TurnItem | null>>();

function fetchTurn(
  key: string,
  match: string,
  seat: PlayerId,
  turn: number,
  after: number,
): Promise<TurnItem | null> {
  let p = remote.get(key);
  if (p === undefined) {
    p = api.feed(match, { after, kinds: ["turn"], players: [seat], limit: 20 }).then((page) => {
      for (const e of page.items) {
        if (e.item.k === "turn" && e.item.seat === seat && e.item.turn === turn) return e.item;
      }
      return null;
    });
    p.then(
      (item) => {
        if (item === null) remote.delete(key);
      },
      () => remote.delete(key),
    );
    remote.set(key, p);
  }
  return p;
}

function useTurnThought(
  seat: PlayerId,
  turn: number,
  after: number,
  enabled: boolean,
): Lookup | null {
  const local = useContext(TurnIndex).get(turnKeyOf(seat, turn));
  const match = useMatch((s) => s.id);
  const timeline = useMatch((s) => s.meta?.timeline ?? "");
  const key = `${timeline}|${match ?? ""}|${seat}|${turn}`;
  // A remote answer, kept with the turn it answers (a stale one reads as loading).
  const [found, setFound] = useState<{ readonly key: string; readonly lookup: Lookup } | null>(
    null,
  );
  const localItem = local?.item.k === "turn" ? local.item : null;
  useEffect(() => {
    let live = true;
    if (enabled && localItem === null && match !== null) {
      fetchTurn(key, match, seat, turn, after).then(
        (item) => {
          if (live) setFound({ key, lookup: { status: "ok", item } });
        },
        () => {
          if (live) setFound({ key, lookup: { status: "error" } });
        },
      );
    }
    return () => {
      live = false;
    };
  }, [enabled, localItem, match, seat, turn, after, key]);
  if (!enabled) return null;
  if (localItem !== null) return { status: "ok", item: localItem };
  return found?.key === key ? found.lookup : { status: "loading" };
}

/** The sender's thought of the turn a message was sent in, collapsed under the message. */
export function SameTurnThought({
  seat,
  turn,
  seq,
}: {
  readonly seat: PlayerId;
  readonly turn: number;
  /** The message's cursor: the turn's item comes after it. */
  readonly seq: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const who = useSeatLabel(seat);
  const r = useTurnThought(seat, turn, seq, open);
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="text-primary hover:text-primary/80 flex items-center gap-1 text-left text-xs font-medium"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
        )}
        <Brain className="size-3 shrink-0" aria-hidden="true" />
        <span>
          What <bdi>{who}</bdi> was thinking when it wrote this
        </span>
      </button>
      {!open || r === null ? null : (
        <div
          id={id}
          className="border-primary/50 bg-primary/5 mt-1.5 rounded-r-md border-l-2 px-3 py-2 text-sm"
        >
          {r.status === "loading" ? (
            <span className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" /> Finding
              that turn…
            </span>
          ) : r.status === "error" ? (
            <span className="text-muted-foreground text-xs">The thought could not be loaded.</span>
          ) : r.item === null ? (
            <span className="text-muted-foreground text-xs">
              That turn has not ended yet: its thought comes when it does.
            </span>
          ) : r.item.thought === null || r.item.thought === "" ? (
            <>
              <span className="text-muted-foreground text-xs">
                It left no thought for that turn.
              </span>
              <OpenTurnButton seat={seat} turn={turn} className="mt-1" />
            </>
          ) : (
            <>
              <PlainText text={r.item.thought} className="italic" />
              <span className="text-muted-foreground mt-1 block text-[0.7rem]">
                Turn {r.item.turn}, ended <GameTime t={r.item.t} />
              </span>
              <OpenTurnButton seat={seat} turn={turn} className="mt-1" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
