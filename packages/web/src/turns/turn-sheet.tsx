import type { FeedItemOf, SeatEnt, SeatInfo, TurnAnnotation } from "@perfidia/protocol/spectator";
import {
  AlarmClock,
  Bot,
  Brain,
  ChevronLeft,
  ChevronRight,
  Coins,
  Flag,
  ListChecks,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
  Siren,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client.ts";
import { GameTime } from "../common/game-time.tsx";
import { ModelBadge } from "../common/model-badge.tsx";
import { NotPublished } from "../common/not-published.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { Who, WhoList } from "../feed/bits.tsx";
import { seenBy } from "../feed/filter.ts";
import { LongText } from "../feed/shell.tsx";
import { fmtInt, fmtUsd, plural } from "../lib/format.ts";
import type { PlayerId } from "../lib/ids.ts";
import { isFakeSeat, seatReasoningKind, type ReasoningKind } from "../lib/models.ts";
import { LazyPlayerSheet } from "../players/lazy.ts";
import {
  useAnnotation,
  useFeed,
  useLiveAnnots,
  useMatch,
  usePublished,
  useSeat,
  useUi,
  type Published,
} from "../store/hooks.ts";
import { controls, isRunningStatus, loaders } from "../store/session.ts";
import { uiActions, useUiStore, type OpenTurn } from "../store/ui.ts";
import { liveTopRound, roundNow, type AnnotMsg } from "../store/match.ts";
import { wakeIcon } from "../thoughts/wake-icons.tsx";
import { wakeWords } from "../thoughts/wake.ts";
import { Button } from "../ui/button.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet.tsx";
import {
  callTally,
  findTurnItem,
  fmtLatency,
  roundsUpTo,
  shapeRounds,
  tokenSum,
  turnMessages,
  whyWords,
  type TurnRounds,
} from "./detail.ts";
import { RoundList } from "./rounds.tsx";

// The turn detail (phase-3 design §4.2 Pass C, C1; docs/phase3.md §16.7): a sheet for the turn in
// `uiStore.openTurn` (opened from a thought, a message's same-turn thought, the dossier, or
// `?turn=pN.T`). It shows the wake (reasons and urgency), the public thought with the messages sent
// next to it, each round (reasoning, text, tool calls with ✓/✗ and codes), how the turn ended, and
// its cost and tokens. A turn still open shows its rounds as they arrive (live) and is refreshed
// when it closes; a bot's turn has no model calls; what the server does not publish is said in one
// line. A chunk loaded on demand (`turns/lazy.ts`).

type TurnItem = FeedItemOf<"turn">;

const NO_CALLS: NonNullable<TurnItem["results"]> = [];

/** Where the turn stands at the playhead. */
type Where =
  | { readonly k: "closed"; readonly seq: number; readonly item: TurnItem }
  | { readonly k: "open"; readonly ent: SeatEnt }
  | { readonly k: "later"; readonly played: number }
  | { readonly k: "loading" }
  /** No such turn: `played` turns in all (a finished match seen at its end), or none logged. */
  | { readonly k: "missing"; readonly played: number | null };

/** The playhead is at the end of a match that no longer grows: nothing comes later. */
function useAtFinalEnd(): boolean {
  return useMatch(
    (s) =>
      !isRunningStatus(s.status) &&
      s.frame !== null &&
      s.meta !== null &&
      s.frame.seq >= s.meta.lastSeq,
  );
}

function useWhere(seat: PlayerId, turn: number): Where {
  const feed = useFeed();
  const found = useMemo(() => findTurnItem(feed, seat, turn), [feed, seat, turn]);
  const ent = useMatch((s) => s.frame?.seats[seat] ?? null);
  const complete = useMatch((s) => s.loaded.complete);
  const atEnd = useAtFinalEnd();
  if (found !== null) return { k: "closed", seq: found.seq, item: found.item };
  if (ent === null) return { k: "loading" };
  if (ent.inTurn && ent.turn === turn) return { k: "open", ent };
  if (ent.turn < turn)
    return atEnd ? { k: "missing", played: ent.turn } : { k: "later", played: ent.turn };
  return complete ? { k: "missing", played: null } : { k: "loading" };
}

function Section({
  title,
  icon: Icon,
  children,
  testId,
}: {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold tracking-wider uppercase">
        <Icon className="size-3.5" aria-hidden="true" /> {title}
      </h3>
      {children}
    </section>
  );
}

function Wake({
  wakeT,
  reasons,
  urgent,
}: {
  readonly wakeT: number | null;
  readonly reasons: readonly string[];
  readonly urgent: boolean;
}) {
  return (
    <Section title="Why it woke" icon={AlarmClock} testId="turn-wake">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {wakeT === null ? (
          <span className="text-muted-foreground">Its wake was not logged.</span>
        ) : (
          <span>
            Woke at <GameTime t={wakeT} />
          </span>
        )}
        {urgent ? (
          <span className="border-destructive/60 text-destructive inline-flex items-center gap-1 rounded-full border px-2 text-xs font-medium">
            <Siren className="size-3" aria-hidden="true" /> urgent
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">not urgent</span>
        )}
      </p>
      {reasons.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5 text-sm">
          {reasons.map((r) => {
            const Icon = wakeIcon(r);
            return (
              <li key={r} className="flex items-center gap-1.5">
                <Icon className="text-primary size-3.5 shrink-0" aria-hidden="true" />
                <span>{wakeWords(r)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Message({ m }: { readonly m: FeedItemOf<"message"> }) {
  const seen = seenBy(m);
  return (
    <li className="bg-card rounded-md border p-2 text-sm" data-k="message">
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs">
        {m.private ? (
          <Lock className="text-gold size-3 shrink-0" aria-hidden="true" />
        ) : (
          <Mail className="size-3 shrink-0" aria-hidden="true" />
        )}
        <span className="text-muted-foreground">to</span>
        {m.to === "all" ? <strong>everyone</strong> : <WhoList ids={m.to} />}
        <span className="text-muted-foreground">
          · <GameTime t={m.t} />
        </span>
      </p>
      {seen === "all" ? null : (
        <p className="text-muted-foreground text-[0.7rem]">
          Seen only by <span className="font-mono">{seen.join(", ")}</span>
        </p>
      )}
      <LongText text={m.text} className="mt-1" />
    </li>
  );
}

function ThoughtAndMessages({
  thought,
  messages,
  open,
  bot,
}: {
  readonly thought: string | null;
  readonly messages: readonly FeedItemOf<"message">[];
  readonly open: boolean;
  readonly bot: boolean;
}) {
  return (
    <Section title={bot ? "Turn summary and messages" : "Thought and messages"} icon={Brain}>
      <div className="border-primary/50 bg-primary/5 flex flex-col gap-2 rounded-r-md border-l-2 px-3 py-2">
        {open ? (
          <p className="text-muted-foreground text-xs">
            Its public thought comes when the turn ends.
          </p>
        ) : thought === null || thought === "" ? (
          <p className="text-muted-foreground text-xs">It left no thought for this turn.</p>
        ) : (
          <PlainText text={thought} className="block text-[0.95rem] leading-snug italic" />
        )}
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            {messages.length === 0
              ? open
                ? "No message sent so far in this turn."
                : "No message sent in this turn."
              : `Sent in this turn: ${plural(messages.length, "message")}`}
          </p>
          {messages.length === 0 ? null : (
            <ol className="flex flex-col gap-1.5">
              {messages.map((m) => (
                <Message key={m.id} m={m} />
              ))}
            </ol>
          )}
        </div>
      </div>
    </Section>
  );
}

function Tally({ rounds, item }: { readonly rounds: TurnRounds; readonly item: TurnItem | null }) {
  const t = callTally(rounds.rounds);
  const n = rounds.rounds.filter((r) => r.kind === "round" && r.key !== "loose").length;
  if (!rounds.verdicts) {
    return (
      <p className="text-sm">
        {plural(n, "round")} so far · {plural(t.calls, "tool call")}; verdicts come when the turn
        ends.
      </p>
    );
  }
  return (
    <p className="text-sm">
      {plural(item?.rounds ?? n, "round")} · {plural(t.calls, "tool call")}:{" "}
      <span className="text-emerald-400">{fmtInt(t.accepted)} accepted</span>
      {t.partial === 0 ? null : (
        <>
          , <span className="text-gold">{fmtInt(t.partial)} in part</span>
        </>
      )}
      {t.rejected === 0 ? null : (
        <>
          , <span className="text-destructive">{fmtInt(t.rejected)} rejected</span>
        </>
      )}
      {item === null || item.rejected.length === 0 ? null : (
        <span className="text-muted-foreground">
          {" "}
          (refused: {item.rejected.map((r) => `${r.code} ×${fmtInt(r.count)}`).join(", ")})
        </span>
      )}
    </p>
  );
}

function Rounds({
  rounds,
  item,
  annotation,
  published,
  open,
  seat,
  turn,
  seatKind,
}: {
  readonly rounds: TurnRounds;
  readonly item: TurnItem | null;
  readonly annotation: ReturnType<typeof useAnnotation>;
  readonly published: Published;
  readonly open: boolean;
  readonly seat: PlayerId;
  readonly turn: number;
  readonly seatKind: ReasoningKind | null;
}) {
  const following = useMatch((s) => s.mode === "live");
  const loading = annotation === null || annotation.status === "loading";
  // An open turn's first reply may not be logged yet (no annotation): not a failure.
  const failed = annotation?.status === "error" && !open ? annotation.message : null;
  const incomplete = annotation?.status === "ok" && !annotation.value.complete && !open;
  return (
    <Section title="Rounds and tool calls" icon={ListChecks} testId="turn-rounds">
      <Tally rounds={rounds} item={item} />
      {published.reasoning ? null : <NotPublished what="Reasoning" />}
      {failed === null ? null : (
        <p className="text-muted-foreground text-xs">
          {failed.charAt(0).toUpperCase()}
          {failed.slice(1)}.
        </p>
      )}
      {loading && rounds.rounds.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" /> Loading the
          rounds…
        </p>
      ) : rounds.rounds.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {!open
            ? "No round was logged for this turn."
            : following
              ? "No reply has arrived yet in this turn."
              : "No round logged yet at this point of the match."}
        </p>
      ) : (
        <RoundList rounds={rounds.rounds} published={published} live={open} seatKind={seatKind} />
      )}
      {incomplete ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          This turn's side files may still grow.
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() => loaders.annotation(seat, turn, true)}
          >
            <RefreshCw className="size-3" aria-hidden="true" /> Refresh
          </Button>
        </p>
      ) : null}
    </Section>
  );
}

function Costs({
  rounds,
  annotation,
  laterCostNanoUsd,
  published,
  fake,
  open,
}: {
  readonly rounds: TurnRounds;
  readonly annotation: TurnAnnotation | null;
  /** The cost of the rounds after the playhead (a replayed open turn), left out of the spend. */
  readonly laterCostNanoUsd: number;
  readonly published: Published;
  readonly fake: boolean;
  readonly open: boolean;
}) {
  const t = rounds.totals;
  const spent =
    annotation?.spentNanoUsd === null || annotation?.spentNanoUsd === undefined
      ? null
      : Math.max(0, annotation.spentNanoUsd - laterCostNanoUsd);
  return (
    <Section
      title={open ? "Cost and tokens so far" : "Cost and tokens"}
      icon={Coins}
      testId="turn-costs"
    >
      {!published.costs ? (
        <>
          <NotPublished what="Costs" />
          {t.metered === 0 ? null : (
            <p className="text-muted-foreground text-xs">{plural(t.attempts, "model call")}</p>
          )}
        </>
      ) : t.metered === 0 ? (
        <p className="text-muted-foreground text-xs">No model call figures for this turn yet.</p>
      ) : (
        <>
          <p className="text-sm">
            <strong>{fmtUsd(t.costNanoUsd)}</strong> · {fmtInt(tokenSum(t.tokens))} tokens ·{" "}
            {plural(t.attempts, "model call")}
            {t.latencyMs > 0 ? ` · ${fmtLatency(t.latencyMs)} of model time` : null}
          </p>
          <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 text-xs">
            <dt>Input</dt>
            <dd className="tabular-nums">{fmtInt(t.tokens.input)}</dd>
            <dt>Cache writes</dt>
            <dd className="tabular-nums">
              {fmtInt(t.tokens.cacheWrite5m + t.tokens.cacheWrite1h)}
            </dd>
            <dt>Cache reads</dt>
            <dd className="tabular-nums">{fmtInt(t.tokens.cacheRead)}</dd>
            <dt>Output</dt>
            <dd className="tabular-nums">{fmtInt(t.tokens.output)}</dd>
          </dl>
          {spent === null ? null : (
            <p className="text-muted-foreground text-xs">
              Spent {fmtUsd(spent)} so far
              {annotation?.capNanoUsd === null || annotation?.capNanoUsd === undefined ? null : (
                <> of a {fmtUsd(annotation.capNanoUsd)} cap</>
              )}
              .
            </p>
          )}
          {fake ? (
            <p className="text-gold text-xs">
              Simulated prices: a fake model costs nothing; these are what a real one would have
              cost.
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}

function Ending({ item }: { readonly item: TurnItem }) {
  return (
    <Section title="How it ended" icon={Flag} testId="turn-ending">
      <p className="text-sm">
        {whyWords(item.why)}{" "}
        <span className="text-muted-foreground">
          (at <GameTime t={item.t} />)
        </span>
      </p>
    </Section>
  );
}

/** A turn's rounds from every source; refetched when the turn closes or a live round arrives. */
function useRounds(
  seat: PlayerId,
  turn: number,
  where: Where,
  llm: boolean,
): {
  readonly rounds: TurnRounds;
  readonly annotation: ReturnType<typeof useAnnotation>;
  readonly live: readonly AnnotMsg[];
  /** The cost of the rounds the playhead has not reached (a replayed open turn; else 0). */
  readonly laterCostNanoUsd: number;
} {
  // No annotation for a turn that comes later or that the seat never played.
  const none = where.k === "later" || (where.k === "missing" && where.played !== null);
  const annotation = useAnnotation(seat, turn, llm && !none);
  const live = useLiveAnnots(seat, turn);
  const mode = useMatch((s) => s.mode);
  const closed = where.k === "closed";
  // A turn that closes while shown: fetch its annotation again (the last rounds, the thought call).
  const wasOpen = useRef(where.k === "open");
  useEffect(() => {
    if (closed && wasOpen.current && llm) loaders.annotation(seat, turn, true);
    wasOpen.current = where.k === "open";
  }, [closed, where.k, llm, seat, turn]);
  // A live round brings no figures: the annotation has them, a moment later.
  useEffect(() => {
    if (!llm || where.k !== "open" || live.length === 0) return undefined;
    const timer = setTimeout(() => loaders.annotation(seat, turn, true), 800);
    return () => clearTimeout(timer);
  }, [llm, where.k, live, seat, turn]);
  const value = annotation?.status === "ok" ? annotation.value : null;
  const results = where.k === "closed" ? (where.item.results ?? NO_CALLS) : null;
  const ent = where.k === "open" ? where.ent : null;
  const shaped = useMemo(() => {
    const all = shapeRounds({ annotation: value, live, results });
    // Replaying an open turn: only the rounds whose calls the log has reached at the playhead,
    // with their own totals (the annotation holds the whole turn).
    if (ent === null || mode === "live") return { ...all, laterCostNanoUsd: 0 };
    return roundsUpTo(all, ent.round);
  }, [value, live, results, ent, mode]);
  return { rounds: shaped, annotation, live, laterCostNanoUsd: shaped.laterCostNanoUsd };
}

/** "Go to this turn": finds the turn's end in the feed route and seeks just after it. */
function GoToTurn({
  seat,
  name,
  turn,
}: {
  readonly seat: PlayerId;
  readonly name: string;
  readonly turn: number;
}) {
  const match = useMatch((s) => s.id);
  const running = useMatch((s) => isRunningStatus(s.status));
  const after = useMatch((s) => s.frame?.seq ?? -1);
  const [state, setState] = useState<"idle" | "busy" | "none" | "error">("idle");
  const go = async (): Promise<void> => {
    if (match === null) return;
    setState("busy");
    try {
      let cursor = after;
      for (let page = 0; page < 20; page += 1) {
        // oxlint-disable-next-line no-await-in-loop -- pages follow each other
        const res = await api.feed(match, {
          after: cursor,
          kinds: ["turn"],
          players: [seat],
          limit: 200,
        });
        for (const e of res.items) {
          if (e.item.k === "turn" && e.item.seat === seat && e.item.turn === turn) {
            controls.seekSeq(e.seq, e.item.t);
            setState("idle");
            return;
          }
        }
        const last = res.items.at(-1);
        if (!res.more || last === undefined) break;
        cursor = last.seq;
      }
      setState("none");
    } catch {
      setState("error");
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="secondary"
        className="w-fit"
        disabled={state === "busy"}
        onClick={() => void go()}
      >
        {state === "busy" ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
        ) : null}
        Go to the end of this turn
      </Button>
      {state === "none" ? (
        <p className="text-muted-foreground text-xs">
          {running
            ? "This turn has not ended in the log yet."
            : `${name} played no turn ${fmtInt(turn)} in this match.`}
        </p>
      ) : state === "error" ? (
        <p className="text-muted-foreground text-xs">The match's feed could not be read.</p>
      ) : null}
    </div>
  );
}

function Body({
  seat,
  info,
  turn,
}: {
  readonly seat: PlayerId;
  readonly info: SeatInfo;
  readonly turn: number;
}) {
  const where = useWhere(seat, turn);
  const published = usePublished();
  const handedOff = useMatch((s) => (s.frame?.seats[seat]?.handoff ?? null) !== null);
  const llm = where.k === "closed" ? where.item.llm : info.kind === "llm" && !handedOff;
  const fake = isFakeSeat(info);
  const following = useMatch((s) => s.mode === "live");
  const { rounds, annotation, live, laterCostNanoUsd } = useRounds(seat, turn, where, llm);
  const feed = useFeed();
  const item = where.k === "closed" ? where.item : null;
  const messages = useMemo(
    () =>
      where.k === "closed" || where.k === "open"
        ? turnMessages(feed, seat, turn, item?.messages)
        : [],
    [feed, seat, turn, item, where.k],
  );
  if (where.k === "loading") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 px-4 text-sm">
        <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> Loading this
        part of the match…
      </p>
    );
  }
  if (where.k === "later" || where.k === "missing") {
    return (
      <div className="flex flex-col gap-2 px-4 pb-6 text-sm">
        <p>
          {where.k === "later"
            ? `At this point of the match ${info.name} has played ${plural(where.played, "turn")}: turn ${fmtInt(turn)} comes later.`
            : where.played !== null
              ? `${info.name} played ${plural(where.played, "turn")} in this match: there is no turn ${fmtInt(turn)}.`
              : `The log has no end for turn ${fmtInt(turn)} of ${info.name}.`}
        </p>
        {where.k === "later" ? <GoToTurn seat={seat} name={info.name} turn={turn} /> : null}
      </div>
    );
  }
  const open = where.k === "open";
  const wake =
    where.k === "closed"
      ? { wakeT: where.item.wakeT, reasons: where.item.reasons, urgent: where.item.urgent }
      : { wakeT: where.ent.wakeT, reasons: where.ent.reasons, urgent: where.ent.urgent };
  return (
    <div className="flex flex-col gap-5 px-4 pb-6" data-turn-state={where.k}>
      {open ? (
        <p
          className="border-primary/50 bg-primary/10 text-primary flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
          data-testid="turn-open"
        >
          <Brain className="size-4 shrink-0 motion-safe:animate-pulse" aria-hidden="true" />
          <span>
            {following
              ? `In progress${roundOf(where.ent, live)}: rounds appear as their replies arrive; the verdicts, the thought and the ending come when the turn ends.`
              : `In progress at this point of the match${roundOf(where.ent, live)}: play on to see its verdicts, its thought and how it ends.`}
          </span>
        </p>
      ) : null}
      {llm ? null : (
        <p className="text-muted-foreground flex items-start gap-2 text-sm" data-testid="turn-bot">
          <Bot className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {info.kind === "bot"
            ? "A scripted bot plays this seat: no model, so no reasoning, rounds or costs. Its moves appear in the feed and on the map."
            : "A bot played this turn (the seat was handed over): no model call, so no reasoning or costs."}
        </p>
      )}
      <Wake {...wake} />
      <ThoughtAndMessages
        thought={item?.thought ?? null}
        messages={messages}
        open={open}
        bot={!llm}
      />
      {llm ? (
        <Rounds
          rounds={rounds}
          item={item}
          annotation={annotation}
          published={published}
          open={open}
          seat={seat}
          turn={turn}
          seatKind={seatReasoningKind(info)}
        />
      ) : item === null ? null : (
        <Section title="Actions" icon={ListChecks} testId="turn-rounds">
          <p className="text-sm">
            {plural(item.accepted, "action")} accepted
            {item.rejected.length === 0
              ? "."
              : `; rejected: ${item.rejected.map((r) => `${r.code} ×${fmtInt(r.count)}`).join(", ")}.`}
          </p>
          <p className="text-muted-foreground text-xs">
            Orders and messages count as actions; what it looked at does not.
          </p>
        </Section>
      )}
      {item === null ? null : <Ending item={item} />}
      {llm ? (
        <Costs
          rounds={rounds}
          annotation={annotation?.status === "ok" ? annotation.value : null}
          laterCostNanoUsd={laterCostNanoUsd}
          published={published}
          fake={fake}
          open={open}
        />
      ) : null}
    </div>
  );
}

/** ", round 3": the round an open turn is in (the log's or a newer live one). */
function roundOf(ent: SeatEnt, live: readonly AnnotMsg[]): string {
  const r = roundNow(ent.round, liveTopRound(live));
  return r === null ? "" : `, round ${fmtInt(r + 1)}`;
}

/**
 * Previous and next turn of the same seat (up to the turns opened at the playhead), and the seat's
 * dossier. A neighbour button that becomes disabled (turn 1, the last turn opened) hands the focus
 * to the other one, so the keyboard stays in the sheet's header.
 */
function Neighbours({ seat, turn }: { readonly seat: PlayerId; readonly turn: number }) {
  const opened = useMatch((s) => s.frame?.seats[seat]?.turn ?? 0);
  const prev = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const noPrev = turn <= 1;
  const noNext = turn >= opened;
  // From a turn past the last one opened, back to that one (not through turns that do not exist).
  const before = Math.max(1, Math.min(turn - 1, opened));
  const dossier = useRef<HTMLButtonElement>(null);
  // The button about to be disabled hands the focus over first (a disabled button drops it): to
  // the other one, or to "Dossier" when both will be.
  const go = (to: number, from: "prev" | "next"): void => {
    const prevOff = to <= 1;
    const nextOff = to >= opened;
    if (from === "prev" ? prevOff : nextOff) {
      const other =
        from === "prev" ? (nextOff ? null : next.current) : prevOff ? null : prev.current;
      (other ?? dossier.current)?.focus();
    }
    uiActions.openTurn(seat, to);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        ref={prev}
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        disabled={noPrev}
        onClick={() => go(before, "prev")}
      >
        <ChevronLeft className="size-3.5" aria-hidden="true" /> Turn {fmtInt(before)}
      </Button>
      <Button
        ref={next}
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        disabled={noNext}
        onClick={() => go(turn + 1, "next")}
      >
        Turn {fmtInt(turn + 1)} <ChevronRight className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        ref={dossier}
        size="sm"
        variant="ghost"
        className="ml-auto h-7 px-2 text-xs"
        data-testid="turn-dossier"
        onPointerEnter={() => LazyPlayerSheet.preload()}
        onFocus={() => LazyPlayerSheet.preload()}
        onClick={() => {
          // The dossier under this sheet (it was opened from there), or the seat's dossier in its
          // place; the focus goes back to what opened this sheet when the dossier closes.
          if (useUiStore.getState().selectedPlayer !== seat) uiActions.openPlayer(seat);
          uiActions.closeTurn();
        }}
      >
        <UserRound className="size-3.5" aria-hidden="true" /> Dossier
      </Button>
    </div>
  );
}

/** The last turn opened, kept while the sheet closes (its content stays during the animation). */
function useShown(open: OpenTurn | null): OpenTurn | null {
  const [shown, setShown] = useState(open);
  if (open !== null && open !== shown) setShown(open);
  return open ?? shown;
}

export function TurnSheet() {
  const open = useUi((s) => s.openTurn);
  const shown = useShown(open);
  const seat = useSeat(shown?.seat ?? "");
  const known = useMatch((s) => s.meta !== null);
  const content = useRef<HTMLDivElement>(null);
  const which = shown === null ? null : `${shown.seat}:${shown.turn}`;
  const last = useRef(which);
  // Another turn starts at its top.
  useLayoutEffect(() => {
    if (last.current !== which && content.current !== null) content.current.scrollTop = 0;
    last.current = which;
  }, [which]);
  return (
    <Sheet
      open={open !== null}
      onOpenChange={(o) => {
        if (!o) uiActions.closeTurn();
      }}
    >
      <SheetContent
        ref={content}
        data-testid="turn-sheet"
        className="w-full overflow-y-auto sm:max-w-xl"
      >
        <SheetHeader className="gap-1">
          <SheetTitle className="flex min-w-0 items-center gap-2 pr-6 text-lg">
            {seat === null || shown === null ? (
              "Turn"
            ) : (
              <>
                <PlayerGlyph color={seat.color} size={16} />
                <bdi className="truncate">{seat.name}</bdi>
                <span className="text-muted-foreground shrink-0 font-mono text-base font-normal">
                  · {seat.seat} · turn {shown.turn}
                </span>
              </>
            )}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {seat === null ? (
              "Turn detail"
            ) : (
              <>
                <span>Turn detail of</span>
                <Who id={seat.seat} />
                <ModelBadge seat={seat} />
              </>
            )}
          </SheetDescription>
          {seat === null || shown === null ? null : (
            <Neighbours seat={seat.seat} turn={shown.turn} />
          )}
        </SheetHeader>
        {shown !== null && seat === null && known ? (
          <p className="px-4 text-sm">This match has no player {shown.seat}.</p>
        ) : null}
        {seat === null || shown === null ? null : (
          <Body
            key={`${shown.seat}:${shown.turn}`}
            seat={seat.seat}
            info={seat}
            turn={shown.turn}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
