import type { SeatInfo, SeatStats } from "@perfidia/protocol/spectator";
import { Cpu, Eye, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { GameTime } from "../common/game-time.tsx";
import { NotPublished } from "../common/not-published.tsx";
import { ReasoningKindTag } from "../common/reasoning-kind.tsx";
import { fmtInt, fmtUsd, plural } from "../lib/format.ts";
import {
  effortWords,
  endpointVariant,
  fullModelName,
  hostName,
  isFakeSeat,
  providerName,
  reasoningKindHint,
  rehearsalOf,
  seatReasoningKind,
  servingProvider,
  type ModelRef,
} from "../lib/models.ts";
import {
  channelWords,
  countsWords,
  fmtMs,
  fmtPermille,
  fmtTokens,
  fmtUsdFine,
  handoffWords,
  mainReasoningKind,
  perPartner,
  reasoningKindsWords,
  remindersWords,
  atStatsEnd,
  seriesWords,
  total,
  wholeMatchShown,
} from "../models/format.ts";
import { useMatch, usePublished } from "../store/hooks.ts";
import { isRunningStatus } from "../store/session.ts";
import { useMatchStats } from "./match-stats.ts";

// The dossier's model block (phase-4 design §6.3; docs/phase4.md §45): who the seat's model is
// (its full name, provider, routing endpoint and quantization, effort in the vendor's own terms,
// and what its reasoning shows: a provider's summary or a raw chain of thought), how the harness
// spoke to it (profile, channel, reminders, lineup and series), and over the whole match what it
// spent against its cap and the match budget (when costs are published), how its calls went and
// what went wrong. A fake seat reads as a rehearsal, never as the model it stands in for. From
// `GET /api/matches/:id/stats`, shared by the match's dossiers; before it comes (or without it),
// what the seat list says. A chunk loaded on demand with the dossier.
//
// The statistics cover the whole match (or a running match so far), so in a replay they would tell
// what happens after the time shown (a hand-off, the spend, the calls): phase 3 §16.8 keeps the
// dossier at the playhead. Who the model is, its effort, reasoning kind, harness and lineup show
// always; the whole-match figures only at the end of the match, while following it live, or once
// the viewer asks for them ("Show the whole match's figures").

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** "OpenRouter · endpoint z-ai/fp8 (fp8), served by Z.AI"; "OpenAI". */
function providerLine(m: ModelRef, quantization: string | null): string {
  const provider = servingProvider(m);
  const ep = m.endpoint ?? null;
  if (ep === null || ep === "") return providerName(provider);
  const q = quantization ?? endpointVariant(ep);
  return `${providerName(provider)} · endpoint ${ep}${q === null ? "" : ` (${q})`}, served by ${hostName(ep)}`;
}

function incidentsOf(s: SeatStats): ReactNode {
  const i = s.incidents;
  const parts: { readonly key: string; readonly node: ReactNode }[] = [];
  if (i.handoff !== null) {
    parts.push({
      key: "handoff",
      node: (
        <>
          handed to <span className="font-mono">{i.handoff.label}</span> at{" "}
          <GameTime t={i.handoff.t} /> ({handoffWords(i.handoff.reason)})
        </>
      ),
    });
  }
  if (i.wakeCaps > 0) parts.push({ key: "wake", node: `${plural(i.wakeCaps, "wake cap")} hit` });
  if (i.promptCaps > 0)
    parts.push({ key: "prompt", node: plural(i.promptCaps, "prompt-cap stop") });
  if (i.errorWakes > 0) {
    parts.push({ key: "error", node: `${plural(i.errorWakes, "wake")} ended by an error` });
  }
  const refused = total(i.refusals);
  if (refused > 0) {
    parts.push({
      key: "refusal",
      node: `${plural(refused, "refusal")} (${countsWords(i.refusals)})`,
    });
  }
  if (i.fallbackPermille > 0) {
    parts.push({
      key: "fallback",
      node: `${fmtPermille(i.fallbackPermille)} of attempts served by a fallback`,
    });
  }
  if (parts.length === 0) return "none";
  return parts.map((p, n) => (
    <span key={p.key}>
      {n > 0 ? " · " : null}
      {p.node}
    </span>
  ));
}

function Harness({ s }: { readonly s: SeatStats }) {
  if (s.profile === null && s.promptVariant === null) return null;
  return (
    <Row label="Harness">
      {s.profile === null ? null : (
        <>
          profile <span className="font-mono">{s.profile}</span>
        </>
      )}
      {s.promptVariant === null ? null : (
        <>
          {s.profile === null ? null : " · "}
          operator notes as {channelWords(s.promptVariant)}
        </>
      )}
      {s.reminders === null ? null : <> · {remindersWords(s.reminders)}</>}
    </Row>
  );
}

/** The whole match's figures (or a running match's so far): shown only as `wholeMatchShown` says. */
function Figures({ s, fake }: { readonly s: SeatStats; readonly fake: boolean }) {
  const published = usePublished();
  const running = useMatch((st) => isRunningStatus(st.status));
  const ops = s.operations;
  const same = s.diplomacy.sameModel;
  const cross = s.diplomacy.crossModel;
  const cost = s.cost;
  const tools = ops === null ? null : ops.toolErrors.malformed + ops.toolErrors.invalidArgs;
  return (
    <>
      <Row label="Calls">
        {plural(s.play.wakes, "wake")} · {plural(s.play.rounds, "round")} ·{" "}
        {plural(s.play.calls, "tool call")}
        {ops === null ? null : (
          <>
            {" "}
            · {plural(ops.attempts, "attempt")}
            {s.incidents.parallelPermille === null ? null : (
              <> · {fmtPermille(s.incidents.parallelPermille)} of tool rounds parallel</>
            )}
            {tools === null ? null : <> · {plural(tools, "tool-call error")}</>}
            {ops.latencyMs === null || ops.latencyMs.p95 === 0 ? null : (
              <>
                {" "}
                · latency {fmtMs(ops.latencyMs.p50)} median, {fmtMs(ops.latencyMs.p95)} p95
              </>
            )}
          </>
        )}
      </Row>
      <Row label="Incidents">{incidentsOf(s)}</Row>
      {!published.costs || cost === null ? null : (
        <Row label={running ? "Spent so far" : "Spent"}>
          <span data-testid="model-spend">
            {fmtUsdFine(cost.nanoUsd)}
            {cost.perWakeNanoUsd === null ? null : (
              <> · {fmtUsdFine(cost.perWakeNanoUsd)} a wake</>
            )}{" "}
            · cache reads {fmtPermille(cost.cacheReadPermille)} of the prompt ·{" "}
            {fmtTokens(
              cost.tokens.input +
                cost.tokens.cacheWrite5m +
                cost.tokens.cacheWrite1h +
                cost.tokens.cacheRead +
                cost.tokens.output,
            )}{" "}
            tokens
            {cost.feesNanoUsd > 0 ? <> · fees {fmtUsdFine(cost.feesNanoUsd)}</> : null}
            {fake ? <span className="text-muted-foreground"> (simulated prices)</span> : null}
          </span>
        </Row>
      )}
      {same === null ||
      cross === null ||
      same.partners === 0 ||
      same.messages + same.pacts + same.alliances === 0 ? null : (
        <Row label="Same model">
          {plural(same.messages, "message")} sent, {plural(same.pacts, "pact")},{" "}
          {plural(same.alliances, "alliance")} with its {plural(same.partners, "seat")} on its own
          model ({perPartner(same.messages + same.pacts + same.alliances, same.partners)}); with its{" "}
          {plural(cross.partners, "seat")} on others {fmtInt(cross.messages)}, {fmtInt(cross.pacts)}
          , {fmtInt(cross.alliances)} (
          {perPartner(cross.messages + cross.pacts + cross.alliances, cross.partners)})
        </Row>
      )}
    </>
  );
}

/** The model block of an LLM seat's dossier. */
export function ModelBlock({ seat }: { readonly seat: SeatInfo }) {
  const match = useMatch((s) => s.id);
  const running = useMatch((s) => isRunningStatus(s.status));
  const published = usePublished();
  const status = useMatch((s) => s.status);
  const state = useMatchStats(match, status);
  const stats = state?.status === "ok" ? state.value : null;
  const [asked, setAsked] = useState(false);
  const lastT = stats?.lastT ?? Number.POSITIVE_INFINITY;
  const live = useMatch((s) => s.mode === "live");
  const atEnd = useMatch((s) => atStatsEnd(s.playhead, lastT));
  const whole = wholeMatchShown({ atEnd, live, asked });
  const s = stats?.seats.find((x) => x.seat === seat.seat) ?? null;
  const fake = isFakeSeat(seat);
  const m: ModelRef | null =
    s?.model === null || s?.model === undefined
      ? seat.model
      : {
          provider: s.model.provider,
          model: s.model.model,
          endpoint: s.model.endpoint,
          intended: s.model.intended,
        };
  const effort = s?.model?.effort ?? seat.model?.effort ?? null;
  const sent = s?.model?.effortSent ?? null;
  const kinds = s?.operations?.reasoningKinds ?? null;
  const kind = (kinds === null ? null : mainReasoningKind(kinds)) ?? seatReasoningKind(seat);
  const provider = m === null ? null : servingProvider(m);
  return (
    <section
      aria-label="Model"
      data-testid="model-block"
      className="bg-card flex flex-col gap-2 rounded-md border p-2.5 text-sm"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Cpu className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          {m === null ? (
            <p className="font-medium">Language model (not named)</p>
          ) : fake ? (
            <>
              <p className="text-gold font-medium">Rehearsal</p>
              <p className="text-muted-foreground text-xs">
                A scripted bot {rehearsalOf({ fake, model: m }) ?? "stands in for a model"}: its
                play, reasoning and costs are the bot's, priced at that model's card.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium" data-testid="model-name">
                {fullModelName(m)}
              </p>
              <p className="text-muted-foreground text-xs">
                {providerLine(m, s?.model?.quantization ?? null)}
              </p>
            </>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-[minmax(4.5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {effort === null || provider === null ? null : (
          <Row label="Effort">
            {effortWords(provider, effort)}
            {sent === null || sent === effort ? null : (
              <span className="text-muted-foreground">
                {" "}
                (sent as {sent}: the nearest level the endpoint takes)
              </span>
            )}
          </Row>
        )}
        <Row label="Reasoning">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {kind === null ? "not logged" : <ReasoningKindTag kind={kind} />}
            {kind === null ? null : (
              <span className="text-muted-foreground">{reasoningKindHint(kind)}</span>
            )}
            {kinds === null || !published.reasoning || !whole ? null : (
              <span className="text-muted-foreground">attempts: {reasoningKindsWords(kinds)}</span>
            )}
          </span>
        </Row>
        {stats === null ? null : stats.lineup === null && stats.series === null ? null : (
          <Row label="Lineup">
            {stats.lineup === null ? null : <span className="font-mono">{stats.lineup}</span>}
            {stats.series === null ? null : <> · {seriesWords(stats.series)}</>}
          </Row>
        )}
        {s === null ? null : <Harness s={s} />}
        {s === null || published.costs ? null : (
          <Row label="Spent">
            <NotPublished what="Costs" />
          </Row>
        )}
        {s === null || !whole ? null : <Figures s={s} fake={fake} />}
        {stats === null || stats.cost === null || !published.costs || !whole ? null : (
          <Row label="Match">
            {fmtUsdFine(stats.cost.nanoUsd)} spent by every seat together
            {stats.cost.budgetNanoUsd === null ? null : (
              <>, of a {fmtUsd(stats.cost.budgetNanoUsd)} budget</>
            )}
          </Row>
        )}
      </dl>
      {state === null ||
      state.status === "loading" ||
      (state.status === "error" && state.code === "LOADING") ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" /> Loading the
          match's statistics…
        </p>
      ) : state.status === "error" ? (
        <p className="text-muted-foreground text-xs">
          The match's statistics are not available ({state.message}).
        </p>
      ) : s === null ? null : whole ? (
        <p className="text-muted-foreground text-[0.7rem]" data-testid="model-whole">
          {running ? "So far in this match" : "Over the whole match"}
          {asked && !live ? ", whatever the time shown" : ""}.
        </p>
      ) : (
        <div className="flex flex-col items-start gap-1" data-testid="model-later">
          <p className="text-muted-foreground text-[0.7rem]">
            Its calls, incidents and spending cover the whole match: they would tell what happens
            after the time shown.
          </p>
          <button
            type="button"
            onClick={() => setAsked(true)}
            className="text-primary hover:text-primary/80 flex items-center gap-1 text-xs font-medium"
          >
            <Eye className="size-3" aria-hidden="true" /> Show the whole match's figures
          </button>
        </div>
      )}
    </section>
  );
}
