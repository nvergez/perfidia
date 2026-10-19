import type { FeedItemOf, SeatInfo } from "@perfidia/protocol/spectator";
import {
  AlarmClock,
  Bell,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Eye,
  Flag,
  Hammer,
  Handshake,
  Mail,
  Siren,
  Skull,
  Swords,
  type LucideIcon,
} from "lucide-react";
import { memo, useId, useMemo, useState } from "react";
import { GameTime } from "../common/game-time.tsx";
import { ModelBadge } from "../common/model-badge.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { cn } from "../lib/cn.ts";
import { fmtInt } from "../lib/format.ts";
import { isPlayerId, type PlayerId } from "../lib/ids.ts";
import { fmtAgo } from "../lib/time.ts";
import { PlayerCard } from "../players/player-card.tsx";
import { useFeed, useMatch, useSeats, useUi } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import { ReasoningToggle } from "./reasoning.tsx";
import { OpenTurnButton } from "../turns/open-turn.tsx";
import { LazyLiveReasoning } from "./lazy.ts";
import { TurnReasoning } from "./turn-reasoning.tsx";
import { wakeKinds, wakeWords, type WakeKind } from "./wake.ts";

// The thoughts column (phase-3 design §4.3 "Thoughts"): one block per agent, its latest public
// thought large, "thinking… round N" while it is in a turn, then its history, one thought per turn
// with icons for why it woke; opening a turn shows that turn's reasoning (annotations). Bots' turn
// summaries are behind "Show bots" (shown at once when no agent plays). Pass C adds the live
// per-round reasoning.

type TurnItem = FeedItemOf<"turn">;

const WAKE_ICONS: Readonly<Record<WakeKind, LucideIcon>> = Object.freeze({
  start: Flag,
  alarm: AlarmClock,
  message: Mail,
  diplomacy: Handshake,
  danger: Siren,
  battle: Swords,
  spy: Eye,
  build: Hammer,
  event: Bell,
});

const HISTORY = 8;

function WakeIcons({ reasons }: { readonly reasons: readonly string[] }) {
  const words = reasons.map(wakeWords).join("; ");
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" title={`Woke for ${words}`}>
      {wakeKinds(reasons).map((k) => {
        const Icon = WAKE_ICONS[k];
        return <Icon key={k} className="size-3" aria-hidden="true" />;
      })}
      <span className="sr-only">Woke for {words}</span>
    </span>
  );
}

// Memoised: a turn never changes, and its block re-renders as the feed grows.
const HistoryItem = memo(function HistoryItem({
  item,
  llm,
}: {
  readonly item: TurnItem;
  readonly llm: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li className="border-border/60 border-t pt-1.5 first:border-t-0 first:pt-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="hover:bg-accent/40 flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left"
      >
        {open ? (
          <ChevronDown
            className="text-muted-foreground mt-0.5 size-3 shrink-0"
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className="text-muted-foreground mt-0.5 size-3 shrink-0"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground flex items-center gap-1.5 text-[0.7rem]">
            <WakeIcons reasons={item.reasons} />
            turn {item.turn} · <GameTime t={item.t} />
          </span>
          {item.thought === null || item.thought === "" ? (
            <span className="text-muted-foreground block text-xs">(no thought)</span>
          ) : (
            <PlainText
              text={item.thought}
              className={cn("block text-xs", open ? null : "line-clamp-2")}
            />
          )}
        </span>
      </button>
      {open ? (
        <div id={id} className="mt-1 mb-1 ml-5 flex flex-col gap-1">
          <p className="text-muted-foreground text-[0.7rem]">
            Woke for {item.reasons.map(wakeWords).join("; ") || "no logged reason"}.
          </p>
          {llm ? (
            <>
              <OpenTurnButton seat={item.seat} turn={item.turn} />
              <div className="border-primary/40 border-l-2 pl-2">
                <TurnReasoning seat={item.seat} turn={item.turn} />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
});

function SeatStatus({ seat }: { readonly seat: PlayerId }) {
  const ent = useMatch((s) => s.frame?.seats[seat] ?? null);
  const alive = useMatch((s) => s.frame?.players[seat]?.alive ?? true);
  if (!alive) {
    return (
      <span className="text-betrayal inline-flex items-center gap-1 text-xs">
        <Skull className="size-3" aria-hidden="true" /> eliminated
      </span>
    );
  }
  if (ent?.handoff !== null && ent?.handoff !== undefined) {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        <Bot className="size-3" aria-hidden="true" /> now played by a bot
      </span>
    );
  }
  if (ent?.inTurn === true) {
    return (
      <span className="text-primary inline-flex items-center gap-1 text-xs font-medium">
        <Brain className="size-3 motion-safe:animate-pulse" aria-hidden="true" />
        thinking…{ent.round === null ? null : ` round ${ent.round + 1}`}
      </span>
    );
  }
  return null;
}

/** "3 h ago", re-rendered once a game minute (not its whole block). */
function Ago({ t }: { readonly t: number }) {
  const minute = useMatch((s) => Math.floor(s.playhead / 60) * 60);
  return <>{fmtAgo(minute - t)}</>;
}

/** Same seat and the same turns (they only grow at the end, or shrink after a seek back). */
const sameTurns = (
  a: { readonly seat: SeatInfo; readonly turns: readonly TurnItem[] },
  b: { readonly seat: SeatInfo; readonly turns: readonly TurnItem[] },
): boolean =>
  a.seat === b.seat && a.turns.length === b.turns.length && a.turns.at(-1) === b.turns.at(-1);

const SeatBlock = memo(function SeatBlock({
  seat,
  turns,
}: {
  readonly seat: SeatInfo;
  readonly turns: readonly TurnItem[];
}) {
  const id = seat.seat;
  const last = useMatch((s) => s.frame?.seats[id]?.lastThought ?? null);
  // The open turn (Pass C: its rounds live, `live.tsx`).
  const openTurn = useMatch((s) => {
    const ent = s.frame?.seats[id];
    return ent?.inTurn === true ? ent.turn : null;
  });
  const [all, setAll] = useState(false);
  const llm = seat.kind === "llm";
  const history = useMemo(() => {
    const older = turns.filter((x) => x.turn !== last?.turn).toReversed();
    return older;
  }, [turns, last]);
  const shown = all ? history : history.slice(0, HISTORY);
  return (
    <article
      data-seat={id}
      aria-label={`Thoughts of ${seat.name} (${id})`}
      className="bg-card rounded-lg border p-2.5"
    >
      <header className="flex min-w-0 items-center gap-1.5 text-sm">
        <PlayerCard player={id}>
          <button
            type="button"
            onClick={() => uiActions.openPlayer(id)}
            className="flex min-w-0 items-center gap-1.5 text-left hover:underline"
          >
            <PlayerGlyph color={seat.color} size={12} />
            <bdi className="truncate font-medium">{seat.name}</bdi>
            <span className="text-muted-foreground shrink-0 font-mono text-[0.85em]">· {id}</span>
          </button>
        </PlayerCard>
        <ModelBadge seat={seat} className="shrink-0" />
        <span className="ml-auto shrink-0">
          <SeatStatus seat={id} />
        </span>
      </header>
      {llm && openTurn !== null ? <LazyLiveReasoning seat={id} turn={openTurn} /> : null}
      {last === null ? (
        <p className="text-muted-foreground mt-2 text-sm">No thought yet.</p>
      ) : (
        <div className="mt-2">
          <PlainText text={last.text} className="block text-[0.95rem] leading-snug" />
          <p className="text-muted-foreground mt-1 text-[0.7rem]">
            turn {last.turn} · <GameTime t={last.t} /> · <Ago t={last.t} />
          </p>
          {llm ? <ReasoningToggle seat={id} turn={last.turn} className="mt-1" /> : null}
        </div>
      )}
      {history.length === 0 ? null : (
        <details className="group mt-2">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none">
            Earlier thoughts ({fmtInt(history.length)})
          </summary>
          <ol className="mt-1.5 flex flex-col gap-1.5">
            {shown.map((t) => (
              <HistoryItem key={t.id} item={t} llm={llm} />
            ))}
          </ol>
          {history.length > shown.length ? (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="text-primary hover:text-primary/80 mt-1 text-xs font-medium"
            >
              Show all {fmtInt(history.length)} turns
            </button>
          ) : null}
        </details>
      )}
    </article>
  );
}, sameTurns);

const NO_TURNS: readonly TurnItem[] = Object.freeze([]);

export function ThoughtsPanel() {
  const seats = useSeats();
  const feed = useFeed();
  const showBots = useUi((s) => s.showBots);
  const agents = seats.filter((s) => s.kind === "llm");
  const bots = seats.filter((s) => s.kind === "bot");
  const noAgents = agents.length === 0;
  const withBots = showBots || noAgents;
  const bySeat = useMemo(() => {
    const out = new Map<string, TurnItem[]>();
    for (const e of feed) {
      if (e.item.k !== "turn") continue;
      const list = out.get(e.item.seat);
      if (list === undefined) out.set(e.item.seat, [e.item]);
      else list.push(e.item);
    }
    return out;
  }, [feed]);
  const shown = withBots ? [...agents, ...bots] : agents;
  return (
    <div className="flex flex-col gap-2" data-testid="thoughts">
      <div className="flex items-center gap-2 text-xs">
        <p className="text-muted-foreground min-w-0 flex-1">
          {noAgents
            ? "No AI agent plays this match: these are the scripted bots' turn summaries."
            : "Each agent's public thought at the end of its turns. Open a turn for its reasoning."}
        </p>
        {noAgents || bots.length === 0 ? null : (
          <button
            type="button"
            aria-pressed={showBots}
            onClick={() => uiActions.setShowBots(!showBots)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5",
              showBots ? "bg-primary text-primary-foreground border-primary" : "bg-secondary/60",
            )}
          >
            <Bot className="size-3" aria-hidden="true" /> Show bots
          </button>
        )}
      </div>
      {shown.map((s) =>
        isPlayerId(s.seat) ? (
          <SeatBlock key={s.seat} seat={s} turns={bySeat.get(s.seat) ?? NO_TURNS} />
        ) : null,
      )}
    </div>
  );
}
