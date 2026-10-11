import type { CompiledRules, ConfigIssue, DeepReadonly } from "@perfidia/protocol";

// Generic checks of compiled rules (docs/architecture.md §3.6). They reject, with a path, any config
// that would otherwise fail mid-match: a 0 s duration, an empty turn, a budget that never refills.
// Paths are `CompiledRules` paths; they mirror the config paths where a ruleset copies a value
// (`gateway.*`, `time.*`).

/** A setup or config rejected before anything runs (`sim` exit code 3). Thrown by `createMatch`. */
export class MatchConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: readonly ConfigIssue[], context = "invalid match configuration") {
    const list = issues.map((i) => (i.path === "" ? i.message : `${i.path}: ${i.message}`));
    super(`${context}:\n  ${list.join("\n  ")}`);
    this.name = "MatchConfigError";
    this.issues = issues.map((i) => ({ path: i.path, message: i.message }));
  }
}

type Rules = DeepReadonly<CompiledRules>;

class Issues {
  readonly list: ConfigIssue[] = [];
  add(path: string, message: string): void {
    this.list.push({ path, message });
  }
}

function levelOf(rules: Rules, building: string | null): number | null {
  if (building === null) return null;
  const table = rules.buildings.find((b) => b.id === building);
  return table === undefined ? null : table.maxLevel;
}

function checkBuildings(rules: Rules, out: Issues): void {
  const speedMax = rules.roles.buildSpeed === null ? 0 : levelOf(rules, rules.roles.buildSpeed);
  if (speedMax === null) {
    out.add("roles.buildSpeed", `names no building of the ruleset (${rules.roles.buildSpeed})`);
  }
  for (const [i, b] of rules.buildings.entries()) {
    const at = `buildings.${i}`;
    if (b.cost.length < b.maxLevel + 1) {
      out.add(
        `${at}.cost`,
        `${b.id}: the cost table covers target levels up to ${b.cost.length - 1}, below maxLevel ${b.maxLevel}`,
      );
    }
    if (b.time.length < b.maxLevel + 1) {
      out.add(
        `${at}.time`,
        `${b.id}: the build time table covers target levels up to ${b.time.length - 1}, below maxLevel ${b.maxLevel}`,
      );
    }
    for (let level = 1; level < b.time.length && level <= b.maxLevel; level += 1) {
      const row = b.time[level] ?? [];
      if (speedMax !== null && row.length < speedMax + 1) {
        out.add(
          `${at}.time.${level}`,
          `${b.id} level ${level}: build times cover build-speed levels up to ${row.length - 1}, below ${speedMax}`,
        );
      }
      for (const [j, s] of row.entries()) {
        if (s < 1) {
          out.add(
            `${at}.time.${level}.${j}`,
            `${b.id} level ${level}: build time ${s} s; every duration must be at least 1 s`,
          );
        }
      }
    }
  }
}

function checkUnits(rules: Rules, out: Issues): void {
  for (const [i, u] of rules.units.entries()) {
    const at = `units.${i}`;
    const queue = rules.queues.recruit.find((q) => q.id === u.queue);
    if (queue === undefined) {
      out.add(`${at}.queue`, `${u.id}: recruit queue ${u.queue} is not in queues.recruit`);
      continue;
    }
    const max = levelOf(rules, queue.building);
    if (max === null) {
      out.add(`${at}.queue`, `${u.id}: queue ${u.queue} names no building (${queue.building})`);
      continue;
    }
    if (u.time.length < max + 1) {
      out.add(
        `${at}.time`,
        `${u.id}: recruit times cover ${queue.building} levels up to ${u.time.length - 1}, below maxLevel ${max}`,
      );
    }
    for (const [j, s] of u.time.entries()) {
      if (s < 1) {
        out.add(
          `${at}.time.${j}`,
          `${u.id}: recruit time ${s} s; every duration must be at least 1 s`,
        );
      }
    }
  }
}

function checkLevelTables(rules: Rules, out: Issues): void {
  const tables: [keyof Rules["levels"], readonly string[]][] = [
    [
      "production",
      [rules.roles.producers.wood, rules.roles.producers.stone, rules.roles.producers.gold],
    ],
    ["storage", [rules.roles.storage]],
    ["population", [rules.roles.population]],
  ];
  for (const [name, buildings] of tables) {
    const length = rules.levels[name].length;
    for (const building of buildings) {
      const max = levelOf(rules, building);
      if (max === null) {
        out.add(`roles`, `the ${name} table names no building of the ruleset (${building})`);
      } else if (length < max + 1) {
        out.add(
          `levels.${name}`,
          `covers levels up to ${length - 1}, below ${building}'s maxLevel ${max}`,
        );
      }
    }
  }
}

function checkNewCity(rules: Rules, out: Issues): void {
  const level = rules.newCity.buildings[rules.roles.storage] ?? 0;
  const cap = rules.levels.storage[level];
  if (cap === undefined) {
    out.add(
      "newCity.buildings",
      `the storage table does not cover ${rules.roles.storage} level ${level}`,
    );
    return;
  }
  for (const r of ["wood", "stone", "gold"] as const) {
    if (rules.newCity.stock[r] > cap) {
      out.add(
        `newCity.stock.${r}`,
        `${rules.newCity.stock[r]} ${r} exceeds the storage cap ${cap} of ${rules.roles.storage} level ${level}`,
      );
    }
  }
}

function checkTime(rules: Rules, out: Issues): void {
  if (rules.time.matchEnd < 1) {
    out.add("time.matchEnd", `is ${rules.time.matchEnd}; the match must last at least 1 s`);
  }
  if (rules.time.minTravel < 1) {
    out.add("time.minTravel", `is ${rules.time.minTravel}; every duration must be at least 1 s`);
  }
  if (rules.gateway.urgentMinGap >= rules.time.minTravel) {
    out.add(
      "gateway.urgentMinGap",
      `is ${rules.gateway.urgentMinGap}; it must stay below time.minTravel (${rules.time.minTravel})`,
    );
  }
}

function checkGateway(rules: Rules, out: Issues): void {
  const g = rules.gateway;
  if (g.selfWake.min < 1) {
    out.add("gateway.selfWake.min", `is ${g.selfWake.min}; a self-wake must be at least 1 s ahead`);
  }
  if (g.selfWake.min > g.selfWake.max) {
    out.add(
      "gateway.selfWake.min",
      `is ${g.selfWake.min}, above gateway.selfWake.max (${g.selfWake.max}); clamping needs min ≤ max`,
    );
  }
  if (g.safetyWake < g.selfWake.min) {
    out.add(
      "gateway.safetyWake",
      `is ${g.safetyWake}, below gateway.selfWake.min (${g.selfWake.min})`,
    );
  }
  if (g.roundTripsPerWake < 1) {
    out.add("gateway.roundTripsPerWake", "is 0; every turn would be empty");
  }
  if (g.toolCallsPerRoundTrip < 1) {
    out.add("gateway.toolCallsPerRoundTrip", "is 0; every turn would be empty");
  }
  if (g.toolCallsPerWake !== null && g.toolCallsPerWake < 1) {
    out.add("gateway.toolCallsPerWake", "is 0; use null for no cap, or at least 1");
  }
  if (g.ownWakesPerDay < 1) {
    out.add("gateway.ownWakesPerDay", "is 0; an exhausted budget would postpone own wakes forever");
  }
  if (g.socialWakesPerDay < 1) {
    out.add(
      "gateway.socialWakesPerDay",
      "is 0; an exhausted budget would postpone social wakes forever",
    );
  }
}

/**
 * The diplomacy durations the default handlers schedule from: a proposal expires `proposalTtl`
 * after it is made, a pact `pactDuration` after it is signed. A 0 would schedule an event at `now`,
 * which the kernel refuses mid-match (an `EngineBug`), so it is rejected here with its path.
 */
function checkDiplomacy(rules: Rules, out: Issues): void {
  const d = rules.diplomacy;
  if (d.proposalTtl < 1) {
    out.add("diplomacy.proposalTtl", `is ${d.proposalTtl}; every duration must be at least 1 s`);
  }
  if (d.pactDuration !== null && d.pactDuration < 1) {
    out.add(
      "diplomacy.pactDuration",
      `is ${d.pactDuration}; use null for pacts without expiry, or at least 1 s`,
    );
  }
}

/**
 * The generic checks of §3.6 on one compiled rule set: every build and recruit time ≥ 1 s and the
 * queue and level tables covering every `maxLevel`; the new-city stock within its storage cap;
 * `time.matchEnd ≥ 1`, `time.minTravel ≥ 1` and `gateway.urgentMinGap < time.minTravel`; the
 * self-wake range, the safety wake, the per-turn caps and both daily wake budgets; the diplomacy
 * durations (`proposalTtl ≥ 1`, `pactDuration` null or ≥ 1). Pure; an empty list means the rules
 * pass.
 */
export function checkRules(rules: DeepReadonly<CompiledRules>): ConfigIssue[] {
  const out = new Issues();
  checkTime(rules, out);
  checkGateway(rules, out);
  checkDiplomacy(rules, out);
  checkBuildings(rules, out);
  checkUnits(rules, out);
  checkLevelTables(rules, out);
  checkNewCity(rules, out);
  return out.list;
}
