import type { RulesetRef } from "@perfidia/protocol";

// The agent-visible ids of a perfidia-1 version, by the role each plays in the rules (the 1.0.0 id
// is the role's name). Modules shared by every version read ids through a table, so a version that
// renames them (1.1.0's Greek setting, docs/rulesets/perfidia-1.md §0.1) reuses their code
// unchanged. Canonical orders are the role orders below (§1.1).

/** Building roles in canonical order. */
export const BUILDING_ROLES = Object.freeze([
  "hall",
  "lumber",
  "quarry",
  "mine",
  "warehouse",
  "barracks",
  "harbor",
  "wall",
] as const);
export type BuildingRole = (typeof BUILDING_ROLES)[number];

/** Unit roles in canonical order. */
export const UNIT_ROLES = Object.freeze([
  "guard",
  "raider",
  "settler",
  "transport",
  "warship",
] as const);
export type UnitRole = (typeof UNIT_ROLES)[number];

/** Island kind roles in canonical order; `crown` is the neutral prize island. */
export const KIND_ROLES = Object.freeze([
  "crown",
  "home",
  "backyard",
  "frontier",
  "inner",
  "hub",
] as const);
export type KindRole = (typeof KIND_ROLES)[number];

/** The ids a perfidia-1 version gives each role. */
export interface PerfidiaNames {
  readonly ref: RulesetRef;
  readonly buildings: Readonly<Record<BuildingRole, string>>;
  readonly units: Readonly<Record<UnitRole, string>>;
  readonly kinds: Readonly<Record<KindRole, string>>;
  /** The `City.tag` of the neutral prize city, which is also its `start` seed key. */
  readonly prize: string;
}

/** Building ids in canonical order. */
export function buildingIds(names: PerfidiaNames): string[] {
  return BUILDING_ROLES.map((role) => names.buildings[role]);
}

/** Unit ids in canonical order. */
export function unitIds(names: PerfidiaNames): string[] {
  return UNIT_ROLES.map((role) => names.units[role]);
}

/** Island kinds in canonical order. */
export function kindIds(names: PerfidiaNames): string[] {
  return KIND_ROLES.map((role) => names.kinds[role]);
}

/** The start seeds of a version: the capital, a founded city and the prize city. */
export function seedKeys(names: PerfidiaNames): string[] {
  return ["capital", "newCity", names.prize];
}

/** perfidia-1@1.0.0: every id is its role's name; the prize is the Crown. */
export const NAMES_1_0_0: PerfidiaNames = Object.freeze({
  ref: "perfidia-1@1.0.0",
  buildings: Object.freeze({
    hall: "hall",
    lumber: "lumber",
    quarry: "quarry",
    mine: "mine",
    warehouse: "warehouse",
    barracks: "barracks",
    harbor: "harbor",
    wall: "wall",
  }),
  units: Object.freeze({
    guard: "guard",
    raider: "raider",
    settler: "settler",
    transport: "transport",
    warship: "warship",
  }),
  kinds: Object.freeze({
    crown: "crown",
    home: "home",
    backyard: "backyard",
    frontier: "frontier",
    inner: "inner",
    hub: "hub",
  }),
  prize: "crown",
});

/** perfidia-1@1.1.0: the Greek setting; the prize is Olympus (docs/rulesets/perfidia-1.md §0.1). */
export const NAMES_1_1_0: PerfidiaNames = Object.freeze({
  ref: "perfidia-1@1.1.0",
  buildings: Object.freeze({
    hall: "acropolis",
    lumber: "sawmill",
    quarry: "quarry",
    mine: "goldmine",
    warehouse: "warehouse",
    barracks: "barracks",
    harbor: "harbor",
    wall: "wall",
  }),
  units: Object.freeze({
    guard: "hoplite",
    raider: "peltast",
    settler: "settler",
    transport: "transport",
    warship: "trireme",
  }),
  kinds: Object.freeze({
    crown: "olympus",
    home: "home",
    backyard: "backyard",
    frontier: "frontier",
    inner: "inner",
    hub: "hub",
  }),
  prize: "olympus",
});
