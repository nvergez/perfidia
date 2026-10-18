import type { CityEnt, Frame, MatchMeta, PlayerEnt } from "@perfidia/protocol/spectator";
import { arrOf, field, numOf, strOf, timeOf } from "../lib/json.ts";
import { HOUR, fmtClock } from "../lib/time.ts";
import {
  configNumber,
  endOfMatch,
  genericCity,
  genericPlayer,
  genericReport,
  humanize,
  label,
  playerIds,
  rawLabel,
} from "./common.ts";
import type {
  DominationBloc,
  DominationCountdown,
  DominationView,
  Label,
  ReportView,
  Skin,
} from "./types.ts";

// The perfidia-1 skin (phase-3 design §4.5; docs/rulesets/perfidia-1.md): labels for the ids of each
// published version (1.1.0's Greek setting: acropolis, hoplite, trireme, Mount Olympus; 1.0.0's
// role names), verified against the ruleset's names table (`NAMES_1_1_0`, `NAMES_1_0_0`); the blocs,
// sieges and taken cities of its `ext`; and the win rule, whose numbers come from the config
// (`time.dominationStart`, `time.dominationHold`) and `ext.domination` (`need`, `needTaken`,
// `slots`), so a 6-day match or a 12-seat map reads its own numbers.

interface Names {
  readonly buildings: Readonly<Record<string, Label>>;
  readonly units: Readonly<Record<string, Label>>;
  readonly kinds: Readonly<Record<string, Label>>;
  readonly queues: Readonly<Record<string, Label>>;
  readonly prize: string;
  readonly prizeName: string;
  readonly setting: string;
}

const RESOURCES: Readonly<Record<string, Label>> = Object.freeze({
  wood: label("Wood", "trees", "Wood"),
  stone: label("Stone", "pickaxe", "Stone"),
  gold: label("Gold", "coins", "Gold"),
});

/** perfidia-1@1.1.0: the Greek setting. */
const GREEK: Names = Object.freeze({
  buildings: Object.freeze({
    acropolis: label("Acropolis", "landmark", "Acropolises"),
    sawmill: label("Sawmill", "trees"),
    quarry: label("Quarry", "pickaxe", "Quarries"),
    goldmine: label("Gold mine", "coins"),
    warehouse: label("Warehouse", "warehouse"),
    barracks: label("Barracks", "swords", "Barracks"),
    harbor: label("Harbor", "anchor"),
    wall: label("Wall", "shield"),
  }),
  units: Object.freeze({
    hoplite: label("Hoplite", "shield"),
    peltast: label("Peltast", "swords"),
    settler: label("Settler", "tent"),
    transport: label("Transport", "ship"),
    trireme: label("Trireme", "ship"),
  }),
  kinds: Object.freeze({
    olympus: label("Mount Olympus", "mountain", "Mount Olympus"),
    home: label("Home isle", "home"),
    backyard: label("Backyard isle", "home"),
    frontier: label("Frontier isle (rich, contested)", "mountain", "Frontier isles"),
    inner: label("Inner isle", "circle"),
    hub: label("Hub isle", "circle"),
  }),
  queues: Object.freeze({
    build: label("Construction", "landmark", "Constructions"),
    barracks: label("Barracks", "swords", "Barracks"),
    harbor: label("Harbor", "anchor"),
  }),
  prize: "olympus",
  prizeName: "Mount Olympus",
  setting: "Greek islands",
});

/** perfidia-1@1.0.0: the role names. */
const ROLES: Names = Object.freeze({
  buildings: Object.freeze({
    hall: label("Hall", "landmark"),
    lumber: label("Lumber mill", "trees"),
    quarry: label("Quarry", "pickaxe", "Quarries"),
    mine: label("Mine", "coins"),
    warehouse: label("Warehouse", "warehouse"),
    barracks: label("Barracks", "swords", "Barracks"),
    harbor: label("Harbor", "anchor"),
    wall: label("Wall", "shield"),
  }),
  units: Object.freeze({
    guard: label("Guard", "shield"),
    raider: label("Raider", "swords"),
    settler: label("Settler", "tent"),
    transport: label("Transport", "ship"),
    warship: label("Warship", "ship"),
  }),
  kinds: Object.freeze({
    crown: label("The Crown", "crown", "The Crown"),
    home: label("Home isle", "home"),
    backyard: label("Backyard isle", "home"),
    frontier: label("Frontier isle (rich, contested)", "mountain", "Frontier isles"),
    inner: label("Inner isle", "circle"),
    hub: label("Hub isle", "circle"),
  }),
  queues: Object.freeze({
    build: label("Construction", "landmark", "Constructions"),
    barracks: label("Barracks", "swords", "Barracks"),
    harbor: label("Harbor", "anchor"),
  }),
  prize: "crown",
  prizeName: "The Crown",
  setting: "islands",
});

const BATTLE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  city: "assault",
  relief: "relief of a besieged city",
  homecoming: "homecoming battle",
});

const SIEGE_CAUSES: Readonly<Record<string, string>> = Object.freeze({
  relief: "broken by a relief",
  homecoming: "broken by the owner's returning army",
  abandoned: "abandoned",
  eliminated: "the besieger was eliminated",
});

function namesOf(ruleset: string): Names {
  return ruleset === "perfidia-1@1.0.0" ? ROLES : GREEK;
}

function pick(table: Readonly<Record<string, Label>>, id: string): Label {
  return Object.hasOwn(table, id) ? (table[id] ?? rawLabel(id)) : rawLabel(id);
}

/** A span as the rule sentence says it: whole hours as `24 h`. */
function hours(s: number): string {
  return s % HOUR === 0 ? `${s / HOUR} h` : `${Math.round(s / 60)} min`;
}

function readDomination(meta: MatchMeta, frame: Frame): DominationView | null {
  const d = field(frame.ext, "domination");
  if (d === undefined) return null;
  const blocs: DominationBloc[] = arrOf(field(d, "blocs")).map((b) => ({
    key: strOf(field(b, "key")) ?? "?",
    members: playerIds(field(b, "members")),
    cities: numOf(field(b, "cities")) ?? 0,
    taken: numOf(field(b, "taken")) ?? 0,
  }));
  const countdowns: DominationCountdown[] = arrOf(field(d, "countdowns")).map((c) => ({
    key: strOf(field(c, "key")) ?? "?",
    members: playerIds(field(c, "members")),
    cities: numOf(field(c, "cities")),
    taken: numOf(field(c, "taken")),
    endsAt: timeOf(field(c, "ends")),
  }));
  const hold = configNumber(meta, ["time", "dominationHold"]);
  return {
    open: field(d, "open") === true,
    need: numOf(field(d, "need")),
    needTaken: numOf(field(d, "needTaken")),
    slots: numOf(field(d, "slots")),
    blocs,
    countdowns,
    opensAt: configNumber(meta, ["time", "dominationStart"]),
    hold,
    startBy: hold === null ? null : meta.matchEnd - hold,
  };
}

function ruleSentence(meta: MatchMeta, frame: Frame): string {
  const d = readDomination(meta, frame);
  const otherwise = `otherwise the highest score at ${endOfMatch(meta)} wins.`;
  if (d === null) return `The highest score at ${endOfMatch(meta)} wins.`;
  if (d.opensAt !== null && d.startBy !== null && d.startBy < d.opensAt) {
    // Too short for a countdown to finish: domination cannot decide this match.
    return `The highest score at ${endOfMatch(meta)} wins (this match ends before a bloc could hold cities long enough to win by domination, which opens at ${fmtClock(d.opensAt)}).`;
  }
  const what =
    d.need === null
      ? "enough cities"
      : d.slots === null
        ? `${d.need} cities`
        : `${d.need} of the ${d.slots} city slots`;
  const taken =
    d.needTaken !== null && d.needTaken > 0 ? `, ${d.needTaken} of them taken by conquest` : "";
  const hold = d.hold === null ? "" : `${taken === "" ? "" : ","} for ${hours(d.hold)}`;
  const window: string[] = [];
  if (d.opensAt !== null) window.push(`from ${fmtClock(d.opensAt)}`);
  if (d.startBy !== null) window.push(`start by ${fmtClock(d.startBy)}`);
  const when = window.length === 0 ? "" : ` (${window.join(", ")})`;
  return `A bloc wins by holding ${what}${taken}${hold}${when}; ${otherwise}`;
}

function report(names: Names, type: string, data: Readonly<Record<string, unknown>>): ReportView {
  const base = genericReport(type, data, (id) => pick(names.units, id));
  const kind = strOf(field(data, "kind"));
  if (type !== "battle_report") return base;
  const winner = strOf(field(data, "winner"));
  const attacker = strOf(field(data, "attacker")) ?? "?";
  const defender = strOf(field(data, "defender")) ?? "neutral";
  const city = strOf(field(data, "city")) ?? "?";
  const loot = field(data, "loot");
  const lootText = Object.keys(RESOURCES)
    .map((r) => `${numOf(field(loot, r)) ?? 0} ${pick(RESOURCES, r).name.toLowerCase()}`)
    .join(", ");
  const wall = field(data, "wall");
  return {
    title: `Battle at ${city}: ${kind === null ? "battle" : (BATTLE_KINDS[kind] ?? humanize(kind))}`,
    rows: [
      { label: "Attacker", value: attacker },
      { label: "Defender", value: defender },
      {
        label: "Winner",
        value: winner === null ? "?" : winner === "attacker" ? attacker : defender,
      },
      { label: "Loot", value: lootText },
      {
        label: `${pick(names.buildings, "wall").name} level`,
        value: `${numOf(field(wall, "before")) ?? 0} → ${numOf(field(wall, "after")) ?? 0}`,
      },
      { label: "Siege", value: strOf(field(data, "siege")) ?? "none" },
    ],
    stacks: base.stacks,
  };
}

/** The skin of a perfidia-1 version (1.1.0's labels for any version it does not know). */
export function perfidiaSkin(ruleset: string): Skin {
  const names = namesOf(ruleset);
  return {
    id: "perfidia-1",
    ruleset,
    setting: names.setting,
    building: (id) => pick(names.buildings, id),
    unit: (id) => pick(names.units, id),
    queue: (id) => pick(names.queues, id),
    islandKind: (kind) => pick(names.kinds, kind),
    resource: (id) => pick(RESOURCES, id),
    battleKind: (kind) => BATTLE_KINDS[kind] ?? humanize(kind),
    siegeCause: (cause) => SIEGE_CAUSES[cause] ?? humanize(cause),
    prizeName: names.prizeName,
    isPrizeIsland: (kind) => kind === names.prize,
    buildingOrder: Object.keys(names.buildings),
    unitOrder: Object.keys(names.units),
    city: (c: CityEnt) =>
      genericCity(c, c.tag === names.prize || field(c.ext, names.prize) === true),
    player: (p: PlayerEnt) => genericPlayer(p),
    domination: readDomination,
    ruleSentence,
    report: (type, data) => report(names, type, data),
  };
}
