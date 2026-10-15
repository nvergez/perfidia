# Perfidia V1.1 game rules (`perfidia-1`)

> **Ruleset `perfidia-1@1.1.0` (the default: the bare id `perfidia-1` resolves to it).** This document specifies version 1.1.0 of ruleset `perfidia-1`, implemented in `packages/engine/src/rulesets/perfidia-1/` (descriptor `v1_1_0.ts`, see `docs/architecture.md` §3). `perfidia-1@1.0.0` stays registered and frozen; it differs only as listed in §0.1, and its full text is `docs/rulesets/perfidia-1-v1.0.0.md`.
>
> - Published versions are frozen. Any change to behaviour, defaults, tables or agent-visible text (cheat sheet, error wording) ships as a new version, such as `perfidia-1@1.2.0`, with its own header; matches recorded under 1.1.0 (or 1.0.0) keep re-simulating exactly under their own version.
> - A match may override config numbers. The override is validated by this ruleset's schema and by the checks of `docs/architecture.md` §3.6, and the log stores the ruleset ref, the overrides, the effective config and its hash. Fields marked as fixed in §16 cannot be overridden.
> - Engineering notes:
>   - The ruleset ref replaces an `id` field in the config. The §16 schema lives in the ruleset module, not in `protocol`. The sine table of §2.2 is a code constant of the ruleset, not a config field.
>   - Materialisation (§1.5) happens only inside actions and event handlers. Views and validation compute stock and trickled units without writing (architecture §4.3).
>   - The pacing criteria of §19.5 are measured and reported by `sim batch --pacing`, never asserted. A failed criterion becomes a proposal for a later version.

> **Status.** These are the final V1 rules for phase 1 (engine, scripted bots, no LLM). They are the source of truth for `protocol`, `engine`, `gateway`, `bots` and `sim`.
>
> - Every number below is a default stored in `RulesConfig` (§16). The engine never hard-codes a number, and each match stores the hash of its config.
> - Every formula uses integers only. Every duration is in game-seconds. Every tie has a stated deterministic break.
> - The pacing figures (§15) come from a scripted, peaceful reference bot run on these exact tables. They are targets: phase-1 `sim` matches with fighting bots must re-measure them before any LLM spend.
>
> **Lineage.** The base is the "Archipelago Classic" design (`classic-1`). The map shape, the economy curves and the travel model were re-tuned. Grafts from "Lean Ring" and "Ring & Crown", plus every must-fix from the balance, drama and legibility reviews, are listed in §17.

**Contents:**

- 0 Cheat sheet, and 0.1 Changes from 1.0.0
- 1 Conventions and determinism
- 2 Map
- 3 Starting state
- 4 Economy
- 5 Buildings
- 6 Units
- 7 Movements
- 8 Combat
- 9 Sieges, conquest, Olympus, elimination
- 10 Espionage
- 11 Diplomacy
- 12 Visibility
- 13 Score and victory
- 14 Gateway rules
- 15 Pacing
- 16 RulesConfig
- 17 Design rationale
- 18 Tuning knobs
- 19 Phase-1 acceptance checks

---

## 0. Cheat sheet

The `rules` tool returns this block verbatim, followed by the config and the derived per-level tables. Every mechanic in the game appears on it.

```
TIME        integer game-seconds. 1 day = 86400. Match = 7 days = 604800.
            No attack launches before 12:00 (43200). Capitals cannot be besieged before day 3 (172800).
TRAVEL      same island: 1 h. Other island: tiles × 60 s (with transports), × 45 s (triremes only),
            × 30 s (spy, no units). Never less than 1 h. Same time both ways. view_map lists them.
            An incoming attack shows its origin, owner, launch and arrival times, never its units.
            Its pace therefore shows whether it is triremes only.
            A return heading into a city you besiege shows its owner and times only, never its origin.
PRODUCTION  producer level L: 50 + 20L + 5L² per hour. Frontier ×1.5, inner/hub ×1.25, Olympus ×1.5.
STORAGE     warehouse L holds 60L² + 280L + 660 of each resource. 100·L of each is safe from loot.
POPULATION  acropolis L allows 2L² + 20L + 40 pop. Every unit homed in the city counts, wherever it is.
BUILD       level L costs base × (L² + 3L + 6) / 10. It takes baseTime × (L² + 3L + 6) / (9 + acropolis) s.
RECRUIT     unit time = baseTime × 10 / (9 + barracks or harbor level). Units arrive one by one.
UNITS       hoplite defends (atk 5, def 20, carries 10). peltast attacks (atk 20, def 5, carries 50).
            settler founds a city or holds a siege. transport carries 20 pop across water.
            trireme fights only at sea (naval 50). Only hoplites and peltasts fight on land.
SETTLER     450 wood / 450 stone / 750 gold × k, where k = your cities + your settlers (k ≤ 10).
COMBAT      naval phase (only across water): triremes 50 each. Losing it sinks the whole attack.
            land phase: A = Σ attack  vs  D = (Σ defense + 50 + 20·acropolis) × (1 + 5%·wall).
            The defender wins ties. Morale: −10% attack per city you own above the foe (floor 70%).
LOSSES      The loser loses everything in that phase. The winner loses (loser/winner)² of each stack.
            Example: winning at 2:1 costs 25%; at 3:2 it costs 44%. Below 1.41:1 a lone settler dies.
AFTER A WIN all defenders die and the wall drops 1. With no settler alive: loot (peltast carries 50).
            With a settler alive: a public 6 h SIEGE. The city is yours at the end unless someone
            kills every settler in your garrison first.
SCORE       100 per city + 1 per building level + 100 for Olympus
            + 1 per 10 enemy pop killed (capped at 1/4 of your city points).
WIN         From day 4: a bloc (alliance or lone player) holding ≥ 16 cities (35% of the 43 city slots),
            ≥ 2 of them taken, for 24 h in public. The countdown must start by D7 00:00 to end in time.
            A city counts as taken when its owner conquered it and no member of the owner's bloc ever
            held it. Otherwise the highest score at the end of day 7.
```

This is the sheet at N = 6. The WIN numbers depend on N (the threshold counts the map's city slots, §13.3): 16 cities of 43 slots at N = 6, 18 of 50 at 7, 18 of 49 at 8, 20 of 55 at 9, 22 of 61 at 10, 24 of 67 at 11 and 26 of 73 at 12. The sheet follows the config:

- UNITS gives each land unit's role from its numbers ("defends" when its defense is the larger, "attacks" when its attack is);
- the WIN line names the floor per player only when it is the larger term ("≥ 18 cities (3 per player; 35% of the 43 city slots is only 16)"), and the last second a countdown can start, `matchEnd − dominationHold`;
- with `victory.dominationMinConquests` at 0 the taken clause and its definition drop out;
- when no countdown could end by `matchEnd` (`dominationStart + dominationHold > matchEnd`, e.g. a match of 3 days or less) the WIN line reads "Domination is off in this match: the highest score at the end of day D wins."

### 0.1 Changes from 1.0.0

`perfidia-1@1.1.0` changes `perfidia-1@1.0.0` in the three ways below. The only default number that changes is the domination share (item 2); every other number, formula, table and tie-break is unchanged, and so are the error codes and wording, the event types (`domination_started` gains two fields) and the gateway's interface text. The cheat sheet gains a UNITS line and a new WIN line (§0). A match recorded under 1.0.0 replays only under 1.0.0 (`docs/rulesets/perfidia-1-v1.0.0.md`).

1. **The Greek setting (a reskin, no new mechanic).** The agent-visible ids below are renamed, with the config keys that name them. Each 1.0.0 id has exactly one 1.1.0 counterpart, on its row (the mapping is one-to-one), but each version accepts only its own ids: 1.1.0 rejects `hall`, `guard` and the other 1.0.0 ids as unknown, with the error that lists its own. The new unit names no longer say which unit attacks (1.0.0's `guard` and `raider` did), so the cheat sheet's UNITS line gives each unit's role from its numbers.

   | Kind                                    | 1.0.0                | 1.1.0                  |
   | --------------------------------------- | -------------------- | ---------------------- |
   | buildings                               | `hall`               | `acropolis`            |
   |                                         | `lumber`             | `sawmill`              |
   |                                         | `mine`               | `goldmine`             |
   | units                                   | `guard`              | `hoplite`              |
   |                                         | `raider`             | `peltast`              |
   |                                         | `warship`            | `trireme`              |
   | prize island kind, city tag, start seed | `crown`              | `olympus`              |
   | score key                               | `scoring.crownBonus` | `scoring.olympusBonus` |
   | public city flag (§12)                  | `crown: true`        | `olympus: true`        |
   | travel probe of `view_map`              | `warship`            | `trireme`              |
   | prose                                   | the Crown            | Olympus                |

   Kept on purpose:
   - **Resources** `wood`, `stone`, `gold`: they belong to the protocol (the `send_resources` and `spy` arguments, the resource objects) and to the interface text every ruleset shares, so renaming them would change what 1.0.0 agents read. Kept pending the owner's approval.
   - **Positional island kinds** `home`, `backyard`, `frontier`, `inner`, `hub`: agents reason with them (near-safe or contested), and config keys echo them (`map.radius.backyardOffset`, `frontierOffset`, `innerOffset`, `hub`, `map.hubMaxPlayers`). Kept pending the owner's approval.
   - `quarry`, `warehouse`, `barracks`, `harbor`, `wall`, `settler`, `transport`: generic words of the setting, echoed by config keys (`economy.warehouseCap`, `movement.shipment.perHarborLevel`, `combat.wallPmPerLevel`, `spy.counterPerWall`, `settler.*`) and by the recruit queues `barracks` and `harbor`.

2. **Domination by conquest (§13.3).** The threshold is 350‰ of the map's city slots, a number fixed for the map (Olympus included), instead of 400‰ of the cities that exist, and a bloc must also hold `victory.dominationMinConquests` (default 2) **taken** cities: cities its members conquered (§9.4, Olympus included) that no member of the bloc ever owned. A former owner's recapture is not taken, and neither is a city conquered from a player who is now in the same bloc (a trade staged before allying, an ally's recapture of a member's city); a conquest that follows a betrayal counts, since the betrayer leaves the alliance first. The views show every taken city and its former owners, and every bloc's cities and taken cities next to the threshold (§12, §13.2); `domination_started` also carries `taken` and `needTaken`. A founding no longer moves the threshold, so it never cancels a countdown. A countdown starts only while it can still end by `matchEnd`, i.e. until `matchEnd − dominationHold` (D7 00:00 by default); 1.0.0 also started countdowns that could only expire.
3. **Config validation (§16).** `victory.dominationPm` must be within 1..1000, `victory.dominationMinPerPlayer` within 1..1000, `victory.dominationMinConquests` within 0..1000 and every `map.kinds.*.slots` at most 100, whether domination is on or off. For every N, the threshold must be ≥ 1 city and at most the map's city slots, and the taken cities asked for at most the threshold; each failing check is reported once, naming the N it fails for. 1.0.0 accepted 0 and 0 (every bloc qualified at the opening), a share above 1000‰ (domination silently off) and unbounded slots (with 10^14 frontier slots, 1.0.0 hangs in a bot run).

**Why these values.** They were calibrated with the scripted bots before 1.1.0 was released: `sim batch --pacing`, bots pinned, the default lineup (`expander@2`, `rusher@3`, `turtle@3`, `opportunist@3`, `conqueror@3`) and the war-call lineup (`conqueror@3`, `opportunist@3`, `turtle@3`, `conqueror@3`, `expander@2`, `rusher@3`), 60 seeds at 6 seats (120 for the war lineup at 350‰), 30 at 8 and 10 at 12, variants paired by seed; then, after the review that added the bloc rule for taken cities, the countdown cutoff and the bots' reading of the taken cities, again at 6 seats (60 seeds per lineup, with 12 h and 18 h holds), in an aggressive lineup (`conqueror@3` ×4, `opportunist@3` ×2, 20 seeds) and at 9 seats (20 seeds). Numbers and commands are in `docs/architecture.md` §17.5; wins per seat carry Wilson 95% intervals.

- **Domination by conquest closes the peaceful path.** With the same bots, 1.0.0 ends 41 of 120 six-seat matches by domination, 39 of the 41 winning blocs holding 0 or 1 conquered city. Under 1.1.0 every countdown's bloc held at least 2 taken cities, none of them conquered from a member of the bloc. At 9 seats, blocs of three peaceful bots held up to 23 cities with no taken city, and started no countdown.
- **350‰, not 400‰.** At 400‰ (18 cities at N = 6) blocs that fight reach the threshold only on days 6 and 7: 1 domination in 60 matches in each lineup. At 350‰ (16 cities) 4 of 60 default and 10 of 120 war matches (7–8%) ended by domination before the review; after it, 3 of 60 (5% [2, 14]) and 4 of 60 (7% [3, 16]), every winner a pair holding 16 or 17 cities, exactly 2 of them taken. Conquests, sieges, reliefs and wins per strategy do not move beyond 1–3 seat-wins between 350‰ and 400‰. 1 taken city (`dominationMinConquests` 1) reopens near-peaceful wins (20% of default and 32% of war matches, more than half of the winners holding a single taken city), so `dominationMinConquests` stays 2 and `dominationMinPerPlayer` 2.
- **The hold against the end of the match, more than the share, sets how often domination happens.** These bots' blocs reach 16 cities late: of the 9 default and 10 war matches in 60 where a bloc met the rule, 6 and 5 met it first after D7 00:00, when a 24 h countdown could no longer end (before the review such countdowns started and expired: 19 of the 35 of the first calibration). A 12 h hold, paired by seed, doubles domination: 3 → 8 of 60 (default) and 4 → 8 (war), 13% [7, 24] each (90% interval of the difference per match [+0.03, +0.15] and [+0.02, +0.12]), seat wins moving by at most +4/−1 per strategy (McNemar p ≥ 0.125) and conquests by −3%; 18 h changes 0 and +1. In the aggressive lineup the 24 h hold gives 5 countdowns on day 6, all broken by rivals, and no domination; at 12 h the same 5 are broken and 3 countdowns started on D7 before 12:00 win (3 of 20). `dominationHold` stays 24 h on purpose: it is the window for counterplay that the decision report kept, and the lateness comes from the bots' founding pace (their peaceful blocs first reach 16 cities on days 6–7), not from a rule; LLM blocs that conquer earlier are not held back by it. If pilot matches show blocs qualifying on day 7, a 12 h hold is the measured lever. The 15–35% of matches ending by domination that the design aims at is not reached with these bots (5–7%), and no bot seeks taken cities: LLM alliances will tell.
- **Seat counts.** The threshold asks more of some N than of others. A full bloc at its peaceful share (7 cities a player for N ≤ 7, 6 for N ≥ 8; alliances of `max(2, floor(N/3))`) is 2, 4, 6, 2, 4, 6 and 2 cities short of `need` for N = 6..12, i.e. per member 1, 2, 3, 0.67, 1.33, 2 and 0.5 cities above its share of the slots, before the 2 taken cities. Only N = 6 was measured with dominations: none in 90 matches at 8 seats (the best bloc 15 cities on average, 18 needed), 20 at 9 (largest bloc 16.7 on average, but blocs with 2 taken cities 9.1; 20 needed) and 20 at 12 (15–16 of 26). For 1.1.0 matches where domination should be a live path, use N = 6; by the arithmetic, 9 and 12 come next; at 7, 8, 10 and 11 domination is a long shot. A threshold per N (e.g. `allianceMax × floor((slots − 1) / N) + dominationMinConquests`) is an idea for a later version.
- **No conquest trophy, on the evidence of the lineups, not of the cap.** A score bonus per taken city held (`scoring.conquestBonus`) and cheaper kills (`scoring.killPopPerPoint` 3–5 with `killCapPm` 500) were measured before the review. A trophy of 30 moves no winner in the default lineup, and in the war lineup moves 7 of 60 wins from `opportunist@3` (0.47 → 0.35 wins per seat, McNemar p = 0.016) to `conqueror@3`, `turtle@3` staying at 0: a significant rebalance in one lineup, none in the other. Cheaper kills lift `opportunist@3` to 0.52–0.55 wins per seat in the war lineup and its battle score from 4% to 8–13% of its points. The cap of 0.45 wins per seat cannot decide between these options with 30–60 seeds: a strategy's wins per seat move by about ±0.15 between seed sets (`opportunist@3`: 0.33 on default seeds 1–60, 0.10 [0.03, 0.26] on 61–90; 0.23 at 8 seats on seeds 1–30, 0.43 [0.27, 0.61] on 31–60; 0.48 [0.36, 0.61] on war seeds 1–60 after the review). Both are left out because their effect depends on the lineup, which only LLM play will show, and the score is 1.0.0's; the trophy of 30 stays an open option for a later version.
- **Times unchanged.** A relief can reach 97–100% of sieges within the 6 h `siegeDuration` (by geometry: transport travel from the owner's or an ally's other city plus the 600 s urgent wake), but only 92–94% within 4 h at 12 seats, and a 4 h siege raised conquests by 19% and 7% in the two lineups, short of a rule-level case. `protectionEnd`, `capitalImmunityEnd` and `matchEnd` stay: first battles come at 15:00–16:10 on day 1, no capital fell and no player was eliminated, and the winner's median margin is 4–9%.

---

## 1. Conventions and determinism

### 1.1 Names and ids

| Kind         | Ids, in canonical order                                                                 | Notes                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Resources    | `wood`, `stone`, `gold`                                                                 |                                                                                                                                             |
| Buildings    | `acropolis`, `sawmill`, `quarry`, `goldmine`, `warehouse`, `barracks`, `harbor`, `wall` |                                                                                                                                             |
| Units        | `hoplite`, `peltast`, `settler`, `transport`, `trireme`                                 |                                                                                                                                             |
| Island kinds | `olympus`, `home`, `backyard`, `frontier`, `inner`, `hub`                               |                                                                                                                                             |
| Players      | `p1..pN`                                                                                | seat order                                                                                                                                  |
| Islands      | `i1..`                                                                                  | generation order (§2.3)                                                                                                                     |
| Cities       | `c1..`                                                                                  | `c1..cN` are the capitals of `p1..pN`; `c(N+1)` is Olympus; founded cities take the next number. A city keeps its id when it changes owner. |
| Movements    | `m` + 5 opaque characters, e.g. `m0k4qz`                                                | private kind (see below)                                                                                                                    |
| Reports      | `r` + 5 opaque characters                                                               | battle and spy reports; private kind                                                                                                        |
| Proposals    | `q` + 5 opaque characters                                                               | private kind                                                                                                                                |
| Alliances    | `a1..`                                                                                  |                                                                                                                                             |
| Messages     | `g` + 5 opaque characters                                                               | private kind                                                                                                                                |
| Queue items  | `#1..` per city                                                                         | build items and recruit batches of one city share one counter                                                                               |

- Ids of public kinds (players, islands, cities, alliances) are counters in creation order.
- Ids of private kinds (movements, reports, proposals, messages) are **opaque**: 5 characters of lowercase Crockford base 32, from a permutation of (owner, the owner's own counter) keyed by a per-match secret that is not derived from the seed (`docs/architecture.md` §4.1). Their values and gaps reveal nothing about other players' activity, and their order is not creation order. The owner is the mover, the report's recipient, the proposer or the sender.
- Ids are never reused.
- Canonical orders apply to every loop, tie-break, serialisation and display.
- Ids are stable within a version. 1.1.0 renamed some of 1.0.0's (§0.1).

### 1.2 Integer maths

Integers only. Every division is **floor** unless stated otherwise, and every operand is ≥ 0 except map coordinates.

| Helper          | Definition                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ceilDiv(a, b)` | `floor((a + b − 1) / b)` for a ≥ 0 and b > 0                                                                             |
| `rdiv(n, d)`    | coordinates only, n may be negative: `sign(n) · floor((2·abs(n) + d) / (2d))`, which rounds half away from zero          |
| `isqrt(n)`      | the largest s ≥ 0 with s² ≤ n. Compute it as `floor(Math.sqrt(n))`, then correct by ±1 until it is exact.                |
| `lossPm(L, W)`  | for 0 ≤ L ≤ W and W > 0: `r = floor(1000·L / W)`, result `floor(r·r / 1000)`. This is ≈ 1000·(L/W)² and lies in 0..1000. |
| `cas(n, q)`     | `floor((n·q + 500) / 1000)`, i.e. round half up. It never exceeds n because q ≤ 1000.                                    |
| ‰               | per mille: a value v‰ means v/1000                                                                                       |

**Bounds.** The largest product anywhere is below 4·10⁹: a stock × 3600, isqrt arguments, loot and loss numerators. All of them fit in float64 integers (< 2⁵³). Engine code may use `number`.

### 1.3 Randomness

Randomness is used only for map generation, seat assignment, the public tie-break order and the lockstep ordering of same-second actions. **Combat, loot, spying and everything else is deterministic.**

- **PRNG** (mulberry32, state `s` as uint32):

  ```
  s = (s + 0x6D2B79F5) >>> 0; t = s
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return (t ^ (t >>> 14)) >>> 0
  ```

- **Named streams.** The seed of stream `name` is FNV-1a-32 of the UTF-8 string `` `${matchSeed}:${name}` `` (offset 2166136261, prime 16777619 via `Math.imul`, then `>>> 0`). The streams are `map`, `seats`, `tiebreak` and `lockstep:<t>:<b>`. Adding a draw to one stream never shifts another.
- `randInt(lo, hi) = lo + floor(u · (hi − lo + 1) / 2³²)`, where u is the next output.
- `shuffle(list)` is Fisher–Yates: for i from n−1 down to 1, `j = randInt(0, i)`, swap i and j.

### 1.4 Event and action order

- **Events** are keyed `(time, class, seq)`. `seq` is a global counter assigned whenever an event is scheduled or rescheduled (for example by a recall). Launch order therefore decides between same-second arrivals: this is how attack "trains" work (§8.11).

| Class | Event                                                                  |
| ----- | ---------------------------------------------------------------------- |
| 1     | build item completes                                                   |
| 2     | recruit batch completes                                                |
| 3     | return arrival (units coming home)                                     |
| 4     | support arrival                                                        |
| 5     | shipment arrival                                                       |
| 6     | spy arrival                                                            |
| 7     | attack arrival                                                         |
| 8     | found arrival                                                          |
| 9     | siege end                                                              |
| 10    | timers: proposal expiry, pact expiry, domination opening at t = 259200 |
| 11    | domination countdown end                                               |
| 12    | match end (t = 604800)                                                 |

- **Actions** stamped t are applied after every event with time ≤ t, in **log order**. Each action is validated against the state at that moment.
  - A list action (`build` or `recruit` with several items) is applied item by item, as consecutive actions. The result reports each item's outcome.
- **Clock drivers.** Only the driver changes between clocks; both log the final order.
  - Real time: actions are stamped with the game second at which they are received and applied in receipt order.
  - Lockstep: the game clock waits while the agents think. The b-th batch of actions collected at second t (b = 0, 1, …) is ordered by seat: the acting seats, sorted by player number, are shuffled on stream `lockstep:<t>:<b>`, and each seat keeps its own submission order.
  - Replays apply the log.
- **Durations.** Every scheduled duration is ≥ 1 s, recalls included (§7.4).
- **Match end.** All events at t = 604800 resolve, then class 12 ends the match. Actions stamped ≥ 604800 are rejected. Events scheduled after 604800 never fire. A domination or last-standing win ends the match right after the event that caused it (§13.3).

### 1.5 Lazy state

Resource stocks (§4.3) and trickling recruit batches (§6.3) are derived from closed formulas. Events and accepted actions **materialise** the cities they touch (a battle, a spy, a spend, a delivery, a level change) before reading or changing them. Views and validation compute the same values without writing. Materialising is idempotent and path-independent, so the result never depends on when a city was materialised or looked at.

---

## 2. Map

### 2.1 Shape

- The map has one ring of N home islands around a central **Olympus** island.
- Between each pair of neighbouring homes there is a **frontier** island and an **inner** island, both equidistant from the two homes.
- Behind each home there is a **backyard** island.
- For N ≤ 7 a ring of N **hub** islands also surrounds Olympus, which keeps the island count at 30 or more.
- All cities on an island share its coordinates. Island size is cosmetic: display radius `8 + 4·slots`.

| Kind             | Per    | Radius from centre | Angle | Slots                               | Richness  | Role                                                              |
| ---------------- | ------ | ------------------ | ----- | ----------------------------------- | --------- | ----------------------------------------------------------------- |
| olympus          | 1      | 0                  | –     | 1, held by the neutral Olympus city | 1500‰     | late-game prize                                                   |
| home             | sector | `R`                | `A_k` | 2 (slot 0 = capital)                | 1000‰     | start; slot 1 is a safe-ish first colony, 1 h walk                |
| backyard         | sector | `R + 80 + jr_b`    | `A_k` | 1                                   | 1000‰     | own colony, ~1 h 20                                               |
| frontier         | sector | `R + jr_f`         | `M_k` | 2                                   | **1500‰** | shared by neighbours k and k+1, ~1 h 30 from both: the day-1 race |
| inner            | sector | `R − 80 + jr_i`    | `M_k` | 1                                   | 1250‰     | shared by the same pair, closer to the centre, ~1 h 50            |
| hub (N ≤ 7 only) | sector | `60 + jr_h`        | `M_k` | 1                                   | 1250‰     | near Olympus, contested by everyone                               |

### 2.2 Inputs and constants

- **Inputs:** `matchSeed` (uint32) and `N` ∈ [6, 12].
- **Home radius:** `R = homeRadius[N] = {6:180, 7:207, 8:235, 9:263, 10:291, 11:319, 12:348}`, i.e. `round(90 / sin(π/N))`. Neighbouring homes are therefore ≈ 180 tiles (3 h by transport) apart for every N.
- **Centre:** `C = R + 120`. Coordinates are integer tiles, all ≥ 0, and the map spans `[0, 2C]²`. Olympus sits at `(C, C)`.
- **Angles** are in tenths of a degree (0..3599).
  - `SIN10K[d] = round(10000 · sin(d/10 °))` for d = 0..900 is a **committed 901-entry constant table**. Spot checks: [0] = 0, [300] = 5000, [450] = 7071, [600] = 8660, [900] = 10000. A unit test regenerates it.
  - `sinT(a)`, with a normalised to 0..3599:
    - `SIN10K[a]` if a ≤ 900
    - `SIN10K[1800 − a]` if a ≤ 1800
    - `−SIN10K[a − 1800]` if a ≤ 2700
    - `−SIN10K[3600 − a]` otherwise
  - `cosT(a) = sinT(a + 900)`.
  - **The engine never calls `Math.sin` or `Math.cos`.**

### 2.3 Algorithm

All draws below use stream `map` unless stated.

1. `rot = randInt(0, 359)`, in whole degrees.
2. In the order backyard, frontier, inner, hub: `jr_kind = randInt(−10, 10)`. The hub value is drawn even when N ≥ 8, so the stream is always consumed the same way. Every sector uses the same jitter, so the rotational symmetry is exact up to rounding.
3. For sector k = 0..N−1:
   - `A_k = 10·rot + floor(3600·k / N)`
   - `M_k = 10·rot + floor(3600·(2k+1) / (2N))`
4. An island at polar position (r, a) has coordinates `x = C + rdiv(r · cosT(a), 10000)` and `y = C + rdiv(r · sinT(a), 10000)`.
5. Ids:
   - `i1` is Olympus.
   - Then, for k = 0..N−1 in order: home, backyard, frontier, inner, and hub if N ≤ 7.
   - Frontier k and inner k lie between home k and home (k+1) mod N.
6. Seats: `perm = shuffle([0..N−1])` on stream `seats`. Player `p(j+1)` gets sector `perm[j]`, and its capital `c(j+1)` sits in slot 0 of that home island.
7. The **tie-break order** is `shuffle([p1..pN])` on stream `tiebreak`. It is public from t = 0.

**Distance.** `d² = (x₁−x₂)² + (y₁−y₂)²`. The distance in tiles shown to agents is `isqrt(d²)`.

### 2.4 Resulting maps

These figures use the median jitter. They are tiles · transport / trireme-only / spy travel time (§7.2).

| N   | R   | islands | slots | free slots per player | backyard            | frontier            | inner                | hub                  | Olympus              | neighbour home       | opposite home         |
| --- | --- | ------- | ----- | --------------------- | ------------------- | ------------------- | -------------------- | -------------------- | -------------------- | -------------------- | --------------------- |
| 6   | 180 | 31      | 43    | 6                     | 80 · 1h20/1h00/1h00 | 93 · 1h33/1h09/1h00 | 105 · 1h45/1h19/1h00 | 131 · 2h11/1h38/1h05 | 180 · 3h00/2h15/1h30 | 180 · 3h00/2h15/1h30 | 360 · 6h00/4h30/3h00  |
| 7   | 207 | 36      | 50    | 6                     | 80 · 1h20/1h00/1h00 | 92 · 1h32/1h09/1h00 | 108 · 1h48/1h21/1h00 | 155 · 2h35/1h56/1h17 | 207 · 3h27/2h35/1h43 | 179 · 2h59/2h14/1h29 | 403 · 6h43/5h02/3h21  |
| 8   | 235 | 33      | 49    | 5                     | 80 · 1h20/1h00/1h00 | 91 · 1h31/1h08/1h00 | 109 · 1h49/1h21/1h00 | –                    | 235 · 3h55/2h56/1h57 | 179 · 2h59/2h14/1h29 | 470 · 7h50/5h52/3h55  |
| 9   | 263 | 37      | 55    | 5                     | 80 · 1h20/1h00/1h00 | 91 · 1h31/1h08/1h00 | 110 · 1h50/1h23/1h00 | –                    | 263 · 4h23/3h17/2h11 | 180 · 3h00/2h15/1h30 | 517 · 8h37/6h28/4h18  |
| 10  | 291 | 41      | 61    | 5                     | 80 · 1h20/1h00/1h00 | 91 · 1h31/1h08/1h00 | 111 · 1h51/1h23/1h00 | –                    | 291 · 4h51/3h38/2h25 | 179 · 2h59/2h14/1h29 | 582 · 9h42/7h16/4h51  |
| 11  | 319 | 45      | 67    | 5                     | 80 · 1h20/1h00/1h00 | 90 · 1h30/1h08/1h00 | 112 · 1h52/1h24/1h00 | –                    | 319 · 5h19/3h59/2h39 | 179 · 2h59/2h14/1h29 | 631 · 10h31/7h53/5h15 |
| 12  | 348 | 49      | 73    | 5                     | 80 · 1h20/1h00/1h00 | 90 · 1h30/1h08/1h00 | 112 · 1h52/1h24/1h00 | –                    | 348 · 5h48/4h21/2h54 | 180 · 3h00/2h15/1h30 | 696 · 11h36/8h42/5h48 |

- **Slots:** 6N (7N for N ≤ 7) plus 1 for Olympus.
- **Free slots per player:**
  - 2 near-safe ones: the second home slot and the backyard.
  - About 3 shared with the two neighbours: frontier 2 + inner 1 per gap.
  - For N ≤ 7, also a hub.
- There are deliberately few slots (§15.3).

### 2.5 Fairness guarantee (CI property test)

The test checks every N in 6..12 and every seed (fast-check over seeds, plus an exhaustive sweep of `rot` and the jitter extremes). It asserts three things:

1. All island coordinates are distinct and ≥ 0, and every pair of islands is ≥ 15 tiles apart. The measured minimum is 19.
2. For every two seats, the sorted vectors of transport travel times from their home island to every other island differ elementwise by **≤ 150 s**. The measured worst case is 144 s, which comes only from rounding coordinates to integer tiles.
3. Every frontier, inner and hub island is equidistant (± 3 tiles) from its two adjacent homes.

---

## 3. Starting state

|                         | Capital (each player)                                                               | Founded city                | Olympus `c(N+1)` (neutral)                                      |
| ----------------------- | ----------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------- |
| Buildings               | acropolis 1, sawmill 1, quarry 1, goldmine 1, warehouse 1; barracks, harbor, wall 0 | same as a capital           | every building at 5                                             |
| Stock (wood/stone/gold) | 800 / 800 / 800                                                                     | 300 / 300 / 300             | 3000 / 3000 / 3000, frozen while neutral (no production)        |
| Units                   | 10 hoplites                                                                         | its escort, re-homed (§7.5) | 400 hoplites + 10 triremes; they never regenerate and never act |
| Pop used / cap          | 10 / 62                                                                             | escort pop / 62             | –                                                               |
| Points                  | 105                                                                                 | 105                         | 240 to its owner once captured (§13.1)                          |

- **Relations, notes, queues:** empty. No alliances, no pacts.
- **Attack protection:** no player can **launch** an `attack` before t = 43200 (12:00). Spying, support, shipments and founding are allowed from t = 0.
- **Capital immunity:** capitals `c1..cN` cannot be **besieged** before t = 172800 (end of day 2). They can be attacked and looted (§9.5).

---

## 4. Economy: resources, storage, population

### 4.1 Per-level values

| L   | w(L) | production / h | warehouse cap | safe from loot | acropolis pop cap | base defense (acropolis) | wall factor | build divisor (9 + acropolis) | recruit factor 10 / (9 + L) |
| --- | ---- | -------------- | ------------- | -------------- | ----------------- | ------------------------ | ----------- | ----------------------------- | --------------------------- |
| 1   | 10   | 75             | 1000          | 100            | 62                | 70                       | 1050‰       | 10                            | 1.00                        |
| 2   | 16   | 110            | 1460          | 200            | 88                | 90                       | 1100‰       | 11                            | 0.91                        |
| 3   | 24   | 155            | 2040          | 300            | 118               | 110                      | 1150‰       | 12                            | 0.83                        |
| 4   | 34   | 210            | 2740          | 400            | 152               | 130                      | 1200‰       | 13                            | 0.77                        |
| 5   | 46   | 275            | 3560          | 500            | 190               | 150                      | 1250‰       | 14                            | 0.71                        |
| 6   | 60   | 350            | 4500          | 600            | 232               | 170                      | 1300‰       | 15                            | 0.67                        |
| 7   | 76   | 435            | 5560          | 700            | 278               | 190                      | 1350‰       | 16                            | 0.63                        |
| 8   | 94   | 530            | 6740          | 800            | 328               | 210                      | 1400‰       | 17                            | 0.59                        |
| 9   | 114  | 635            | 8040          | 900            | 382               | 230                      | 1450‰       | 18                            | 0.56                        |
| 10  | 136  | 750            | 9460          | 1000           | 440               | 250                      | 1500‰       | 19                            | 0.53                        |

The table comes from these formulas, where H is the acropolis level. Wall level 0 gives a factor of 1000‰.

| Quantity            | Formula                                         |
| ------------------- | ----------------------------------------------- |
| level weight        | `w(L) = L² + 3L + 6`                            |
| production per hour | `prod(L) = 5L² + 20L + 50`                      |
| warehouse cap       | `cap(L) = 60L² + 280L + 660`                    |
| safe from loot      | `protect = 100 · warehouse level`, per resource |
| acropolis pop cap   | `pop(H) = 2H² + 20H + 40`                       |
| base defense        | `baseDef(H) = 20H + 50`                         |
| wall factor         | `1000 + 50 · wall` ‰                            |

**Production payback** of a producer level, in resources spent per resource gained per hour, rises from 4.6 h at L2 to 11.8 h at L10. Growth therefore has diminishing returns.

### 4.2 Production

The production rate of a resource in a city, per game hour, is `rate = floor(prod(level of sawmill | quarry | goldmine) × richness / 1000)`, where richness is the island's (§2.1). Example: sawmill 5 on a frontier gives `floor(275 × 1500 / 1000) = 412` wood per hour.

### 4.3 Exact lazy accrual

- Each city stores `S_r = stock_r × 3600` (resource-seconds).
- Over an interval [t0, t1] with no change of rate or cap: `S_r = min(cap × 3600, S_r + rate_r × (t1 − t0))`.
- The visible stock is `floor(S_r / 3600)`. Spending or adding x changes S_r by ∓3600·x. An action is affordable when the visible stock is ≥ the cost.
- The city is materialised (§1.5) before any change of stock, rate or cap. Rates and caps only change at materialised instants (level completion, conquest), so the result does not depend on how often stocks are read.
- **Every addition is capped by the warehouse**: refunds, loot, shipments and returning cargo. The excess is lost, and the event or result reports how much was lost: the battle report (loot), `shipment_delivered`, `returned`, the `cancel_queue` result (`refund` credited, `lost`) and, at a siege start, the owner's `queues_refunded` (§9.1).
- **Gateway hint:** "available in `ceilDiv(x·3600 − S_r, rate_r)` s", or "never" when x > cap or rate = 0.

### 4.4 Population

- `used(city)` = Σ pop of every unit **homed** in the city, wherever it is (at home, moving, stationed elsewhere, in a siege garrison), plus the pop of units in the city's recruit queues.
- A recruit order is accepted only if `used + order pop ≤ pop(completed acropolis level)`.
- Buildings use no population.
- Units that die or are consumed free their pop at once.
- Re-homing (founding, conquest, §7.7) may push `used` above the cap. That is allowed, but recruiting in that city is blocked until `used` falls back under the cap.

---

## 5. Buildings

### 5.1 List

Every building has max level 10. The level-1 values below are the "base" used in the formulas of §5.2.

| id          | Level-1 cost w/s/g | Base time (s) | Requires (projected levels) | Effect                                                                                                      |
| ----------- | ------------------ | ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `acropolis` | 90 / 90 / 60       | 1800          | –                           | pop cap; build speed `/(9+H)`; base defense `20H + 50`; settlers need acropolis 3                           |
| `sawmill`   | 20 / 50 / 30       | 1500          | –                           | wood production                                                                                             |
| `quarry`    | 50 / 20 / 30       | 1500          | –                           | stone production                                                                                            |
| `goldmine`  | 50 / 50 / 10       | 1500          | –                           | gold production                                                                                             |
| `warehouse` | 60 / 60 / 20       | 1200          | –                           | storage cap; loot protection 100/level                                                                      |
| `barracks`  | 60 / 80 / 50       | 1500          | acropolis 2                 | trains hoplite, peltast and settler; recruit speed                                                          |
| `harbor`    | 100 / 60 / 60      | 2400          | acropolis 3                 | trains transport (harbor 1) and trireme (harbor 3); recruit speed; shipment capacity `500 + 500·harbor`     |
| `wall`      | 30 / 120 / 30      | 1500          | barracks 1                  | +5% land defense per level; spy counter-intel +50 per level; loses 1 level on every lost city battle (§8.6) |

### 5.2 Cost and duration

- **Cost** of level L, per resource: `floor(base_r × w(L) / 10)`. Level 1 equals the base.
- **Duration:** `max(1, floor(baseTime × w(L) / (9 + H)))`, where H is the city's **completed** acropolis level at the moment the item is enqueued. The `max(1, …)` changes no default value; it keeps overridden configs valid.

| Example                                      | Cost              | Duration |
| -------------------------------------------- | ----------------- | -------- |
| acropolis 2 at H1                            | 144 / 144 / 96    | 2880 s   |
| sawmill 5 at H5                              | 92 / 230 / 138    | 4928 s   |
| harbor 10 at H10                             | 1360 / 816 / 816  | 17178 s  |
| acropolis 10 at H9 (finishing the acropolis) | 1224 / 1224 / 816 | 13600 s  |

Maxing every building of one city costs ≈ 77 k resources (27.8 k / 32.1 k / 17.5 k) and ≈ 135 h of queue time. A turtle therefore maxes its capital only at the end of day 6 or during day 7.

### 5.3 Build queue

- One queue per city, holding **at most 5 items**, the active one included. Items run strictly one after another.
- `build(city, [b1, b2, …])` enqueues the items in order. Each item is "+1 level of building b" and gets the city's next queue item number `#n` (build items and recruit batches of a city share one counter, never reused).
- Its **projected target** is the completed level, plus items of b already queued, plus 1. It must be ≤ 10 at enqueue, and it sets the item's cost and duration.
- **Requirements** are checked against **projected** levels (completed + queued earlier). So "acropolis 2, then barracks 1" can be queued in one call.
- **The cost is paid at enqueue.** The item starts at `max(now, end of the previous item)` and ends at start + duration. Both are fixed at enqueue: a later acropolis upgrade does not speed up items already queued.
- **At its end (class 1), an item raises the building's current completed level by 1**, capped at 10. It normally lands on its projected target. After a wall breach (§8.6) it lands one level lower; cost and duration stay those of the projected level.
  - Example: wall 4 with "wall 5" queued as `#12`. A raid breaches the wall to 3. `#12` completes to wall 4. While `#12` is queued, a new `build(wall)` projects 3 + 1 + 1 = 5.
- **Cancel** is a tail cancel: `cancel_queue(city, item)` removes that item **and every later item of its queue**, so the remaining end times never move.
  - Items not started are refunded 100%.
  - The active item refunds `floor(cost_r × remaining / duration)` per resource.
  - Refunds are capped by the warehouse.
  - Requirements stay consistent, because an item can only depend on items queued before it.
  - If the item has already completed, the error says when ("#12 of c14 completed at D3 14:02:10").
- There is no demolition. Building levels go down only through the wall breach (§8.6).

---

## 6. Units

### 6.1 Stats

| id          | Domain | Attack | Defense | Naval | Carry | Capacity | Pop | Cost w/s/g          | Base time (s) | Queue    | Requires                |
| ----------- | ------ | ------ | ------- | ----- | ----- | -------- | --- | ------------------- | ------------- | -------- | ----------------------- |
| `hoplite`   | land   | 5      | 20      | –     | 10    | –        | 1   | 30 / 60 / 30        | 300           | barracks | barracks 1              |
| `peltast`   | land   | 20     | 5       | –     | 50    | –        | 1   | 50 / 20 / 60        | 300           | barracks | barracks 1              |
| `settler`   | land   | 0      | 0       | –     | 0     | –        | 10  | 450 / 450 / 750 × k | 5400          | barracks | barracks 2, acropolis 3 |
| `transport` | naval  | –      | –       | 0     | –     | 20 pop   | 2   | 120 / 40 / 80       | 1200          | harbor   | harbor 1                |
| `trireme`   | naval  | –      | –       | 50    | –     | –        | 4   | 150 / 100 / 250     | 2400          | harbor   | harbor 3                |

- **Roles.**
  - Hoplites and peltasts fight in the land phase. Hoplites defend; peltasts attack and carry loot.
  - Settlers found cities or hold sieges and never fight.
  - Transports carry land units and never fight.
  - Triremes fight only in the naval phase.
- **Sea pace** (s per tile): transport 60, trireme 45 (§7.2).
- **Cost identity.** Buildings run on wood and stone, units mostly on gold. Hoplites need stone; peltasts and ships need wood.
- Recruitment requirements use **completed** levels.

### 6.2 Settler cost

- `k = cities owned + settlers owned`, counted at enqueue before this settler. "Owned" settlers are those queued, at home, moving, stationed or in a garrison.
- The cost per resource is `base_r × min(k, 10)`: 450/450/750, 900/900/1500, 1350/1350/2250, and so on up to 4500/4500/7500 at k ≥ 10.
- A player reduced to one city with no settlers pays the base price again.
- A settler order has count 1. The cost must fit the city's warehouse: k = 6 needs warehouse 6 (4500 gold), and the k ≥ 10 maximum (7500 gold) needs warehouse 9. The error hint names the warehouse level required.

### 6.3 Recruitment

- Each city has two recruit queues, `barracks` and `harbor`. They run in parallel with each other and with the build queue.
- Each queue holds **at most 5 batches**, run in sequence. A batch is `(unit, count)` with 1 ≤ count ≤ 500 (settler: 1).
- `recruit(city, [{unit, count}, …])` enqueues the batches in order.
- Cost and pop are reserved at enqueue.
- **Per-unit time:** `u = max(1, floor(baseTime × 10 / (9 + L)))`, where L is the queue building's completed level at enqueue. Examples: hoplite 300 s at barracks 1, 214 s at 5, 157 s at 10.
- **Trickle.** A batch that starts at s (= `max(now, end of the previous batch)`) completes unit j (1-based) at `s + j·u`. Completed units are at home immediately; the engine materialises them lazily (§1.5). A batch-end event fires at `s + n·u` (class 2).
- Each batch gets the city's next queue item number `#n` (§5.3).
- **Cancel** is a tail cancel: `cancel_queue(city, item)` removes that batch and every later batch of its queue.
  - Completed units are kept.
  - Every uncompleted unit (the one in training included) is refunded at 100%, capped by the warehouse, and its pop is freed.

### 6.4 Transport rule

- A movement whose origin and target are on **different islands** needs `Σ pop of its land units ≤ Σ capacity of its transports`. This is checked at departure.
- Homebound trips (returns, recalls, dismissals, bounces) never need capacity.
- On the same island, land units walk and ships never fight.

---

## 7. Movements

### 7.1 Kinds

| Kind     | Tool             | Contents                                   | Seen by the target before arrival                                                                  | Recall                                      |
| -------- | ---------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| attack   | `attack`         | units; settlers make it a conquest attempt | yes: id, origin city and owner, foe, launch and arrival times. **No composition, no settler flag** | ≤ 600 s after launch                        |
| support  | `support`        | units                                      | yes, in full                                                                                       | ≤ 600 s in transit; any time once stationed |
| found    | `found_city`     | ≥ 1 settler plus any escort                | no                                                                                                 | ≤ 600 s after launch                        |
| spy      | `spy`            | gold only                                  | no                                                                                                 | never                                       |
| shipment | `send_resources` | resources only, no units                   | yes, in full                                                                                       | never                                       |
| return   | automatic        | survivors, cargo, empty ships              | (own movement)                                                                                     | never                                       |

Units always depart from their **home** city, and only when they are **at home** there. Troops stationed elsewhere must come home before they can be sent anywhere else.

### 7.2 Travel time

```
travel(islandA, islandB, pace) = sameIslandTravel                         if A = B (same island, everyone walks)
                               = max(minTravel, isqrt(pace² · d²))        otherwise
```

`minTravel` and `sameIslandTravel` are `time.minTravel` and `time.sameIslandTravel` (§16), both 3600 s by default. The code reads them from the config, never as a literal, and §16 requires `sameIslandTravel ≥ minTravel`.

| Group                                                                            | Pace (s/tile) |
| -------------------------------------------------------------------------------- | ------------- |
| any group with a transport, or with no ship at all (homebound groups, shipments) | 60            |
| triremes only                                                                    | 45            |
| spy                                                                              | 30            |

- A group's pace is that of its **slowest** ship.
- **Speed rule:** every movement lasts ≥ `minTravel` (3600 s), so the fastest attack always gives at least 1 game hour of warning. A recall within 600 s is the only shorter trip, and it takes `minTravel` too when its home is besieged at the recall (§7.4).
- `view_map(fromCity)` and `view_island` return precomputed times, so agents never need isqrt.

### 7.3 Departure checks

The gateway explains each failure with numbers, and the engine re-checks every condition.

**Common to every departure:**

- The origin is the player's own city and is **not besieged**.
- The listed units are homed in the origin and at home.
- The transport rule (§6.4) holds.
- t < 604800.

| Kind     | Extra checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| attack   | t ≥ 43200; the gateway cap of 20 attack launches per player per game day (§14); the target is a city the mover does not own, or the mover's own city while it is besieged (relief); the target is not besieged by the mover (send `support` instead); at least one land unit with attack > 0, or, across water, at least one trireme. The movement records its **foe**: the besieger if the target is besieged at launch, otherwise the owner (a player, or "neutral" for Olympus). |
| support  | The target is a city other than the origin: a player-owned city, or a besieged city when the mover is its besieger (the neutral Olympus included, §9.2, §9.6). If the target is besieged, only its besieger may support it. The movement records its **party**: the besieger if the target is besieged, otherwise the target's owner.                                                                                                                                               |
| found    | The target island has ≥ 1 free slot at departure. At least 1 settler.                                                                                                                                                                                                                                                                                                                                                                                                               |
| spy      | The target is a city the mover does not own. `100 ≤ gold ≤ stock`; the gold is paid at departure.                                                                                                                                                                                                                                                                                                                                                                                   |
| shipment | The target is a player-owned city other than the origin and is not besieged. Total load ≥ 1. The cargo in flight from the origin, plus this one, must be ≤ `500 + 500 · harbor(origin)`. Cargo in flight counts the origin's shipments and the returns created by bouncing them, until they arrive. The resources are paid at departure.                                                                                                                                            |

### 7.4 Recall and dismissal (`recall_troops`)

| Mode                                                    | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recall an outbound attack, support or found             | Only within **600 s** of departure, and only as a whole. It arrives home at `now + max(1, now − departAt)`. The target's incoming list drops it and shows "turned back at t". **If the home city has been besieged since the launch**, the return will fight a homecoming battle (§9.3), so it obeys the speed rule: it arrives at `now + max(minTravel, now − departAt)`, i.e. 1 h after the recall, and the besieger sees it coming from the recall on (§12).                                         |
| Recall stationed units (support, or own siege garrison) | Any time, all or part of a group. Your units in one city form one group per home city. Name the home city to recall part of one group; a partial recall without it is rejected when you have groups from several homes there, and the error lists them. Without a unit list, the named group leaves whole, or every one of your groups there when no home is named. Each group travels home as its own return (§7.6). If a garrison loses its last settler this way, the siege is **abandoned** (§9.3). |
| Dismiss                                                 | The owner of a city sends home every unit of a given player stationed in it (a whole group). It is not available for siege garrisons.                                                                                                                                                                                                                                                                                                                                                                   |

Returns, spies, shipments, and attacks more than 600 s after launch cannot be recalled.

### 7.5 Arrival resolution

| Kind     | State at arrival                                        | Result                                                                                                                                                                 |
| -------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| return   | home owned by the mover, not besieged                   | units are home; cargo is added (capped)                                                                                                                                |
| return   | home owned by the mover, besieged                       | **homecoming battle** against the garrison (§9.3)                                                                                                                      |
| support  | target besieged by the mover                            | the units join the garrison and keep their home                                                                                                                        |
| support  | target owned by the party, not besieged                 | stationed group, keyed (owner, home city); later supports from the same origin merge into it                                                                           |
| support  | otherwise                                               | bounces                                                                                                                                                                |
| attack   | target besieged by the mover                            | joins the garrison                                                                                                                                                     |
| attack   | target besieged by the foe                              | **relief battle** against the garrison (§9.3)                                                                                                                          |
| attack   | target not besieged and owned by the foe                | **city battle** (§8)                                                                                                                                                   |
| attack   | otherwise (owner changed, someone else is besieging)    | bounces. **An attack only ever fights the foe recorded at launch.**                                                                                                    |
| spy      | always                                                  | §10                                                                                                                                                                    |
| shipment | target still owned by its owner at launch, not besieged | resources added (capped; the overflow is lost and reported to the recipient only; the sender learns only that it was delivered)                                        |
| shipment | otherwise                                               | bounces with its cargo                                                                                                                                                 |
| found    | island has a free slot                                  | a new city in the **lowest free slot**, with the next city id; 1 settler is consumed; the other units (escort, ships, extra settlers) are **re-homed** to the new city |
| found    | no free slot                                            | bounces                                                                                                                                                                |

- Founders arriving in the same second are applied in seq order: the first one launched wins the slot.
- A **bounce** turns the movement into a return at once (§7.6).

### 7.6 Return trips

- A return travels from the island where the group is to its home island: `travel(from, home, pace of the group)` per §7.2.
- This covers returns after a battle, bounces, stationed recalls and dismissals. Recalls within 600 s follow §7.4 instead.
- Survivors carry their loot or cargo home, where it is added capped by the warehouse.

### 7.7 Owner change, re-homing and elimination

**When a city X changes owner (conquest, §9.4):**

1. The **former owner's fallback city** is their oldest remaining city (lowest city number they still own).
2. Every unit, stationed group, garrison unit and movement **homed in X** is re-homed to the fallback city.
   - Stationed groups and garrison units stay where they are.
   - Outbound movements continue, and their eventual return goes to the new home.
   - Returns already heading to X **sail on**: their arrival becomes `old arrival + travel(X's island, fallback's island, group pace)`.
   - Re-homed pop counts against the fallback city (§4.4).
   - A movement re-homed onto its own target (its origin was conquered in flight and the fallback city is where it was heading, e.g. a support or a relief of that city) is **home** on arrival when that city is not besieged: its units come home as a return's would. If it is besieged, §7.5 applies as usual: a relief still fights the besieger recorded as its foe, and any other besieger makes the movement bounce; its return (same-island travel, §7.2, §7.6) is then a homecoming the besieger is warned about (§9.3, §12).
3. If the former owner has no city left, they are **eliminated** (§9.7) instead.
4. Movements targeting X follow §7.5 with their recorded foe or party. For example, the old owner's supports and shipments bounce, and an attack launched against the besieger now fights it as the new owner.

There are no other owner changes: founding creates a city, and cities are never destroyed.

---

## 8. Combat

### 8.1 Battle types and participants

| Battle            | Trigger                             | Attacker side                                                            | Defender side                                                                                                                                                                                                                            | Wall and base defense                    |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| city battle       | attack arrival (§7.5)               | the movement's units                                                     | every unit physically in the city **not owned by the attacker**: the owner's units at home and the owner's own stationed groups (units homed in its other cities), every stationed group of other players, or Olympus's neutral garrison | yes                                      |
| relief battle     | an attack whose foe is the besieger | the movement's units                                                     | the garrison (the besieger's units)                                                                                                                                                                                                      | yes: the besieger holds the city's walls |
| homecoming battle | a return to a besieged home         | the returning group (the attacker is its owner, the foe is the besieger) | the garrison                                                                                                                                                                                                                             | yes                                      |

- **Stand-aside rule.** Units of the attacker that are stationed in the target ("trojan support") do not fight and are unharmed. If a siege starts, they join the garrison.
- **Morale** (§8.2) is applied, then the **naval phase** runs if the movement's departure island ≠ target island, then the **land phase** runs if the attacker still has land units. For a homecoming, the departure island is the island the return left from.
- Units still in recruit queues do not fight. Trickled units completed at or before t do.

### 8.2 Morale

- `m = clamp(1000 − 100 × (attacker's cities − foe's cities), 700, 1000)` ‰, using city counts at resolution time.
- Against the neutral Olympus, m = 1000.
- Morale scales the attacker's naval and land strength. Bigger players hit smaller ones up to 30% weaker. That gives comebacks a chance without stopping a leader.

### 8.3 Losses

- The **winner** of a phase loses `cas(n, q)` of each stack, where a stack is (owner, unit type) and `q = lossPm(loser strength, winner strength)`.
- The **loser** loses every unit that fought in that phase.
- **Split stacks.** A stack's units can sit in several groups: the owner's units at home, and its stationed groups (one per home city and role, e.g. supports from two cities, or a siege garrison reinforced from several cities). Losses are computed on the merged stack, `L = cas(n, q)`, then allocated to its groups by largest remainder:
  - groups are ordered units at home first, then stationed groups by home city, then role (`compareIds` order);
  - group i with `g_i` units first loses `floor(L · g_i / n)`;
  - the remaining losses go one per group, in descending order of `(L · g_i) mod n`, ties to the earlier group.

  The allocation decides which units return to which home and which settler dies. Example in §9.8.

- **Ties go to the defender.** On an exact tie, q = 1000, so both sides are wiped out in that phase and the city holds. This is rare, and documented so agents expect it.

| Winner : loser | 2 : 1 | 3 : 2 | 3 : 1 | 4 : 3 | 1.41 : 1 |
| -------------- | ----- | ----- | ----- | ----- | -------- |
| winner loses   | 25.0% | 44.3% | 11.0% | 56.2% | 50.2%    |

### 8.4 Naval phase (only across water)

- `Na = floor(Σ naval of attacking triremes × m / 1000)` and `Nd = Σ naval of defending triremes` (every owner on the defender side).
- If Na = Nd = 0, there is no naval phase.
- **Na > Nd:** the attacker wins.
  - Every defending ship is sunk, transports included.
  - Attacking triremes lose `cas(n, lossPm(Nd, Na))`.
  - Attacking transports and the land units aboard are untouched.
- **Na ≤ Nd** (so Nd > 0): the defender wins.
  - **The whole attacking movement is destroyed**, ships and land units aboard.
  - Defending triremes lose `cas(n, lossPm(Na, Nd))`.
  - The battle ends.
- An attack with only triremes has no land phase. After the naval phase its survivors return with no loot and no wall change: it is a harbour strike that clears the way for the next attack in a train.

### 8.5 Land phase

- `A = floor(Σ attack of attacking land units × m / 1000)`
- `D = floor((Σ defense of defending land units + baseDef(acropolis)) × (1000 + 50·wall) / 1000)`. D is always ≥ 70.
- **A > D:** the attacker wins.
  - Every defending unit in the city is destroyed: land units **and** any remaining ships, of every owner.
  - Each attacking land stack, settlers included, loses `cas(n, lossPm(D, A))`.
- **A ≤ D:** the defender wins.
  - Every attacking land unit dies, settlers included. Attacking ships survive and return empty.
  - Each defending land stack loses `cas(n, lossPm(A, D))`.
- Ships never die in the land phase except as described above.

### 8.6 Outcome of a city battle won by the attacker

1. **Wall breach:** the wall drops 1 level (minimum 0). Queued wall items are left alone; each still adds +1 to the level current when it completes (§5.3).
2. If **≥ 1 attacking settler survived** and the city can be besieged, a **siege starts** (§9.1). A city cannot be besieged if it is a capital before t = 172800.
   - A lone settler survives only if q < 500, i.e. A > ~1.41·D.
   - With two settlers, one survives as long as q < 750, i.e. A > ~1.15·D.
3. Otherwise it is a **raid**: the survivors take loot (§8.7) and return home.

Relief and homecoming battles never breach the wall and never loot (§9.3).

### 8.7 Loot

- `carry = Σ carry × surviving attacking land units` (peltast 50, hoplite 10).
- `lootable_r = max(0, stock_r − 100 × warehouse)`, and `T = Σ lootable`.
- If T ≤ carry, take everything lootable. Otherwise `take_r = floor(lootable_r × carry / T)`; the leftover capacity is unused.
- The loot leaves the city at once and is added at home when the survivors arrive (capped by the warehouse).

**Raid economics** for 100 peltasts (13 000 resources) against a stocked target:

| Odds  | Peltasts lost (resources) | Loot carried |
| ----- | ------------------------- | ------------ |
| 2 : 1 | 25 (3 250)                | 3 750        |
| 3 : 1 | 11 (1 430)                | 4 450        |
| 4 : 1 | 6 (780)                   | 4 700        |

Raiding weak or empty-handed neighbours pays; trading at even odds does not.

### 8.8 Battle points

- **Attacker credit:** the attacker gains the pop of every defending unit destroyed (ships included).
- **Defender credit:** the pop of attacking units destroyed is split among the defending owners in proportion to the pop each had in the battle at its start: `floor(killed × ownerPop / totalDefenderPop)`.
  - If totalDefenderPop = 0, everything goes to the city owner (city battle) or to the besieger (garrison battle).
  - The neutral Olympus earns nothing.
  - Remainders are discarded.
- **Anti-collusion.** No credit is given between two players who share an alliance or a pact at resolution, or did so within the previous 86400 s.
- Consumed settlers are not "destroyed".
- There are no day multipliers.
- Battle points enter the score capped (§13.1).

### 8.9 Betrayal

- When a battle resolves and the attacker's foe is the attacker's ally or pact partner:
  - the pact ends, or the attacker leaves the alliance (an alliance left with 1 member dissolves);
  - a public `betrayal {t, by, against, relation, city}` event fires.
- The attack is never prevented.
- The event fires **on impact**, not at launch. While an attack is in flight, its target only sees "attack from your ally p3, arriving at t", with no composition.
- Shared vision (§12) still shows the target what is at home in its ally's cities. A target that watches them can see troops leave and guess the size of the attack, so the "it's only a fake" bluff works only on a target that does not look. Nothing shows where those troops went.
- Spying, supporting, recalling and dismissing never count as betrayal.

### 8.10 Reports and headlines

- **Battle report `r#`.**
  - Recipients: the attacker, the city owner (or the besieger in a garrison battle) and every owner of a defending stationed group.
  - Contents:
    - time, city, island, battle type, attacker and foe, morale;
    - per phase: strengths (Na/Nd, or A plus the parts of D: Σdef, baseDef, wall level and factor), winner, q, and per owner and unit type the counts before / lost / survived;
    - wall before → after, loot per resource and any overflow lost, siege started or broken, battle points credited.
  - If **no attacking unit survived**, the attacker's copy shows only the outcome, the phase reached and its own losses.
- **Public headline**: `{t, city, attacker, defender (owner / besieger / "neutral"), type, winner}`, with no numbers. Siege starts, siege ends and conquests are public events too (§11.5).

### 8.11 Attack trains

A train is a series of waves that land close together. Each wave resolves against what the previous ones left, and units that arrive or finish training in between defend too.

- Waves land in the **same second** only when they travel the same time and are launched in the same second: in practice, from cities on the same island, in one turn. They then resolve in seq order (§1.4), which is launch order.
- Waves from cities on different islands land in arrival order, usually minutes apart. A self-wake (`end_turn`) can be asked for an exact second, but at least 600 s ahead, so such waves can be timed closely only when their travel times differ by 600 s or more. In real time, thinking time still shifts each launch.

A typical train:

1. A trireme strike clears the harbour.
2. A mass raid kills most of the garrison, even if it loses: losing at 0.96:1 still kills 92% of the defenders.
3. A small wave carrying 2 settlers starts the siege.

Supports that arrive in the same second as a wave land first (class 4 before 7) and defend.

### 8.12 Worked example 1: naval phase, morale, a failed conquest, loot

All numbers below were checked by script.

**Setup (day 4):**

- p2 (6 cities) attacks c14 of p5 (4 cities) from c9, 90 tiles away. Travel takes `isqrt(60² · 90²) = 5400` s.
- Attack: 360 peltasts, 1 settler, 19 transports (capacity 380 ≥ 360 + 10 pop) and 8 triremes.
- c14: acropolis 6, wall 4, warehouse 5, stock 3200 / 2500 / 1800.
  - p5 at home: 120 hoplites, 30 peltasts, 4 triremes, 2 transports.
  - Ally p7 stationed: 60 hoplites, 1 trireme.

**Battle:**

| Step          | Computation                                                                            | Result                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Morale        | 1000 − 100·(6 − 4)                                                                     | m = 800                                                                                                                                                                                      |
| Naval         | Na = floor(8·50·800/1000) = 320; Nd = 5·50 = 250                                       | attacker wins; q = lossPm(250, 320): r = 781, q = 609 → p2 loses cas(8, 609) = 5 triremes. All 7 defending ships sink (p5: 4 triremes + 2 transports; p7: 1 trireme).                        |
| Land          | A = floor(360·20·800/1000) = 5760; D = floor((180·20 + 30·5 + 170) × 1200/1000) = 4704 | attacker wins; q = lossPm(4704, 5760): r = 816, q = 665 → p2 loses cas(360, 665) = 239 peltasts (121 survive) **and cas(1, 665) = 1 settler**. All 210 defending land units die. Wall 4 → 3. |
| Outcome       | the settler died                                                                       | no siege: **raid**                                                                                                                                                                           |
| Loot          | carry = 121·50 = 6050; lootable = 2700 / 2000 / 1300 (T = 6000 ≤ 6050)                 | p2 takes 2700 / 2000 / 1300                                                                                                                                                                  |
| Battle points | p2 destroyed 24 ship pop + 210 land pop                                                | p2 +234                                                                                                                                                                                      |
|               | defenders destroyed 5·4 + 239 + 10 = 269 pop; defending pop was p5 170 and p7 64       | p5 +195, p7 +73                                                                                                                                                                              |

**Lesson for agents:** win by more than 1.41 : 1, or bring 2 settlers.

---

## 9. Sieges, conquest, Olympus, elimination

### 9.1 Siege start

A siege starts when a city battle is won by an attack that still has ≥ 1 settler (§8.6).

- **Garrison:** every surviving unit of the movement (ships included), plus the attacker's stand-aside units in the city. Garrison units keep their home city.
- Siege record: `{by: attacker, startedAt: t, endsAt: t + 21600}` (6 h).
- Public event `siege_started {city, owner, by, endsAt}`.
- The city's three queues are cancelled with normal refunds (§5.3, §6.3), paid into its own stock. The owner alone gets `queues_refunded {city, refund, lost}`: what was credited and what the warehouse cap cut (§4.3), when anything was due.

### 9.2 During a siege

- The owner keeps ownership, score and production: the stock keeps accruing.
- **The owner cannot build, recruit or send anything from the city.**
- Units homed in the city that were away stay alive. They may stay away, or come home and fight a homecoming battle.
- Only the besieger may reinforce the garrison, with `support` (settlers allowed) or `attack`. Supports and shipments from anyone else bounce.
- The besieger may recall garrison units at any time (§7.4).
- The city still counts for its owner in morale, score and domination.

### 9.3 Garrison battles and breaking a siege

- A **relief battle** is any attack whose foe is the besieger. The city's owner, its allies and any third party may launch one.
- A **homecoming battle** happens when the owner's units return home. Its attacker is the returning group's owner and its foe is the besieger: morale (§8.2), battle points (§8.8) and betrayal (§8.9) use that pair. The naval phase runs when the return left from another island than the city's.
- The besieger sees every return heading into the city it besieges as an incoming attack without composition and without origin (§12: id, owner, launch and arrival times; the notice's `from` is `null`), from the siege start or from the return's departure, whichever is later. The origin would reveal where the returning player had troops stationed, or the target of a movement that bounced. A return created by an in-window recall after the siege started takes at least 1 h (§7.4), so the besieger always gets that hour of warning; a return already under way when the siege starts may land sooner, which is the besieger's risk.
- Both use §8 with the garrison as the defender: wall factor and base defense included, **no wall breach, no loot**.
  - Relief survivors return home.
  - Homecoming survivors are home, with their cargo.
  - If a homecoming loses, the whole returning group and its cargo are lost.
  - A homecoming always runs its land phase. A group without land units (ships only, or cargo only) counts as A = 0 and loses, so do not send ships or shipments home into a siege.
- **The siege ends** as soon as the garrison has **no settler left**. That happens:
  - when a relief or homecoming wins (the garrison is wiped out);
  - when the garrison's settlers die even though the relief lost: losing at 0.86:1 already inflicts q = 732, which kills one settler of every two;
  - when the besieger recalls them ("abandoned");
  - when the besieger is eliminated.
- Public event `siege_broken {city, by, cause}`. The surviving garrison units start their return trips.
- A third party can break a siege but never takes the city. To take it, it must launch its own conquest attack afterwards.

### 9.4 Conquest

At `endsAt` (class 9, after every attack of that second), if the garrison still holds a settler:

1. The owner becomes the besieger. One settler is consumed. The rest of the garrison is **re-homed** to the city (their pop now counts here).
2. Buildings (with the breached wall) and stock are kept. Queues are already empty.
3. §7.7 applies to the former owner (fallback re-homing or elimination).
4. Public event `city_conquered {city, from, to}`. Then elimination and domination are evaluated.

### 9.5 Capital immunity

Before t = 172800, a won conquest attack on a capital (`c1..cN`) is resolved as a raid, and the settlers return home. The launch is accepted, with a warning when the attack carries settlers and lands before 172800. From day 3 on, capitals are ordinary cities, and losing your last city eliminates you.

### 9.6 Olympus

- The neutral Olympus city sits on the central island. It has every building at 5, a 3000 / 3000 / 3000 stock, and 400 hoplites + 10 triremes that never regenerate and never act.
- **Breaking it:**
  - land D = floor((8000 + 150) × 1250/1000) = 10187;
  - naval Nd = 500, so attackers crossing water need ≥ 11 triremes (11 lose 9; 16 lose 6).
- It is raidable (500 of each resource is protected) and besiegeable like any city, with morale 1000.
- Spying on it needs > 750 gold.
- Once captured it is an ordinary city of its owner. It keeps its island's ×1.5 production and the **+100 Olympus bonus** in score.
- **Soften-then-snipe.** A losing wave of 500 peltasts (A = 10000) still kills 96% of the garrison. The day's real drama is who lands the settler second.

### 9.7 Elimination

A player with 0 cities is **eliminated** at once:

- all their units, stationed groups, garrisons and movements are removed, and their sieges break;
- their open proposals are cancelled;
- they leave their alliance and their pacts end (public);
- their score freezes.

The seat stops acting. Eliminated players rank last (§13.4).

### 9.8 Worked example 2: train, siege, reinforcement, relief

All numbers below were checked by script. It continues example 1: c14 now has wall 3, no ships, and 40 newly recruited hoplites.

| Step                                      | Computation                                                                                                                                                                                                                                                                                  | Result                                                                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wave                                      | p2 sends 150 peltasts, 2 settlers, 9 transports (capacity 180 ≥ 170) and the 3 surviving triremes. Naval: Nd = 0, so p2 wins at no cost. A = floor(150·20·800/1000) = 2400; D = floor((800 + 170) × 1150/1000) = 1115                                                                        | p2 wins: q = lossPm(1115, 2400) = 215 → 32 peltasts lost, cas(2, 215) = 0 settlers lost. 40 hoplites die. Wall 3 → 2. **Siege starts**, ending 6 h later (public).                                                |
| Garrison                                  | 118 peltasts, 2 settlers, 9 transports, 3 triremes, all homed in c9                                                                                                                                                                                                                          | garrison D = floor((590 + 170) × 1100/1000) = 836. That is weak, so p2 sends 100 hoplites as `support`: 60 from c11 and 40 from c12. They join the garrison as two groups → D = floor((2590 + 170) × 1.1) = 3036. |
| Relief by ally p7 (3 cities; morale 1000) | 4 triremes + 130 peltasts + transports. Naval: 200 > 150, q = lossPm(150, 200) = 562 → p7 loses 2 triremes, and the garrison's 3 triremes and 9 transports sink. Land: A = 2600 ≤ D = 3036                                                                                                   | **relief lost**, all 130 peltasts die. But q = lossPm(2600, 3036) = 732 hits the garrison: −86 peltasts, −73 hoplites and **cas(2, 732) = 1 settler**. One settler is left, so the siege holds.                   |
| Split stack (§8.3)                        | the 73 hoplites lost are split over the c11 group (60) and the c12 group (40): floor(73·60/100) = 43 rem. 80; floor(73·40/100) = 29 rem. 20; 1 loss left                                                                                                                                     | it goes to the larger remainder: c11 loses 44 (16 left), c12 loses 29 (11 left). 27 hoplites remain.                                                                                                              |
| Alternative: 160 peltasts                 | A = 3200 > 3036                                                                                                                                                                                                                                                                              | relief wins with q = 898 (144 lost, 16 go home). The garrison is wiped out and the **siege is broken** (public). No wall change, no loot.                                                                         |
| Alternative: homecoming                   | after the lost relief, p5 recalls 60 peltasts stationed in an ally's city on another island. Garrison: 32 peltasts, 27 hoplites, 1 settler, no ships; D = floor((160 + 540 + 170) × 1100/1000) = 957. Attacker p5 (4 cities), foe p2 (6): morale 1000. Na = Nd = 0, no naval phase. A = 1200 | homecoming wins with q = lossPm(957, 1200) = 635: p5 loses cas(60, 635) = 38 peltasts and 22 are home. The garrison is wiped out and the **siege is broken**. No wall change, no loot.                            |

---

## 10. Espionage

- `spy(from, target, gold)`: `gold ≥ 100` is paid at departure. Spies need no units and travel at pace 30. They are **invisible** to everyone but the sender and cannot be recalled.
- Spying is allowed during protection and against Olympus, but not against your own cities. If the spier owns the target at arrival, the spy simply reports.
- **Counter-intel** `= 100 + 50 · wall + Σ land pop present in the city` (every owner, garrison included).
  - **Success** iff `gold > counter-intel`; ties go to the target.
  - The gold is spent either way.
  - Spy costs therefore scale with the target: a day-4 capital (wall 2, 147 pop) needs > 347 gold, a maxed turtle > 1040.
- **On success,** a report `r#` goes to the spier, and the target is not told. It is a snapshot at arrival time containing:
  - building levels, stock, wall, siege state;
  - units present by owner and role (home, stationed, garrison);
  - build and recruit queues with their end times.

  It does **not** show units away or movements.

- **On failure,** the spier learns only that it failed. The city owner is told the spier, the origin city and the gold spent.
- Spying never breaks a relation.

---

## 11. Diplomacy (nothing is binding)

### 11.1 Messages

- `send_message(to: [player ids] | "all", text ≤ 1000 chars)` is delivered instantly.
  - A list is private: recipients see the sender and the whole recipient list.
  - `"all"` is public: it goes to the public feed and wakes nobody.
- Cap: **20 sends per seat per game day**. One call counts once, whatever the number of recipients.
- Messages reach models as typed `{from, to, text}` fields, never as instructions.

### 11.2 Proposals

- `propose_alliance(to, kind: "alliance" | "pact", name?, text ≤ 300)` creates `q#`.
- At most **3 open outgoing proposals** per player, and one per (from, to, kind).
- Proposals expire after **43200 s** (class 10).
- `answer_proposal(id, accept)` re-checks every condition at acceptance. If a check fails, the error explains it and the proposal stays open.
- Pending proposals are private to the two players.

### 11.3 Alliances: named, capped blocs

- Each player is in at most one alliance `a#`. Membership is public.
- **Size cap:** `max(2, floor(N/3))`, i.e. 2 for N = 6–8, 3 for N = 9–11 and 4 for N = 12.
- **On acceptance:**
  - If neither player is allied, a new alliance forms. It is named by the proposer (≤ 24 characters among ASCII letters and digits, space, `-`, `_` and `.`), or `a<k>` by default.
  - If exactly one is allied, the other joins that alliance, if it is not full.
  - If both are allied, the proposal is invalid: one of them must leave first.
  - **Pacts superseded.** Every pact between the joining player(s) and a member of the resulting alliance ends at once with cause `superseded` (public `pact_ended`). This is not a betrayal and frees the pact slot. No relation end is recorded for the kill-credit rule (§8.8), since the two players stay related.
- `leave_alliance()` takes effect at once and is public. An alliance left with 1 member dissolves.
- **Effects:**
  - shared vision (§12);
  - the domination bloc (§13.3);
  - urgent wakes when a member's city is besieged (§14.2).

  Nothing else: allies can attack, spy on or besiege each other (§8.9).

### 11.4 Pacts

- A pact is a public, bilateral non-aggression label between two players who are not allies.
- It lasts **172800 s** (48 h) from acceptance. Proposing a pact to a current partner and having it accepted renews it for 48 h from that acceptance. A pact cannot be proposed to an ally.
- Each player holds **at most 2 pacts**. This is checked at acceptance; a renewal does not count as a new pact.
- `leave_alliance({ with: p })` ends the pact with p early (public). Naming an ally instead leaves the alliance, as `leave_alliance()` does.
- A betrayal ends it at once (§8.9).
- Expiry is public. A pact has no mechanical protection: its value is reputation, the betrayal record and the kill-credit rule (§8.8).

### 11.5 Public feed

The public feed contains:

- alliances formed, joined, left or dissolved; pacts signed, renewed, ended or expired; betrayals;
- cities founded or conquered; sieges started, broken or abandoned; battle headlines;
- eliminations; domination countdowns started, cancelled or won;
- public messages; match end.

### 11.6 Tribute

Tribute is a `send_resources` shipment (§7.3). The recipient (and its allies) sees it incoming; it is not public.

---

## 12. Visibility (fog of war)

| Information                                                                                                                                                                                                                                                                                     | Who sees it                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Map: islands, coordinates, kind, richness, slots; every city's id, island, slot, owner, points, capital flag, siege flag and end time, taken flag (for the owner's bloc, §13.3) and former owners (they follow from the public conquests and alliances, §11.5)                                  | everyone                                                                                  |
| Players: score and its parts (city points, battle score), city count, taken cities, alliance, pacts with expiry, eliminated flag, every bloc's cities and taken cities against the domination threshold, domination countdowns, tie-break order, public feed. Raw battle points are not public. | everyone                                                                                  |
| Own city in full: stock, rates, buildings, queues, pop, units present (foreign groups included), incoming movements                                                                                                                                                                             | owner, **and the owner's alliance members** (live shared vision, cut off when they leave) |
| Own units anywhere (stationed groups and garrisons abroad), own movements, settler k, own reports, own notes                                                                                                                                                                                    | owner only (`view_player` on yourself lists them)                                         |
| Incoming **attack** on a city: id, origin city and owner, its recorded foe, launch and arrival times, "turned back" if recalled. No composition.                                                                                                                                                | city owner, its allies, and owners of groups stationed there (the besieger included)      |
| A return heading into a besieged city (a coming homecoming battle): id, owner, launch and arrival times. No composition, no origin.                                                                                                                                                             | the besieger                                                                              |
| Incoming support or shipment: full                                                                                                                                                                                                                                                              | city owner and its allies                                                                 |
| Spies and founding movements in flight                                                                                                                                                                                                                                                          | sender only                                                                               |
| In your briefing: the siege flag and end time of your own besieged cities, the sieges you hold (city, owner, end time), every running domination countdown, and your bloc's cities and taken cities against the threshold                                                                       | you (all of it is public anyway)                                                          |
| Foreign city details                                                                                                                                                                                                                                                                            | only through spy or battle reports, shown as timestamped snapshots                        |
| Messages and proposals                                                                                                                                                                                                                                                                          | sender and addressees only                                                                |
| Battle and spy reports                                                                                                                                                                                                                                                                          | as in §8.10 and §10                                                                       |
| Everything, including private messages, notes and agent thoughts                                                                                                                                                                                                                                | spectators, outside the game                                                              |

---

## 13. Score, leaderboard, victory

### 13.1 Score

- **City points** = Σ over owned cities of `100 + Σ building levels + (100 if it is Olympus)`. A fresh city is worth 105, a maxed city 180, and Olympus 240. A taken city (§13.3) scores like any other.
- **Battle score** = `min(floor(battlePoints / 10), floor(cityPoints / 4))`, where battle points come from §8.8.
- **Score** = city points + battle score. It is computed live and public.

### 13.2 Leaderboard

The leaderboard is public. It shows:

- rank, player, score (city points and battle score), cities;
- alliance, pacts;
- eliminated flag;
- the domination threshold in cities and taken cities, and the map's city slots;
- every bloc (alliances by id, then lone players) with its members, cities and taken cities;
- every domination countdown, with the same and its end.

While the match runs, equal scores are ordered by cities, then the public tie-break order. Battle points are private (§12), so they break ties only in the final ranking (§13.4).

Army sizes are not public to players; spectators see them.

### 13.3 Victory

1. **Domination (bloc, by conquest).** A **bloc** is an alliance (its current members) or a player outside any alliance.
   - **Taken cities.** A city is _taken_ for its owner's bloc when the owner got it by conquest (§9.4, Olympus included) and no member of the bloc ever owned it (for a lone player: the owner never owned it before).
     - Founding never makes a city taken. A former owner that recaptures a city does not take it, even if it first got the city by conquest.
     - A city conquered from a player who is now a member of the owner's bloc is not taken for that bloc: a city an ally recaptures for a member who had lost it, or two cities a player conquered from another before they allied. It counts again if they part, since taken cities follow the owner's bloc as it is now.
     - A city taken from a pact partner, an outsider or a former ally counts: a conquest that follows a betrayal counts, since the betrayer leaves the alliance when its attack lands (§8.9) and the victim is outside its bloc.
     - City views mark the cities taken for their owner's bloc and list every city's former owners (§12).
   - **Threshold:** `need = max(dominationMinPerPlayer × N, ceilDiv(dominationPm × totalSlots, 1000))` cities, of which `dominationMinConquests` taken.
     - `totalSlots` is the number of city slots of the map, Olympus included: 43, 50, 49, 55, 61, 67 and 73 for N = 6..12 (§2.4). It is fixed for the match.
     - With the defaults (350‰, 2 per player, 2 taken), `need` is 16, 18, 18, 20, 22, 24 and 26 cities for N = 6..12, at least 2 of them taken. 1.0.0's share was 400‰ of the cities that existed; §0.1 says why 1.1.0 asks for 350‰ of the slots.
     - Foundings never raise it, so a founding by another player never cancels a countdown (in 1.0.0 the threshold counted the cities that existed).
   - **Qualifying:** a bloc qualifies when `t ≥ 259200` (day 4) and `blocCities ≥ need` and `blocTaken ≥ dominationMinConquests`. A besieged city counts for its owner, taken or not.
   - Qualifying starts a public **24 h countdown** (ends at t + 86400, class 11) while it can still end by `matchEnd`: only until `t = matchEnd − dominationHold` (518400, D7 00:00). A countdown that ends at `matchEnd` still wins, since class 11 runs before the time victory. Its event `domination_started` gives the bloc's cities and taken cities and the threshold's (`threshold`, `needTaken`).
   - The countdown is cancelled the moment the bloc stops qualifying, with reason `condition` (too few cities or too few taken cities), **or the bloc's membership changes**, with reason `membership`. Taken cities move with their owner when it joins or leaves. A new composition may start a fresh countdown in the same second.
   - **Evaluation.** From t = 259200 (the `domination_open` timer, class 10), every bloc is evaluated at the end of every step, i.e. after every event and every accepted action (foundings included). First, the countdowns whose bloc no longer qualifies or whose membership changed are cancelled. Then countdowns start for qualifying blocs without one, in bloc order: alliances by id, then lone players by id (`compareIds`). A conquest is recorded in the step of its siege end (class 9), so a conquest in the second a countdown ends (class 11) is resolved first.
   - When a countdown ends and the bloc still qualifies, **the bloc wins** and the match ends.
   - If several countdowns end in the same second, the order is: more cities, then higher total score, then the best tie-break position among the members.
   - **Expected effort.** A full bloc at its peaceful share (7 cities a player for N ≤ 7, 6 for N ≥ 8) is 2, 4, 6, 2, 4, 6 and 2 cities short of `need` for N = 6..12, and at least 2 of the cities it holds must be taken: domination needs conquest whatever the founding pace. The effort is lowest at N = 6, 9 and 12; with the bots, only N = 6 produced dominations (§0.1, "Seat counts").
   - **Collusion.** The rule works per bloc: no member can count a city that it or an ally ever owned, so two players cannot trade cities and then ally (in the calibration batches, scripted bots did exactly that by accident: a `conqueror@3` took two cities from an `opportunist@3`, they allied on day 7 and started a countdown at once, which 1.1.0 no longer allows). What still counts needs a third party: a city taken from a player outside the bloc, such as a kingmaker who gives up its cities, or a former ally after a betrayal. Each needs the full city count and public 6 h sieges, and the former owners shown on every city make it visible.
2. **Last standing.** If an elimination leaves exactly one player, that player wins at once.
3. **Time.** At t = 604800, after every other event of that second, the highest score wins. This victory is individual, even for allies.

### 13.4 Final ranking (no shared ranks)

1. The winner, or the winning bloc's members.
2. Every other survivor.
3. Eliminated players: latest elimination first, then tie-break order.

Within groups 1 and 2, players are ordered by score, then cities, then battle points, then the public tie-break order.

---

## 14. Gateway rules (LLM-agnostic, hashed with the rules)

### 14.1 Caps

| Cap                                     | Value                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| model round trips per wake              | 8                                                                                                                                                                  |
| tool calls per round trip               | 10; calls beyond are rejected. No separate per-wake call cap.                                                                                                      |
| own wakes per seat per game day         | 12: self-scheduled wakes and triggers from your own activity                                                                                                       |
| social wakes per seat per game day      | 8: triggers caused by other players. They never use the own budget, so other players cannot drain it.                                                              |
| wake grouping window                    | 600 s                                                                                                                                                              |
| urgent wake gap                         | 600 s: an urgent wake starts at least 600 s after the start of the previous urgent wake; triggers in between join it                                               |
| self-scheduled wake (`end_turn`)        | 600–43200 s ahead, as a delay or an absolute time; a value outside is clamped into the range and the result says so; `end_turn` with neither keeps the pending one |
| safety wake                             | 43200 s after the end of the last wake                                                                                                                             |
| attack launches per player per game day | 20                                                                                                                                                                 |
| messages per seat per game day          | 20                                                                                                                                                                 |
| notebook                                | 4000 chars                                                                                                                                                         |

Urgent, safety and start wakes are exempt from both budgets.

### 14.2 Wake-ups

- A seat plays one turn at a time. Events that happen during a turn go into the next briefing.
- **Urgent** wakes fire as soon as the current turn ends, or at once if the seat is idle, but at most one urgent wake starts per 600 s: an urgent trigger within 600 s of the previous urgent wake's start waits for the end of that gap and joins any other trigger pending by then. Every briefing lists **all** incoming attacks, so the gap never hides one. Urgent triggers:
  - an incoming attack that will fight you: you are its recorded foe (your own city, or a city you besiege, homecomings included);
  - a siege started on your city or on an ally's city;
  - one of your cities conquered;
  - a betrayal against you;
  - a domination countdown started (only the first countdown of a bloc in a game day wakes anyone; later ones go to the news).
- **Own** wakes fire within the own budget. Triggers:
  - a self-scheduled time (it stays pending until it fires or a later `end_turn` replaces it);
  - a build or recruit queue becoming empty, 600 s after the first such trigger (the window gathers later ones);
  - your own battle report as the attacker of a city or relief battle, a spy report, a spy-failure notice, also grouped over 600 s.
- **Social** wakes fire 600 s after their first pending trigger, within the social budget. Triggers:
  - a private message, a proposal or an answer to yours;
  - a battle report as a defender, or of your troops' homecoming battle (other players can send them home: a dismissal, a bounce), a notice that your city was spied on;
  - an incoming attack on an ally's city, on a city where you have stationed troops, or on your city when its foe is someone else (a relief of your besieged city).
- Public messages (`"all"`) never wake anyone.
- When a wake fires it delivers every pending trigger, whatever its class. It counts against the own budget when an own trigger was due, otherwise against the social budget, and against neither when it carries an urgent, safety or start reason. A wake whose budget is used up for the day moves to the start of the next game day.
- **Fake attacks** are bounded:
  - the launch cap;
  - visible recalls ("turned back");
  - the urgent wake gap;
  - their cost to the faker, who must also wake to launch each separate one.

### 14.3 Tools (the brief's 22, with their rule hooks)

| Tool               | Arguments                                                                              | Rules                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view_city`        | `city`                                                                                 | own or ally city: full; other: public fields + latest snapshot (§12)                                                                                                            |
| `view_island`      | `island`                                                                               | kind, coords, richness, slots and occupants, travel times from each own city (§2, §7.2)                                                                                         |
| `view_map`         | `fromCity?`                                                                            | all islands and cities; with `fromCity`, transport / trireme / spy times to every island                                                                                        |
| `view_player`      | `player`                                                                               | public profile, score parts, cities, relations; on yourself, also your movements, stationed groups abroad, settler k and next settler cost, open proposals and today's counters |
| `leaderboard`      | –                                                                                      | §13.2                                                                                                                                                                           |
| `rules`            | –                                                                                      | the interface rules (wakes, caps, formats), cheat sheet (§0), config (§16) and derived tables                                                                                   |
| `build`            | `city, buildings[]`                                                                    | §5.3                                                                                                                                                                            |
| `recruit`          | `city, orders[{unit, count \| "max"}]`                                                 | §6.3                                                                                                                                                                            |
| `cancel_queue`     | `city, item`                                                                           | tail cancel from queue item `#item` (§5.3, §6.3)                                                                                                                                |
| `send_resources`   | `from, to, wood, stone, gold`                                                          | §7.3                                                                                                                                                                            |
| `attack`           | `from, to, units`                                                                      | §7–9; settlers make it a conquest attempt                                                                                                                                       |
| `support`          | `from, to, units`                                                                      | §7.3, §7.5, §9.2                                                                                                                                                                |
| `spy`              | `from, to, gold`                                                                       | §10                                                                                                                                                                             |
| `recall_troops`    | `movement?, stationedAt?, home?, units?, dismiss?: {city, player}`: exactly one mode   | §7.4                                                                                                                                                                            |
| `found_city`       | `from, island, units, slot?`                                                           | §7.3, §7.5; perfidia-1 always uses the lowest free slot and rejects `slot`                                                                                                      |
| `send_message`     | `to[] \| "all", text`                                                                  | §11.1                                                                                                                                                                           |
| `propose_alliance` | `to, kind, name?, text?, until?`                                                       | §11.2–11.4; perfidia-1 pacts last 48 h and reject `until`                                                                                                                       |
| `answer_proposal`  | `id, accept`                                                                           | §11.2                                                                                                                                                                           |
| `leave_alliance`   | `with?`                                                                                | §11.3, §11.4                                                                                                                                                                    |
| `write_note`       | `text, mode: append \| replace`                                                        | notebook                                                                                                                                                                        |
| `read_notes`       | `search?: {scope: mine \| public \| all, text?, kinds?, with?, since?, until?}, open?` | notebook, your archive and the public feed                                                                                                                                      |
| `end_turn`         | `nextWakeIn?, wakeAt?`: at most one                                                    | §14.1, §14.2                                                                                                                                                                    |

The tool names and argument shapes are the same in every ruleset. `slot` and `until` exist for rulesets that use them; perfidia-1 rejects them with an explanation.

**Errors** are data: `{ok: false, code, message, hint}`. They carry numbers, for example "need 1500 gold, have 1210 (+310/h): affordable at D3 14:58:08 (in 56m8s)" (at t = 223320, `docs/architecture.md` §7.3) or "settler k = 6 costs 4500 gold: warehouse 5 holds 3560, build warehouse 6".

---

## 15. Pacing sanity

### 15.1 Reference timeline (N = 8, peaceful reference bot)

**The bot:**

- It acts every 2 h (12 decisions per game day, i.e. the own wake budget).
- Economy first; settlers as soon as they are affordable.
- It sends its settlers to the home slot, a frontier, the backyard, the inner island, then the next frontier.
- Its surplus goes to hoplites and peltasts at 1:1.
- It never fights.

These are exact rules, simulated at a 60 s step. A 1 h cadence moves the city rows by −4 h to +2 h; a 3 h cadence delays them by up to 9 h.

| Time                    | Typical player                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00                    | H1, producers 75/h each, 800 of each resource, 10 hoplites                                                                                          |
| 0:48 / 2:00 / 2:54      | acropolis 2, then acropolis 3, then barracks 2 (settlers unlocked)                                                                                  |
| 6:00                    | settler 1 queued (450/450/750), with harbor 1 at 6:33                                                                                               |
| **9:00**                | **city 2** on the free home slot (a 1 h walk)                                                                                                       |
| **12:00**               | **protection ends.** The expander has 10 hoplites and 1 transport. A rush opener has ~20 peltasts + 1 transport (it is wood-limited).               |
| 13:00 / ~13:30 / ~15:00 | earliest possible landings: same island, a frontier colony, a neighbour capital                                                                     |
| 22:00 → **25:30**       | settler 2 (900/900/1500) → **city 3 on a frontier** (×1.5, shared with a neighbour): the day-1/day-2 race and first contact                         |
| end of day 1            | 2 cities (the 3rd lands at 25:30); capital H3 with producers L3–4; income ≈ 420/430/310 per h; army ≈ 20 pop                                        |
| 43:20                   | city 4 (backyard)                                                                                                                                   |
| end of day 2            | 4 cities; income ≈ 1300/1100/1200 per h; army ≈ 200 pop (92 hoplites, 82 peltasts, 5 transports); score ≈ 496                                       |
| 55:45                   | city 5 (inner, ×1.25)                                                                                                                               |
| end of day 3            | 5 cities; capital H5, producers L7–8; income ≈ 2000–2300 per h each; army ≈ 680 pop; score ≈ 660                                                    |
| **73:30**               | **city 6: the bot's 5-slot share of free land is used up.** From here, growth means conquest. For N ≤ 7 (6 free slots) the 7th city comes at 83:45. |
| end of day 4            | 6 cities; income ≈ 3500–3700 per h each; army ≈ 1200 pop (563 hoplites, 529 peltasts); capital H7                                                   |
| end of day 5            | **pop cap reached** (2050 / 2050); capital acropolis and producers at 10; warehouses start to fill                                                  |
| end of day 6            | 2374 pop; capital wall 10                                                                                                                           |
| end of day 7            | ≈ 2580 pop (1260 hoplites, 1226 peltasts, 33 transports); capital fully maxed (80 levels); score ≈ 1029 (6 × 100 + 429 levels)                      |

### 15.2 Defense targets

| Target                                                             | D                     | What breaks it                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fresh colony (H1, wall 0, empty)                                   | 70                    | 4 peltasts; 20 peltasts + 1 settler start a siege at q = 30                                                                                                                                                                                                                          |
| fresh colony with a 10-hoplite escort                              | 270                   | 20 peltasts (lose 9)                                                                                                                                                                                                                                                                 |
| capital at 12:00 (H3, 10 hoplites)                                 | 310                   | a 20-peltast rush wins but keeps 8 peltasts (400 carry): rushes are weak                                                                                                                                                                                                             |
| day-2 colony (H3, 20 hoplites)                                     | 510                   | ~40 peltasts                                                                                                                                                                                                                                                                         |
| day-4 capital (H7, wall 2, 76 hoplites + 71 peltasts)              | 2271                  | not one city's ~70 peltasts. A **3-city train** of 70-peltast waves landing a few minutes apart does it, if the defender gets no reinforcement in between: waves 1–2 lose but cut the defenders to 5 + 5 (D = 346); wave 3, carrying a settler, wins with q = 61 and starts a siege. |
| day-7 capital (H10, wall 10, 200 hoplites + 200 peltasts)          | 7875                  | a 2-wave train of 300 peltasts each: wave 1 loses but kills 58%; wave 2 wins against D = 3525 (q = 344, 103 lost, a lone settler survives)                                                                                                                                           |
| maxed turtle (H10, wall 10, 440 hoplites, the most one city holds) | 13575                 | three single-city waves across water (400 + 400 + 150 peltasts): waves 1–2 lose but cut the hoplites to 62; wave 3 wins (q = 555). Defense trades about 2:1 in resources, but a coordinated offensive breaks any single city.                                                        |
| Olympus                                                            | 10187 (+ 10 triremes) | a 2-player or 3-city effort, plus ≥ 11 triremes                                                                                                                                                                                                                                      |

### 15.3 Why 7 days force contact and conflict

1. **Scarce land.** Each player has only 5 free slots (6 for N ≤ 7), and only 2 of them are near-safe. The other 3 are shared with the two neighbours, and the best (×1.5 frontier) is 1 h 30 from both. An efficient player wants its 3rd city on day 1–2 and has used up its share by day 4. LLM agents will be slower, so expect day 4–5.
2. **Contact on day 1.** Protection ends at 12:00. Colonies are cheap to besiege (D = 70), and the frontier race starts around 22:00–26:00.
3. **Idle capacity.** Pop caps bind on day 5 and warehouses fill by day 6, so a passive empire wastes its production. The only ways to grow afterwards are conquest and Olympus.
4. **Points are cities.** 100 per city, against 1 per building level. A maxed capital is worth 180; a conquered city swings about 2 × 140 between two players.
5. **No peace ring.** Alliances are capped at max(2, ⌊N/3⌋). Any split of the ring into blocs that small leaves ≥ 3 borders between blocs, and the two pacts a player may hold expire every 48 h. The time victory is individual, so even allies compete.
6. **Focal prize.** Olympus sits at the centre (1 h from every hub for N ≤ 7). It holds 9000 stock and is worth 240 points. Its garrison never regenerates, which invites "you soften it, I take it" deals and betrayals.

### 15.4 Anti-turtle and anti-snowball

| Anti-turtle                                                                        | Anti-snowball and comeback                                                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| the wall loses a level on every lost city battle                                   | settler cost ×k (it resets when you shrink back to 1 city)                                     |
| the square law rewards concentration, and trains crack any single city             | morale: up to −30% attack against smaller players                                              |
| spy counter-intel grows with the pop present, but gold always buys the information | 6 h public sieges with relief and homecoming battles                                           |
| full warehouses and pop caps waste idle production                                 | units of a lost city are re-homed, not erased                                                  |
| cities are most of the score; battle points (capped) reward both sides             | domination needs ≥ 2 taken cities and a 24 h public hold, and cancels on any membership change |
| pacts expire; Olympus is a jackpot                                                 | loot protection (100 per warehouse level); capitals immune until day 3                         |

---

## 16. RulesConfig data shape

The ruleset module (`config.ts`) defines this as a Zod schema. The `rules` tool returns it together with the derived per-level tables. The match stores `sha256(canonical JSON, keys sorted)` of the effective config. Numbers change only between matches. Fields marked _fixed_ are `z.literal` values: an override that changes them is rejected with a message naming the field as fixed by `perfidia-1@1.1.0`.

```ts
type ResourceId = "wood" | "stone" | "gold";
type Res = Record<ResourceId, number>;
type BuildingId =
  | "acropolis"
  | "sawmill"
  | "quarry"
  | "goldmine"
  | "warehouse"
  | "barracks"
  | "harbor"
  | "wall";
type UnitId = "hoplite" | "peltast" | "settler" | "transport" | "trireme";
type IslandKind = "olympus" | "home" | "backyard" | "frontier" | "inner" | "hub";
type Quad = { a: number; b: number; c: number }; // a·L² + b·L + c
type CitySeed = {
  buildings: Record<BuildingId, number>;
  stock: Res;
  units: Partial<Record<UnitId, number>>;
};

export interface RulesConfig {
  players: { min: 6; max: 12 }; // fixed
  time: {
    day: 86400; // fixed
    matchEnd: 604800;
    protectionEnd: 43200;
    capitalImmunityEnd: 172800;
    minTravel: 3600;
    sameIslandTravel: 3600;
    recallWindow: 600;
    siegeDuration: 21600;
    dominationStart: 259200;
    dominationHold: 86400;
    proposalTtl: 43200;
    pactDuration: 172800;
    killCreditCooldown: 86400;
  };
  map: {
    homeRadius: Record<number, number>; // {6:180,7:207,8:235,9:263,10:291,11:319,12:348}
    centerMargin: 120; // C = R + 120
    radius: { backyardOffset: 80; frontierOffset: 0; innerOffset: -80; hub: 60 };
    hubMaxPlayers: 7;
    radialJitter: 10;
    kinds: Record<IslandKind, { slots: number; richnessPm: number }>; // slots ≤ 100
    // olympus 1/1500, home 2/1000, backyard 1/1000, frontier 2/1500, inner 1/1250, hub 1/1250
  }; // SIN10K (§2.2) is a code constant of the ruleset, not a config field
  start: { capital: CitySeed; newCity: CitySeed; olympus: CitySeed };
  // capital: L1 acropolis/producers/warehouse, 800×3, {hoplite:10}; newCity: same buildings, 300×3, {};
  // olympus: all buildings 5, 3000×3, {hoplite:400, trireme:10}
  economy: {
    resourceScale: 3600; // fixed
    maxLevel: 10;
    levelWeight: Quad;
    levelWeightDiv: 10; // w(L) = L² + 3L + 6
    production: Quad; // 5, 20, 50
    warehouseCap: Quad; // 60, 280, 660
    lootProtectPerLevel: 100;
    popCap: Quad; // 2, 20, 40
    baseDefense: Quad; // 0, 20, 50
    buildTimeOffset: 9;
    recruitTimeOffset: 9; // /(9 + acropolis), ×10/(9 + level)
  };
  buildings: Record<
    BuildingId,
    { cost: Res; time: number; requires: Partial<Record<BuildingId, number>> }
  >;
  units: Record<
    UnitId,
    {
      domain: "land" | "naval";
      attack: number;
      defense: number;
      naval: number;
      carry: number;
      capacity: number;
      pop: number;
      cost: Res;
      time: number;
      queue: "barracks" | "harbor";
      requires: Partial<Record<BuildingId, number>>;
      seaPace?: number;
    }
  >;
  settler: { scaleCap: 10; maxPerOrder: 1 };
  queues: { buildMax: 5; recruitBatchesMax: 5; batchMaxUnits: 500 };
  movement: {
    spyPace: 30;
    homeboundPace: 60;
    shipment: { base: 500; perHarborLevel: 500; pace: 60 };
  };
  combat: { wallPmPerLevel: 50; wallBreachOnLoss: 1; moralePmPerCity: 100; moraleFloorPm: 700 };
  spy: { minGold: 100; counterBase: 100; counterPerWall: 50; counterPerLandPop: 1 };
  diplomacy: {
    allianceSize: { min: 2; divisor: 3 };
    maxPacts: 2;
    maxOpenProposals: 3;
    messageMaxChars: 1000;
    proposalTextMaxChars: 300;
    allianceNameMaxChars: 24;
  };
  scoring: {
    cityBase: 100;
    perBuildingLevel: 1;
    olympusBonus: 100;
    killPopPerPoint: 10;
    killCapPm: 250;
  };
  victory: {
    dominationPm: 350; // 1..1000, of the map's city slots
    dominationMinPerPlayer: 2; // 1..1000
    dominationMinConquests: 2; // 0..1000 taken cities (§13.3)
  };
  gateway: {
    roundTripsPerWake: 8;
    toolCallsPerRoundTrip: 10;
    toolCallsPerWake: null; // no per-wake call cap
    ownWakesPerDay: 12;
    socialWakesPerDay: 8;
    groupWindow: 600;
    urgentMinGap: 600;
    selfWake: { min: 600; max: 43200 };
    safetyWake: 43200;
    attackLaunchesPerDay: 20;
    messagesPerDay: 20;
    notesMaxChars: 4000;
  };
}
```

**Validation** (the schema, then the compile checks of `docs/architecture.md` §3.6 for every N in 6..12):

- every number is an integer (`z.number().int()`), and non-negative except the radius offsets;
- every `requires` refers to an existing building;
- exactly one unit has `capacity > 0`, and it is naval;
- `homeRadius` covers `players.min..max`;
- `kinds.home.slots ≥ 1` (slot 0 holds the capital) and `kinds.olympus.slots ≥ 1`; every `kinds.*.slots` is at most 100, so the threshold's `dominationPm × totalSlots` stays a safe integer whether domination is on or off;
- every derived build and recruit time is ≥ 1 (true by construction with `max(1, …)`);
- every start stock fits the cap of its city's start warehouse level;
- every world timer (`dominationStart`) is ≥ 1; timers after `matchEnd` are allowed and never fire;
- `victory.dominationPm` is within 1..1000, `victory.dominationMinPerPlayer` within 1..1000 and `victory.dominationMinConquests` within 0..1000, each rejected with what the key means, whether domination is on or off;
- while domination can open (`dominationStart ≤ matchEnd`), for every N: the threshold of §13.3 is ≥ 1 city and at most the map's city slots, and `dominationMinConquests` is at most the threshold. A failing check is reported once, at the key to change, naming every N it fails for (e.g. "N = 6..12: the domination threshold (48 cities at N = 6: …) is more than the map's city slots (43 at N = 6) …");
- `siegeDuration > recallWindow`, so no movement can still be recalled when its home city changes hands (a besieged city sends nothing, and the recall formula of §7.4 ignores re-homing);
- `sameIslandTravel ≥ minTravel`, so a same-island attack keeps the speed rule (§7.2);
- `urgentMinGap < minTravel`, so an urgent warning always comes before the attack lands;
- the generic gateway checks of `docs/architecture.md` §3.6: `selfWake.min ≥ 1`, `selfWake.min ≤ selfWake.max`, `safetyWake ≥ selfWake.min`, `roundTripsPerWake ≥ 1`, `toolCallsPerRoundTrip ≥ 1`, `ownWakesPerDay ≥ 1`, `socialWakesPerDay ≥ 1`, and `matchEnd ≥ 1`;
- at match creation, every travel time between two islands, the same island included, is ≥ `minTravel` for transports, triremes and spies.

Nothing else is cross-checked: in particular `time.matchEnd` may be shorter than `capitalImmunityEnd` or `dominationStart` (1-day test matches use `time.matchEnd=86400`). To disable domination for a full-length match, set `time.dominationStart=604801`: a timer after `matchEnd` never fires, whereas 604800 would open domination in the last second.

**Player count.** `players` is fixed at 6..12, as in 1.0.0, and `homeRadius` covers only those N. Phase 2's 4-agent match is planned as a mixed N = 6 match (4 LLM seats and 2 bots); a smaller N needs a new version with `homeRadius` entries for 4 and 5 (`docs/architecture.md` §14).

---

## 17. Design rationale

- **Base.** classic-1 was the most numerically coherent design and had the best counterplay: a public siege, relief battles, the wall breach, and spy counter-intel that scales with pop. Its faults were calibration, so the structure was kept and the calibration fixed.
- **Scarcity and contact** (balance and drama must-fixes):
  - Slots were cut to 5–6 free per player.
  - The equidistant shared frontier became ×1.5 and sits 1 h 30 from both neighbours.
  - Protection went from 24 h to 12 h, and the first settler is ready by ~6 h.
  - First blood is possible on day 1. The reference bot's land share runs out early on day 4 (73 h), so LLM agents should run out on days 4–5.
- **Naval rebalance.** Land units aboard no longer share naval losses. The navy is a gate: you either hold the sea or lose the whole wave. That removes classic-1's "half the navy kills 35% of the army" exploit, and trains (§8.11) make the gate crackable.
- **Square law** (from Lean Ring) instead of the ×1.5 power law. It is mental maths for LLMs, it rewards concentration (attack trains) against spread-out defenders, and with base defense plus walls the defender still has the edge locally.
- **Garrisons are not paper.** They fight behind the city's wall and base defense. Holding a siege needs hoplites, and the rules say so.
- **Re-homing instead of erasure.** Units of a lost city go to the owner's oldest city. Combined with morale and settler cost ×k, this is the anti-snowball brake classic-1 lacked.
- **Betrayal on impact, named blocs, a shared domination win and an individual time win.** These come from the drama review: they keep the fake/bluff window open, make alliance wars readable, and leave every alliance a late reason to defect.
- **Bounded kill points** (/10, capped at ¼ of city points, none between recently related players, no day multipliers). This closes the collusion-farming exploit of Ring & Crown's renown.
- **Olympus** (graft from Ring & Crown), with its bonus cut to +100, is a focal point in the centre that no single battle can turn into a match-deciding win.
- **Determinism scaffolding** comes from all three designs:
  - classic-1's named PRNG streams and canonical orders;
  - Ring & Crown's (time, class, seq) keys and lockstep shuffle;
  - Lean Ring's tail-cancel queues and cheat sheet.

  A committed sine table replaces runtime trig.

- **1.1.0.** The Greek setting gives agents an original, legible world without touching a number. Domination by conquest closes the peaceful path that 1.0.0's threshold left open (a 2-player bloc reached its 2N floor whenever seats founded little: 8 to 12 matches in 30 ended that way with the bots, the winning blocs holding 0 or 1 conquered city), while keeping the alliance-and-betrayal drama: conquests after a betrayal count, but cities a bloc's members conquered from one another do not, so a pair cannot trade cities and then ally. The validation of the domination keys turns silent misconfigurations into explained errors. The share of 350‰ and the absence of a conquest trophy come from calibration batches (§0.1, "Why these values").
- **Cut for the complexity budget:** rams, renown day multipliers, hideout percentages, refund tiers, unit-specific walking speeds, pact-breaks-at-launch and the drowning rule.

---

## 18. Tuning knobs

Change these between matches only. Every pacing number in §15 must be re-measured after any change.

| Symptom in phase-1 / phase-2 matches       | Knobs, in order of preference                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Too little fighting, too much building     | `time.protectionEnd` ↓; `map.kinds.frontier.richnessPm` ↑; free slots ↓ (`kinds.*.slots`, e.g. inner 0); `scoring.killPopPerPoint` ↓ or `killCapPm` ↑; `olympusBonus` ↑ |
| Land runs out too early or too late        | `units.settler.cost` and `settler.scaleCap`; `units.settler.time`; slots per kind                                                                                       |
| Turtles hold too well                      | `combat.wallPmPerLevel` ↓; `wallBreachOnLoss` 2; `economy.baseDefense` ↓; hoplite `defense` ↓                                                                           |
| Conquest too easy, leaders snowball        | `time.siegeDuration` ↑; `combat.moraleFloorPm` ↓ (stronger morale); `settler.cost` ↑; hoplite `defense` ↑                                                               |
| Sieges almost never hold                   | garrison hoplites are the answer, so check the bots first; then `siegeDuration` ↓ (fewer relief windows)                                                                |
| Raiding useless or dominant                | peltast `carry`; `economy.lootProtectPerLevel`                                                                                                                          |
| Navy irrelevant or a hard wall             | trireme `naval`, `cost`; transport `capacity`                                                                                                                           |
| Domination never or too often              | `victory.dominationPm` (350); `dominationMinConquests` (2); `dominationMinPerPlayer`; `time.dominationStart`; `diplomacy.allianceSize`                                  |
| Peace equilibrium among allies             | `diplomacy.allianceSize.divisor` ↑ (smaller blocs); `maxPacts` ↓; `pactDuration` ↓                                                                                      |
| Spying ignored or trivial                  | `spy.counterPerLandPop`, `counterPerWall`, `minGold`                                                                                                                    |
| Fake-attack spam, budget drain             | `gateway.attackLaunchesPerDay` ↓; `time.recallWindow` ↓ (0 disables recalls)                                                                                            |
| Matches too long or too short in real time | the clock driver's game-hours per real-hour (outside the rules); in the rules, `time.minTravel`, `time.sameIslandTravel` (kept ≥ `minTravel`) and the paces together    |
| Economy too fast or too slow overall       | `economy.production` (`c` term for the early game, `a` term for the late game); `buildings.*.time`                                                                      |

---

## 19. Phase-1 acceptance checks

The engine and `sim` test suites encode checks 1–4 as tests. Check 5 is a measurement that `sim batch --pacing` reports and no test asserts.

1. **Determinism.** Same seed plus same log gives the same state hash, in both clocks. Re-simulating a recorded match in CI reproduces every snapshot.
2. **Map** properties of §2.5, checked with fast-check over seeds for N = 6..12.
3. **Worked examples** of §8.12 and §9.8, encoded as exact engine tests, together with the §15.2 D values.
4. **Invariants:**
   - no stock above cap or below 0;
   - pop used equals the recomputed sum;
   - every unit is in exactly one place;
   - no event before "now";
   - every duration ≥ 1;
   - every id unique.
5. **Pacing measurement.** For each N in {6, 8, 12}, run the reference expander bot plus fighting bots (rusher, turtle, opportunist). Report per day:
   - cities, free slots left, army pop, score, battles, sieges started / held / broken.

   The criteria to re-tune against are:
   - free land gone by day 4–5;
   - at least one siege per player-pair border by day 5;
   - no bot type winning more than 60% of seeds.

   Bots alone may miss them. A missed criterion is recorded with its numbers and becomes a proposal for a later version; the numbers of a published version never change.

These rules are V1.1. Revise them, as a new version, once data shows which knobs matter.
