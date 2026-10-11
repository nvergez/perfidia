import type { ReadCtx } from "@perfidia/engine/contracts";
import {
  citiesOf,
  freeSlots,
  popCap,
  popUsed,
  queueEtas,
  rates,
  relation,
  relationsOf,
  settlerK,
  sortedIds,
  stockAt,
  storageCap,
  travel,
  unitsAtHome,
} from "@perfidia/engine/std";
import { seatOf, todayCounters, type GatewayState } from "@perfidia/gateway/seat";
import {
  ReportIdSchema,
  compareIds,
  type BuildItemView,
  type City,
  type CityRow,
  type CityView,
  type CityViewFull,
  type CityViewPublic,
  type DeepReadonly,
  type DurationPair,
  type IntelSnapshot,
  type IslandId,
  type IslandView,
  type LeaderboardView,
  type MapIsland,
  type MapView,
  type PlayerId,
  type PlayerView,
  type ProposalView,
  type RecruitBatchView,
  type RelationView,
  type Res,
  type StationedView,
  type Standing,
} from "@perfidia/protocol";
import {
  durationPair,
  lookup,
  orderedUnits,
  resCopy,
  stripControl,
  timePair,
  visibilityOf,
  type SeatVisibility,
} from "./common.ts";
import { renderData } from "./events.ts";
import { byArrival, movementView, ownMovements, seenMovements } from "./movements.ts";

// Fog-of-war views (docs/architecture.md §8.1): pure functions of `(match.read(), seat, gateway
// state)` that build fresh objects and never write to either state (property P3). What a seat may
// see is decided by the ruleset's visibility hooks, with `std.defaultVisibility` as the fallback,
// and every derived number comes from `std`. A missing id gives `null`, which the tool layer turns
// into `UNKNOWN_ID`; ids that exist are public (cities, islands, players), so `null` reveals nothing.

type ReadCity = DeepReadonly<City>;

/** The public fields of a city, as `view_map` and `view_island` list them. */
function cityRow(vis: SeatVisibility, seat: PlayerId, c: ReadCity): CityRow {
  const row: CityRow = {
    id: c.id,
    island: c.island,
    slot: c.slot,
    owner: c.owner,
    capitalOf: c.capitalOf,
  };
  if (c.tag !== null) row["tag"] = c.tag;
  const ext = vis.publicCity(seat, c.id);
  if (Object.keys(ext).length > 0) row.ext = ext;
  return row;
}

function cityRows(r: ReadCtx, vis: SeatVisibility, seat: PlayerId, island?: string): CityRow[] {
  const rows: CityRow[] = [];
  for (const id of sortedIds(r.state.cities)) {
    const c = r.state.cities[id];
    if (c !== undefined && (island === undefined || c.island === island)) {
      rows.push(cityRow(vis, seat, c));
    }
  }
  return rows;
}

/** Travel time of every probe from `from` to `to`, in `rules.travelProbes` order. */
function probeTimes(r: ReadCtx, from: IslandId, to: IslandId): DurationPair[] {
  return r.rules.travelProbes.map((p) =>
    durationPair(travel(r, from, to, { kind: p.group.kind, units: { ...p.group.units } })),
  );
}

// view_city -------------------------------------------------------------------------------------

/** The latest spy or battle report about `city` in the seat's archive, with its age. */
function latestIntel(
  r: ReadCtx,
  gw: GatewayState,
  seat: PlayerId,
  city: string,
): IntelSnapshot | null {
  const archive = seatOf(gw, seat).archive;
  for (let i = archive.length - 1; i >= 0; i -= 1) {
    const ev = archive[i]?.event;
    if (ev === undefined || ev.data["city"] !== city) continue;
    if (ev.type !== "spy_report" && ev.type !== "battle_report") continue;
    const report = ReportIdSchema.safeParse(ev.data["report"]);
    if (!report.success) continue;
    return {
      report: report.data,
      type: ev.type,
      at: timePair(ev.t),
      age: durationPair(Math.max(0, r.now - ev.t)),
      data: renderData(ev.data),
    };
  }
  return null;
}

function stationedViews(r: ReadCtx, c: ReadCity): StationedView[] {
  return c.stationed.map((g) => ({
    owner: g.owner,
    home: g.home,
    role: g.role,
    units: orderedUnits(r.rules.units, g.units),
  }));
}

function queueViews(r: ReadCtx, c: ReadCity) {
  const build: BuildItemView[] = [];
  const recruit: Record<string, RecruitBatchView[]> = {};
  for (const q of r.rules.queues.recruit) recruit[q.id] = [];
  for (const eta of queueEtas(r, c.id)) {
    if (eta.kind === "build") {
      build.push({
        item: eta.item,
        building: eta.building,
        level: eta.level,
        start: timePair(eta.start),
        end: timePair(eta.end),
      });
    } else {
      const list = lookup(recruit, eta.queue) ?? [];
      list.push({
        item: eta.item,
        unit: eta.unit,
        count: eta.count,
        done: eta.done,
        start: timePair(eta.start),
        end: timePair(eta.end),
      });
      recruit[eta.queue] = list;
    }
  }
  return { build, recruit };
}

/**
 * `view_city`: with `cityAccess = "full"` (an own or allied city), stock, rates, storage cap,
 * population, buildings, queues with item numbers and times, units at home, stationed groups, and
 * the movements the seat can see heading to the city (`incoming`) or leaving it (`outgoing`, an
 * addition to §8.1: an ally sees the owner's outgoing movements exactly as `movementAccess`
 * grants); otherwise the public fields, the `publicCity` extras and the latest intel snapshot from
 * the seat's archive. `null` for an unknown city.
 */
export function viewCity(
  r: ReadCtx,
  seat: PlayerId,
  city: string,
  gw: GatewayState,
): CityView | null {
  const c = lookup(r.state.cities, city);
  if (c === undefined) return null;
  const vis = visibilityOf(r);
  const common = {
    id: c.id,
    name: stripControl(c.name),
    owner: c.owner,
    island: c.island,
    slot: c.slot,
    capitalOf: c.capitalOf,
    tag: c.tag,
    ext: vis.publicCity(seat, c.id),
  };
  if (vis.cityAccess(seat, c.id) !== "full") {
    const view: CityViewPublic = {
      access: "public",
      ...common,
      intel: latestIntel(r, gw, seat, c.id),
    };
    return view;
  }
  const seen = seenMovements(r, vis, seat).toSorted(byArrival);
  const { build, recruit } = queueViews(r, c);
  const buildings: Record<string, number> = {};
  for (const b of r.rules.buildings) buildings[b.id] = lookup(c.buildings, b.id) ?? 0;
  const view: CityViewFull = {
    access: "full",
    ...common,
    stock: stockAt(r, c.id),
    rates: rates(r, c.id),
    cap: storageCap(r, c.id),
    pop: { used: popUsed(r, c.id), cap: popCap(r, c.id) },
    buildings,
    build,
    recruit,
    units: orderedUnits(r.rules.units, unitsAtHome(r, c.id)),
    stationed: stationedViews(r, c),
    incoming: seen.filter((s) => s.m.to === c.id).map((s) => movementView(r, s.m, s.access, seat)),
  };
  view["outgoing"] = seen
    .filter((s) => s.m.from === c.id && s.m.to !== c.id)
    .map((s) => movementView(r, s.m, s.access, seat));
  return view;
}

// view_island, view_map -------------------------------------------------------------------------

/**
 * `view_island`: kind, coordinates, richness, slots, the cities on it and the free slots, and the
 * travel time from each own city for every travel probe. `null` for an unknown island.
 */
export function viewIsland(r: ReadCtx, seat: PlayerId, island: string): IslandView | null {
  const isl = lookup(r.state.islands, island);
  if (isl === undefined) return null;
  const vis = visibilityOf(r);
  const travelRows: IslandView["travel"] = [];
  for (const from of citiesOf(r, seat)) {
    const c = r.state.cities[from];
    if (c !== undefined) travelRows.push({ from, times: probeTimes(r, c.island, isl.id) });
  }
  return {
    id: isl.id,
    kind: isl.kind,
    x: isl.x,
    y: isl.y,
    richnessPm: isl.richnessPm,
    slots: isl.slots,
    cities: cityRows(r, vis, seat, isl.id),
    free: freeSlots(r, isl.id),
    probes: r.rules.travelProbes.map((p) => p.label),
    travel: travelRows,
  };
}

/**
 * `view_map`: every island (public fields and its number of free slots) and every city (public
 * fields and extras); with `fromCity`, the travel time from that city's island to every island for
 * every travel probe. `null` when `fromCity` is not a city.
 */
export function viewMap(r: ReadCtx, seat: PlayerId, fromCity?: string): MapView | null {
  const from = fromCity === undefined ? undefined : lookup(r.state.cities, fromCity);
  if (fromCity !== undefined && from === undefined) return null;
  const vis = visibilityOf(r);
  const islands: MapIsland[] = sortedIds(r.state.islands).flatMap((id) => {
    const isl = r.state.islands[id];
    if (isl === undefined) return [];
    return [
      {
        id: isl.id,
        kind: isl.kind,
        x: isl.x,
        y: isl.y,
        richnessPm: isl.richnessPm,
        slots: isl.slots,
        free: freeSlots(r, isl.id).length,
      },
    ];
  });
  const view: MapView = { islands, cities: cityRows(r, vis, seat) };
  if (from !== undefined) {
    view.from = from.id;
    view.probes = r.rules.travelProbes.map((p) => p.label);
    const times: NonNullable<MapView["travel"]> = {};
    for (const isl of islands) times[isl.id] = probeTimes(r, from.island, isl.id);
    view.travel = times;
  }
  return view;
}

// view_player, leaderboard ----------------------------------------------------------------------

function relationViews(r: ReadCtx, p: PlayerId): RelationView[] {
  return relationsOf(r, p).map((x) => ({
    player: x.player,
    kind: x.kind,
    until: x.until === null ? null : timePair(x.until),
  }));
}

function standingOf(standings: readonly Standing[], p: PlayerId): Standing | undefined {
  return standings.find((s) => s.player === p);
}

/** The text of proposal `id` from the seat's archive (its `proposal` event), or `""`. */
function proposalText(gw: GatewayState, seat: PlayerId, id: string): string {
  for (const d of seatOf(gw, seat).archive) {
    const ev = d.event;
    if (ev.type === "proposal" && ev.data["proposal"] === id) {
      const text = ev.data["text"];
      return typeof text === "string" ? stripControl(text) : "";
    }
  }
  return "";
}

/**
 * Every open proposal to or from the seat, by expiry then id, with its name and its text (from the
 * seat's archive, since texts are not in the state).
 */
export function openProposals(r: ReadCtx, seat: PlayerId, gw: GatewayState): ProposalView[] {
  return Object.values(r.state.proposals)
    .filter((q) => q.from === seat || q.to === seat)
    .toSorted((a, b) => a.expiresAt - b.expiresAt || compareIds(a.id, b.id))
    .map((q) => {
      const view: ProposalView = {
        id: q.id,
        from: q.from,
        to: q.to,
        kind: q.kind,
        name: q.name === null ? null : stripControl(q.name),
        text: proposalText(gw, seat, q.id),
        expires: timePair(q.expiresAt),
      };
      if (q.until !== null) view.until = timePair(q.until);
      return view;
    });
}

/** The next settler cost: `settlerCost[k]`, clamped to the last entry. */
function settlerCost(r: ReadCtx, k: number): Res {
  const costs = r.rules.settlerCost;
  const cost = costs[Math.min(k, costs.length - 1)];
  return cost === undefined ? { wood: 0, stone: 0, gold: 0 } : resCopy(cost);
}

function privateSection(r: ReadCtx, seat: PlayerId, gw: GatewayState): PlayerView["private"] {
  const movements = ownMovements(r, seat)
    .toSorted(byArrival)
    .map((s) => movementView(r, s.m, s.access, seat));
  const stationed: NonNullable<PlayerView["private"]>["stationed"] = [];
  for (const id of sortedIds(r.state.cities)) {
    for (const g of r.state.cities[id]?.stationed ?? []) {
      if (g.owner === seat) {
        stationed.push({
          city: id,
          role: g.role,
          home: g.home,
          units: orderedUnits(r.rules.units, g.units),
        });
      }
    }
  }
  const s = seatOf(gw, seat);
  const today = todayCounters(s, r.now);
  const k = settlerK(r, seat);
  return {
    movements,
    stationed,
    settler: { unit: r.rules.roles.settler, k, cost: settlerCost(r, k) },
    proposals: openProposals(r, seat, gw),
    today: {
      day: today.index,
      ownWakes: today.ownWakes,
      socialWakes: today.socialWakes,
      attacks: today.attacks,
      messages: today.messages,
    },
    selfWakeAt: s.wake.selfAt === null ? null : timePair(s.wake.selfAt),
  };
}

/**
 * `view_player`: the public profile (cities, score and its public parts, relations through
 * `std.relationsOf`, `publicPlayer` extras, the relation to the viewer) and, on the seat itself,
 * the `private` section: every own movement, every own group stationed away from home (`hold`
 * groups included), settler `k` and the next settler cost, the open proposals to and from the seat,
 * today's counters and the pending self-wake. `null` for an unknown player.
 */
export function viewPlayer(
  r: ReadCtx,
  seat: PlayerId,
  player: string,
  gw: GatewayState,
): PlayerView | null {
  const p = lookup(r.state.players, player);
  if (p === undefined) return null;
  const vis = visibilityOf(r);
  const standing = standingOf(r.ruleset.hooks.standings(r), p.id);
  const view: PlayerView = {
    id: p.id,
    alive: p.alive,
    eliminatedAt: p.eliminatedAt === null ? null : timePair(p.eliminatedAt),
    alliance: p.alliance,
    cities: citiesOf(r, p.id),
    score: standing?.score ?? 0,
    parts: { ...standing?.parts },
    relations: relationViews(r, p.id),
    relation: relation(r, seat, p.id),
    ext: vis.publicPlayer(p.id),
  };
  if (p.id === seat) view.private = privateSection(r, seat, gw);
  return view;
}

/** `leaderboard`: the ruleset's standings with each player's alliance and relations, and the `publicMatch` extras. */
export function leaderboard(r: ReadCtx): LeaderboardView {
  const vis = visibilityOf(r);
  const standings = r.ruleset.hooks.standings(r).map((s) => ({
    rank: s.rank,
    player: s.player,
    score: s.score,
    parts: { ...s.parts },
    cities: s.cities,
    alive: s.alive,
    alliance: lookup(r.state.players, s.player)?.alliance ?? null,
    relations: relationViews(r, s.player),
  }));
  return { standings, ext: vis.publicMatch() };
}
