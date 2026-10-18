import type { Frame, PlayerEnt, SeatEnt, SeatInfo, Standing } from "@perfidia/protocol/spectator";
import { Bot, Brain, Crown, Eye, Flag, Handshake, Landmark, Skull } from "lucide-react";
import { memo, useMemo } from "react";
import { ModelBadge } from "../common/model-badge.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { unitsText } from "../feed/bits.tsx";
import { cn } from "../lib/cn.ts";
import { playerColor } from "../lib/colors.ts";
import { fmtInt, plural } from "../lib/format.ts";
import { fmtTime } from "../lib/time.ts";
import { PlayerCard } from "../players/player-card.tsx";
import type { Skin } from "../skins/index.ts";
import { useMatch, useSeats, useSkin, useStandings } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import { scoreSegments } from "./board.ts";
import { Tip } from "./tip.tsx";

// The leaderboard (phase-3 design §4.3): one row per player at the playhead, by rank: colour and
// shape, name and id, who plays it ("Opus 5.5 · medium", "Bot" or "Fake"), the score as a bar
// whose parts show on hover, cities, cities taken by conquest, the army's population (which only
// spectators see), the alliance and pacts with their expiry, and what the seat is doing (thinking,
// eliminated, handed to a bot). Hovering a row highlights the player on the map; its name opens the
// dossier.

const NO_PLAYERS: Frame["players"] = Object.freeze({});
const NO_SEATS: Frame["seats"] = Object.freeze({});
const NO_ALLIANCES: Frame["alliances"] = Object.freeze({});
const OPACITY = [1, 0.55, 0.32, 0.2];

const clearHighlight = (): void => uiActions.setHighlight([]);

interface RowProps {
  readonly standing: Standing;
  readonly player: PlayerEnt | undefined;
  readonly seat: SeatInfo | undefined;
  readonly seatEnt: SeatEnt | undefined;
  readonly allianceName: string | null;
  readonly max: number;
  readonly winner: boolean;
  readonly skin: Skin | null;
}

function hasStatus(
  player: PlayerEnt | undefined,
  seatEnt: SeatEnt | undefined,
  winner: boolean,
): boolean {
  return (
    winner ||
    (player !== undefined && !player.alive) ||
    (seatEnt?.handoff ?? null) !== null ||
    seatEnt?.inTurn === true
  );
}

function Status({
  player,
  seatEnt,
  winner,
}: {
  readonly player: PlayerEnt | undefined;
  readonly seatEnt: SeatEnt | undefined;
  readonly winner: boolean;
}) {
  if (winner) {
    return (
      <span className="text-gold inline-flex items-center gap-1 text-xs font-medium">
        <Crown className="size-3" aria-hidden="true" /> winner
      </span>
    );
  }
  if (player !== undefined && !player.alive) {
    return (
      <span className="text-betrayal inline-flex items-center gap-1 text-xs">
        <Skull className="size-3" aria-hidden="true" /> eliminated
        {player.eliminatedAt === null ? null : ` ${fmtTime(player.eliminatedAt)}`}
      </span>
    );
  }
  if (seatEnt?.handoff !== null && seatEnt?.handoff !== undefined) {
    return (
      <span
        className="text-muted-foreground inline-flex items-center gap-1 text-xs"
        title={`Handed to ${seatEnt.handoff.label} at ${fmtTime(seatEnt.handoff.t)}`}
      >
        <Bot className="size-3" aria-hidden="true" /> handed to a bot
      </span>
    );
  }
  if (seatEnt?.inTurn === true) {
    return (
      <span className="text-primary inline-flex items-center gap-1 text-xs">
        <Brain className="size-3 motion-safe:animate-pulse" aria-hidden="true" /> thinking…
        {seatEnt.round === null ? null : ` round ${seatEnt.round + 1}`}
      </span>
    );
  }
  return null;
}

const Row = memo(function Row({
  standing,
  player,
  seat,
  seatEnt,
  allianceName,
  max,
  winner,
  skin,
}: RowProps) {
  const id = standing.player;
  const color = seat === undefined ? playerColor(0) : playerColor(seat.color);
  const segments = scoreSegments(standing.parts, max);
  const partsText = segments.map((s) => `${s.label} ${fmtInt(s.value)}`).join(", ");
  const taken = player === undefined || skin === null ? null : skin.player(player).taken;
  const army = player?.army ?? null;
  const armyUnits =
    army === null || skin === null
      ? ""
      : unitsText(army.units, (u) => skin.unit(u), skin.unitOrder);
  const pacts = (player?.relations ?? []).filter((r) => r.kind === "pact");
  const highlight = (): void => uiActions.setHighlight([id]);
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- hover and focus within the row highlight the player on the map; its buttons are the controls
    <li
      data-player={id}
      onMouseEnter={highlight}
      onMouseLeave={clearHighlight}
      onFocus={highlight}
      onBlur={clearHighlight}
      className={cn(
        "hover:bg-accent/40 flex flex-col gap-1 rounded-lg px-1.5 py-1.5",
        !standing.alive && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="text-muted-foreground w-4 shrink-0 text-right text-xs tabular-nums">
          {standing.rank}
        </span>
        <PlayerCard player={id}>
          <button
            type="button"
            onClick={() => uiActions.openPlayer(id)}
            className="flex min-w-0 items-center gap-1.5 text-left hover:underline"
          >
            <PlayerGlyph color={seat?.color ?? null} size={12} />
            {seat === undefined ? null : <bdi className="truncate font-medium">{seat.name}</bdi>}
            <span className="text-muted-foreground shrink-0 font-mono text-[0.85em]">
              {seat === undefined ? id : `· ${id}`}
            </span>
          </button>
        </PlayerCard>
        {seat === undefined ? null : <ModelBadge seat={seat} className="shrink-0 px-1.5" />}
        <span className="ml-auto shrink-0 font-mono font-semibold tabular-nums">
          {fmtInt(standing.score)}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-5.5">
        <Tip
          label={`Score ${fmtInt(standing.score)}: ${partsText}`}
          tip={
            <span className="flex flex-col">
              <strong>Score {fmtInt(standing.score)}</strong>
              {segments.map((s) => (
                <span key={s.key}>
                  {s.label}: {fmtInt(s.value)}
                </span>
              ))}
            </span>
          }
          className="bg-muted h-2 min-w-0 flex-1 overflow-hidden rounded-full"
        >
          {segments.map((s, i) => (
            <span
              key={s.key}
              className="block h-full first:rounded-l-full"
              style={{ width: `${s.pct}%`, backgroundColor: color, opacity: OPACITY[i] ?? 0.2 }}
            />
          ))}
        </Tip>
        <Tip
          label={plural(standing.cities, "city", "cities")}
          tip={plural(standing.cities, "city", "cities")}
          className="text-muted-foreground text-xs"
        >
          <Landmark className="size-3" aria-hidden="true" />
          {standing.cities}
        </Tip>
        {taken === null ? null : (
          <Tip
            label={`${plural(taken, "city", "cities")} taken by conquest`}
            tip={`${plural(taken, "city", "cities")} taken by conquest and held`}
            className="text-muted-foreground text-xs"
          >
            <Flag className="size-3" aria-hidden="true" />
            {taken}
          </Tip>
        )}
        {army === null ? null : (
          <Tip
            label={`Army population ${fmtInt(army.pop)}, hidden from the players`}
            tip={
              <span className="flex flex-col gap-0.5">
                <strong>Army: population {fmtInt(army.pop)}</strong>
                {armyUnits === "" ? null : <span>{armyUnits}</span>}
                <span className="opacity-80">
                  Only spectators see armies: the players never know each other's.
                </span>
              </span>
            }
            className="text-muted-foreground text-xs"
          >
            <Eye className="size-3" aria-hidden="true" />
            {fmtInt(army.pop)}
          </Tip>
        )}
      </div>
      {allianceName === null && pacts.length === 0 && !hasStatus(player, seatEnt, winner) ? null : (
        <div className="flex flex-wrap items-center gap-1 pl-5.5">
          {allianceName === null ? null : (
            <span className="border-gold/50 text-gold inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 text-xs">
              <Handshake className="size-3 shrink-0" aria-hidden="true" />
              <PlainText text={allianceName} className="truncate" />
            </span>
          )}
          {pacts.map((r) => (
            <span
              key={r.player}
              className="text-muted-foreground inline-flex items-center gap-1 rounded-full border px-1.5 text-xs"
              title={`Non-aggression pact with ${r.player}${r.until === null ? "" : ` until ${fmtTime(r.until)}`}`}
            >
              pact <span className="font-mono">{r.player}</span>
              {r.until === null ? null : <span className="opacity-80">to {fmtTime(r.until)}</span>}
            </span>
          ))}
          <Status player={player} seatEnt={seatEnt} winner={winner} />
        </div>
      )}
    </li>
  );
});

export function Leaderboard() {
  const standings = useStandings();
  const players = useMatch((s) => s.frame?.players ?? NO_PLAYERS);
  const seatEnts = useMatch((s) => s.frame?.seats ?? NO_SEATS);
  const alliances = useMatch((s) => s.frame?.alliances ?? NO_ALLIANCES);
  const result = useMatch((s) => s.frame?.result ?? null);
  const seats = useSeats();
  const skin = useSkin();
  const bySeat = useMemo(() => new Map(seats.map((s) => [s.seat, s])), [seats]);
  const max = standings.reduce((m, s) => Math.max(m, s.score), 0);
  return (
    <section
      aria-label="Leaderboard"
      data-testid="leaderboard"
      className="bg-card rounded-xl border p-3"
    >
      <h2 className="text-muted-foreground mb-1.5 flex items-center text-xs font-semibold tracking-wider uppercase">
        Leaderboard
        <span className="ml-auto font-normal tracking-normal normal-case">score</span>
      </h2>
      <ol className="flex flex-col gap-0.5">
        {standings.map((st) => {
          const player = players[st.player];
          const allianceId = player?.alliance ?? null;
          const alliance =
            allianceId === null
              ? null
              : (Object.values(alliances).find((a) => a?.id === allianceId) ?? null);
          return (
            <Row
              key={st.player}
              standing={st}
              player={player}
              seat={bySeat.get(st.player)}
              seatEnt={seatEnts[st.player]}
              allianceName={alliance?.name ?? null}
              max={max}
              winner={result?.winners.includes(st.player) ?? false}
              skin={skin}
            />
          );
        })}
      </ol>
    </section>
  );
}
