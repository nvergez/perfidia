# Candidate ruleset: Lean Ring: a minimal V1 rule set that forces interaction

> Phase-1 design candidate, kept for reference and as a future alternative ruleset. Not the active ruleset (see docs/rulesets/perfidia-1.md).

**Pitch.** About ten formulas cover the whole game, and an LLM can work each one out in its head ("1 h + 10 min per tile", "50·L wood + 50·L stone", "winner loses (loser/winner)²"). They run on a ring archipelago where every seat has the same neighborhood. Each seat has two neighbors and shares a double-yield border island with each of them. Free slots run out around day 3 to 5, a city's value stops at 100 points and its army stops at 1000 pop, so after the land grab the only way to grow is to conquer. Alliances pay off through shared vision, joint defense and the only shared victory (domination), while the points victory stays individual, which makes late betrayal tempting. Everything is integer and deterministic, with no randomness after map generation, and every number lives in one tunable config.

**Key trade-offs.**

- Ring map of identical copied sectors: every seat gets the exact same neighborhood (perfect fairness) and the map can be drawn as a ring, but the layout is predictable and each seat has only two neighbors. A random archipelago would have needed an approximate fairness search.
- Capitals can never be conquered: no seat is eliminated, so each model plays the full match and the cost of a match is predictable. The downside is less at stake at the very end, and possible stalemates where a player shelters in the capital and raids from there (config flag `capitalsConquerable`).
- One travel formula for every movement (1 h + 10 min per tile) and no unit speeds: an LLM can work it out in its head and the speed rule holds for every attack. The cost is that fast and slow units cannot be played against each other.
- Square-law losses, a wall worth up to +100% and no combined attacks: concentrated force and allied attack waves are rewarded, and the defender has the edge. The late game may be too defensive; the knobs are `wallPercent` and `lossExponent`.
- Alliances and pacts are never broken automatically, and pacts have no mechanical effect: fewer rules and more room for deception about who betrayed whom. In return, the public record holds only voluntary leaves, not the fact that an ally attacked.
- The points victory is individual while domination is shared by the alliance: alliances clearly pay off (shared vision, domination bloc), but this pushes allies to betray each other late in the match. That is intended for the show, but agents may not bother forming alliances unless domination looks reachable.
- Spies are always detected and named to the target: no counter-espionage numbers are needed and every spy mission becomes a diplomatic incident, but this may discourage spying.
- Everything is paid at enqueue, cancellation removes the rest of the queue, and a whole recruit order completes at once: one event per order and fixed completion times, at the price of some flexibility for agents.
- One cost formula for all buildings (50·L wood + 50·L stone, 15·L min): very easy mental arithmetic but less economic texture; costs can differ per building in the config with no code change.
- The pacing bands come from a rough greedy simulation with no fighting, not from LLM play. The phase-1 sim bots must measure them and the config knobs must be tuned before LLM matches.

---

# Perfidia V1 rules: "Lean Ring"

The goal is the smallest rule set that still forces interaction, so depth has to come from the agents. Every number below is a V1 default stored in `RulesConfig` (§16).
**Not in V1:** neutral or barbarian cities, research, morale, luck, unit upkeep, siege or demolition (building levels never go down), combined attacks, market, heroes.

## 0. Conventions

- `t` is an integer count of game-seconds since match start, with 0 ≤ t ≤ 604 800. 1 h = 3 600 s. The game day index is ⌊t / 86 400⌋.
- All state is integers. `⌊a/b⌋` is floor division (operands are never negative). Results are floored unless a rule says otherwise.
- The PRNG is used **only** for map generation and for ordering lockstep turns in the same second (§12). Combat has no randomness.
- Ids are never reused: players `p1…pn`, islands `i1…`, cities `c1…`, alliances `a1…`, movements `m1…`, reports `r1…`, proposals `o1…`, messages `msg1…`.
- Resources: `wood stone gold`. Buildings: `hall sawmill quarry mine warehouse barracks harbor wall`. Units: `guard raider settler transport warship`. The names are neutral so the game can be reskinned.

### Cheat sheet (the `rules` tool returns this verbatim, plus the config)

```
distance      = |dx| around the ring + |dy|            (same island: 0)
travel        = 1 h + 10 min x distance                (every movement, both ways)
build level L = 50*L wood + 50*L stone, 15*L minutes   (all buildings, max level 10)
production    = 100 x level per hour, x2 on a rich island
storage       = 1000 x (warehouse level + 1) of each resource
population    = 100 x hall level
recruit time  = unit base time / barracks or harbor level
settler       = 1000*N of each resource, N = your cities + your settlers
battle        = attack vs defense x (1 + wall/10); a tie goes to the defender
losses        = loser loses everything; winner loses (loser power / winner power)^2 of each unit type
loot          = survivors' carry capacity, at most half of each resource
points        = 20 per city + 1 per building level (a city is worth 25..100)
win           = an alliance holding >50% of all cities for 24 h, else most points at day 7
```

## 1. Map (from `seed`: uint32, `n` ∈ [6, 12])

### 1.1 PRNG

The PRNG is mulberry32 and uses integer operations only:

```
next(): a = (a + 0x6D2B79F5) | 0
        t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return (t ^ (t >>> 14)) >>> 0            // uint32
rand(k) = floor(next() * k / 2^32)                // 1 <= k <= 2^20, exact in float64
```

The state starts at `a = seed`. The calls are consumed in exactly the order listed in §1.3.

### 1.2 Ring and size

- The world is a ring of `n` identical **sectors**, each 10 tiles wide. The ring has width `W = 10n` and height `H = 10`. Coordinates are `x ∈ [0, W)`, which wraps around, and `y ∈ [0, 10)`, which does not wrap.
- Islands per sector: `P = min(5, ⌊50 / n⌋)`. The island count is `I = n·P`.

| n   | P   | islands | slots | free slots | free per seat | alliance cap |
| --- | --- | ------- | ----- | ---------- | ------------- | ------------ |
| 6   | 5   | 30      | 42    | 36         | 6             | 2            |
| 7   | 5   | 35      | 49    | 42         | 6             | 2            |
| 8   | 5   | 40      | 56    | 48         | 6             | 2            |
| 9   | 5   | 45      | 63    | 54         | 6             | 3            |
| 10  | 5   | 50      | 70    | 60         | 6             | 3            |
| 11  | 4   | 44      | 66    | 55         | 5             | 3            |
| 12  | 4   | 48      | 72    | 60         | 5             | 4            |

### 1.3 Sector template

The template is generated once and copied into every sector. Coordinates are relative to the sector origin `(10·s, 0)`.

1. **Home island H** at `(5, yH)`, with `yH = 3 + rand(4)`. It has 2 slots, and slot 0 holds the capital.
2. **Rich border island B** at `(0, yB)`, with `yB = 2 + rand(6)`. It has 2 slots and is `rich` (production ×2). It sits exactly halfway between two neighboring homes.
3. **Plain islands Q1…Q(P−2)** have 1 slot each. Each one gets up to 200 tries of `x = 1 + rand(9)`, `y = rand(10)`. A try is accepted when `tdist ≥ 3` to every island already placed in the template, where `tdist(a,b) = min over k∈{−1,0,1} of |ax − bx − 10k| + |ay − by|`. That formula also checks the copies in the neighboring sectors. If all 200 tries fail, scan `y = 0..9`, then `x = 1..9`, and take the first valid cell. An exhaustive check shows at least 43 valid cells are always left, so the scan can never fail.
4. **Copy the template:** sector `s` gets each template island at `(x + 10s, y)`. Island ids are assigned in the order `s` ascending, then B, H, Q1, Q2, Q3.
5. **Seats:** Fisher–Yates shuffle `[p1…pn]` (for `i = n−1` down to `1`: `j = rand(i+1)`, swap). Sector `s` goes to `perm[s]`. Capitals get ids `c1…cn` in player-id order.

### 1.4 Distance and travel time

- `dx = |x1 − x2|`, then `dx = min(dx, W − dx)`. `d = dx + |y1 − y2|`. Two cities on the same island have `d = 0`.
- **Travel time** `T = 3600 + 600·d` seconds. The same formula covers every movement kind and every unit, and a return trip takes the same `T`. Units have no speed stat.
- Speed rule: any attack takes at least 1 h (same island). Two different islands are always at least 3 tiles apart, so a crossing takes at least 1 h 30.

### 1.5 Fairness

The map has exact translation symmetry, so every seat sees the same neighborhood:

| From your capital to…                                          | d    | T                                     |
| -------------------------------------------------------------- | ---- | ------------------------------------- |
| Free slot on your home island                                  | 0    | 1 h 00                                |
| Your plain islands                                             | 3–10 | 1 h 30 – 2 h 40                       |
| Left and right rich islands (same distance for both neighbors) | 5–9  | 1 h 50 – 2 h 30                       |
| Neighbor capital                                               | 10   | 2 h 40                                |
| Capital k seats away (k ≤ n/2)                                 | 10k  | 1 h + k·1 h 40 (n=12, opposite: 11 h) |

## 2. Starting state (per player)

| Item      | Value                                                                                      |
| --------- | ------------------------------------------------------------------------------------------ |
| Cities    | 1 **capital**, in slot 0 of its home island. It can never be conquered (§7.6).             |
| Buildings | hall 1, sawmill 1, quarry 1, mine 1, warehouse 1, barracks 0, harbor 0, wall 0 (25 points) |
| Resources | 1 000 wood, 1 000 stone, 1 000 gold (storage 2 000)                                        |
| Units     | 10 guards (pop 10 / 100)                                                                   |
| Diplomacy | No alliance, no pacts, empty notebook                                                      |

A **founded city** (§6.6) starts with the same buildings, 0 resources, and its escort as its only units. It is not a capital.

## 3. Economy

1. **Production** per game hour for resource r: `rate_r = 100 × level(producer_r) × (2 if the island is rich else 1)`. The producers are sawmill for wood, quarry for stone and mine for gold.
2. **Fixed point:** stock is kept in _ticks_, and 1 resource = 3 600 ticks. Each game-second adds exactly `rate_r` ticks, so accrual is exact. The visible stock is `⌊ticks / 3600⌋`. Spending X subtracts `X·3600`, and an action is affordable when the visible stock ≥ X.
3. **Lazy accrual:** `ticks(t) = min(cap·3600, ticks(t0) + rate·(t − t0))`. Before anything changes stock, rate or cap (spending, a deposit, loot, a build completing, conquest), settle up to that second with the _old_ rate and cap. How often a city is settled never changes the result, so views may settle freely.
4. **Storage:** `cap = 1000 × (warehouse + 1)` per resource. Stock never exceeds the cap. Production stops at the cap. Any part of an arriving shipment or loot that does not fit is lost, and the amount lost is reported.
5. **Population:** `popCap = 100 × hall`. `popUsed` is the sum of `pop` over every unit homed in the city, wherever it is: at home, travelling, stationed elsewhere, or in a recruit queue. Buildings use no population. A recruit order is allowed only if `popUsed + order pop ≤ popCap`. Conquest or a founding escort can push `popUsed` above `popCap`. That is allowed, but it blocks recruiting until `popUsed` falls back under the cap.
6. **Gateway hint:** "available in" is `⌈(X·3600 − ticks) / rate⌉` seconds (or "never" if X > cap or rate = 0).

## 4. Buildings

Every building follows the same rule. **Level L costs `50·L wood + 50·L stone` (no gold) and takes `900·L` s. Max level 10. No prerequisites.**

| id                            | Effect at level L                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `hall`                        | popCap = 100·L                                                                                     |
| `sawmill` / `quarry` / `mine` | +100·L wood / stone / gold per hour (×2 on a rich island)                                          |
| `warehouse`                   | storage = 1 000·(L+1) of each resource                                                             |
| `barracks`                    | trains guard, raider and settler; per-unit time = max(1, ⌊base / L⌋). L = 0 means it cannot train. |
| `harbor`                      | trains transport and warship; same time rule                                                       |
| `wall`                        | land defense ×(100 + 10·L)/100 (+10 % per level, +100 % at level 10)                               |

| L          | cost (wood = stone) | time    | production/h | storage | pop   |
| ---------- | ------------------- | ------- | ------------ | ------- | ----- |
| 1          | 50                  | 15 min  | 100          | 2 000   | 100   |
| 2          | 100                 | 30 min  | 200          | 3 000   | 200   |
| 5          | 250                 | 1 h 15  | 500          | 6 000   | 500   |
| 10         | 500                 | 2 h 30  | 1 000        | 11 000  | 1 000 |
| 1→10 total | 2 750               | 13 h 45 |              |         |       |

**Build queue:** each city has one queue. Items run one after another, and the queue holds at most 5 items, counting the one in progress. Each item is +1 level of one building. The target level is current level + queued items for that building + 1, and it must be ≤ 10. `build(city, building, levels = 1..5)` adds consecutive items all-or-nothing. **The full cost is paid when the item is queued.** The start time is `max(now, end of the last item)` and the end is `start + 900·L`. Both are fixed when the item is queued. When an item completes, the level goes up at `end` (event class 0).

**Cancel:** `cancel_queue(city, queue ∈ {build, barracks, harbor}, index)`, where index 0 is the item in progress. It removes that item **and every later item in the same queue** (a tail cancel), so the remaining end times never change. Items not yet started are refunded 100 %. The item in progress is refunded ⌊50 %⌋ of each resource. Cancelled recruit orders release their reserved population, and a cancelled settler lowers N.

## 5. Units

| id          | trained at | domain | att | def | naval | pop | wood   | stone  | gold   | base time | carry | capacity                                 |
| ----------- | ---------- | ------ | --- | --- | ----- | --- | ------ | ------ | ------ | --------- | ----- | ---------------------------------------- |
| `guard`     | barracks   | land   | 5   | 20  | –     | 1   | 0      | 50     | 50     | 300 s     | 10    | –                                        |
| `raider`    | barracks   | land   | 20  | 5   | –     | 1   | 50     | 0      | 50     | 300 s     | 20    | –                                        |
| `settler`   | barracks   | land   | 0   | 0   | –     | 20  | 1000·N | 1000·N | 1000·N | 7 200 s   | 0     | –                                        |
| `transport` | harbor     | sea    | –   | –   | 0     | 2   | 200    | 0      | 100    | 1 800 s   | –     | 20 pop of land units, or 1 000 resources |
| `warship`   | harbor     | sea    | –   | –   | 50    | 5   | 300    | 0      | 300    | 2 700 s   | –     | –                                        |

- **Cost identity:** wood and stone pay for buildings. Gold pays for every unit. Stone also pays for defenders (guards), and wood also pays for attackers (raiders) and ships.
- **Recruit queues:** each city has a barracks queue and a harbor queue. Each runs orders one at a time and holds at most 5 orders. An order is `(unit, count)` with 1 ≤ count ≤ 1 000. A settler order must have count 1. Full cost and population are reserved when the order is queued. Order duration = `count × max(1, ⌊base / L⌋)`, where L is the building level when the order was queued. **All units of an order appear together when it ends.** Start = max(now, end of the last order).
- **Settler N** = cities owned + settlers owned (queued, at home or travelling), counted when the order is queued. N must satisfy 1000·N ≤ cap, which works out to warehouse ≥ N − 1.
- **Roles:** guards and raiders fight on land. Settlers found or conquer cities and never fight. Transports carry troops or resources and never fight. Warships fight only in the naval phase.

## 6. Movements

### 6.1 Kinds

| Kind     | Tool             | May contain                             | Target sees it before arrival?                   | Recall     |
| -------- | ---------------- | --------------------------------------- | ------------------------------------------------ | ---------- |
| attack   | `attack`         | any units                               | yes: origin, owner, arrival time (not the units) | never      |
| support  | `support`        | guard, raider, transport, warship       | yes, in full                                     | yes (§6.8) |
| shipment | `send_resources` | resources plus auto-assigned transports | yes, in full                                     | never      |
| spy      | `spy`            | nothing (costs 200 gold)                | no                                               | never      |
| found    | `found_city`     | ≥ 1 settler plus any escort             | no                                               | never      |
| return   | (automatic)      | survivors, loot, empty ships            | –                                                | never      |

### 6.2 Composition rules

- A movement can only use units that are homed in the origin city **and** currently at home there. Support stationed in the city by others is never included, and neither are units in transit or in a queue.
- **Crossing water** means the origin and target islands differ. If the movement contains land units, it needs `20 × transports ≥ Σ pop of its land units`. A shipment automatically takes `⌈(wood+stone+gold) / 1000⌉` of the transports at home and fails if there are not enough. Spies need no ships.
- Movements on the same island need no ships. Ships can come along but never fight there.
- An attack must contain at least one land unit, or at least one warship when it crosses water.
- A group travels, stays and returns as one unit. Transports stay docked with the troops they carried.

### 6.3 On arrival

- **attack:** §7.
- **support:** the units become a _stationed group_ in the target city, keyed by (owner, origin city). A later support from the same origin merges into it. The group defends the city in every battle there and still counts against its origin's population. The host cannot send it away.
- **shipment:** the resources are added to the target (overflow is lost), and the transports start a return trip of length T.
- **spy:** §8.
- **found:** §6.6.
- **return:** the units rejoin their home city and any carried resources are added (overflow is lost).

### 6.4 Owner-change rule

- If the target city's owner at arrival is not its owner at launch, the movement has no effect and returns. A shipment's resources come back with it.
- If a city changes owner, every unit homed there is removed wherever it is, and every movement that started from that city is deleted along with its cargo or loot.

### 6.5 Recall (`recall_troops`)

- **Support still in transit:** it turns around now and arrives home at `now + (now − departedAt)`.
- **A stationed group:** only the whole group can be recalled. It arrives home at `now + T`.
- Attacks, spies, shipments, founding movements and returns cannot be recalled. Launching an attack is a commitment, which also blocks wake-up spam from fake attacks.

### 6.6 Founding

`found_city(from, island, units)`: the units must include ≥ 1 settler, and the island must have a free slot when the movement launches. On arrival, if a slot is still free, a city is created in the **lowest free slot**. One settler is consumed, and every other unit (escort, extra settlers, ships) is re-homed to the new city. If no slot is free, the whole movement returns. When several founders arrive in the same second, they are applied in event order (§12).

## 7. Combat (resolved when an attack arrives at city C)

The defending side is made up of the city owner's units at home plus every stationed group in C.

### 7.1 Loss function

For a loser power `L` and winner power `W` (with `L ≤ W`): `r = ⌊1000·L / W⌋`, `q = ⌊r·r / 1000⌋` (in per mille). If `W = 0`, then `q = 0`. Each winning group (owner, origin, unit type) loses `⌊(count·q + 500) / 1000⌋` units, which rounds to nearest with halves rounded up. **The loser loses everything that fought in that phase.**

### 7.2 Naval phase

The naval phase happens only if the attack crosses water **and** the defenders have at least one warship (the owner's own plus any stationed).
`Na = 50 × attacking warships`, `Nd = 50 × defending warships`.

- `Na > Nd`: every defending warship is sunk, and the attacking warships lose `q(Nd, Na)`. Continue to the land phase.
- `Na ≤ Nd`: **the whole attacking movement is destroyed**, including the land units aboard. The defending warships lose `q(Na, Nd)`. Stop.

### 7.3 Land phase

The land phase happens if the attack contains land units.
`A = Σ att` of the attacking land units. `Dbase = Σ def` of every defending land unit. `D = ⌊Dbase × (100 + 10·wall) / 100⌋`.

- **The attacker wins** if `D = 0` or `A > D`. Every defending land unit dies. The attacking land units, except settlers, lose `q(D, A)`.
- **Otherwise the defender wins.** A tie goes to the defender, and on an exact tie q = 1000, so both sides are wiped out. Every attacking land unit dies, settlers included. Each defending group loses `q(A, D)`.
- Ships never die in the land phase.

### 7.4 Loot

Loot is taken when the attacker wins the land phase and the city is not conquered.
`C = Σ carry` of the surviving attacking land units. `lootable_r = ⌊stock_r / 2⌋`.
To split the loot, sort the resources by `lootable` ascending, breaking ties in the order wood, stone, gold. Then for k = 0, 1, 2: `share = ⌊remaining / (3−k)⌋`, `take = min(lootable, share)`, and `remaining −= take`.
The loot leaves C at once and is delivered when the survivors get home, `T` later.

### 7.5 After the battle

The survivors of a non-conquering attack return home. That includes the ships, even if every land unit died.

### 7.6 Conquest

A conquest happens when the attacker wins the land phase, the attack contains ≥ 1 settler (settlers never die in a win), and C is **not a capital**. Then:

- The owner becomes the attacker and one settler is consumed.
- Every surviving unit of the movement, ships and extra settlers included, stays and is re-homed to C.
- The stock stays in C and no loot is taken. Buildings keep their levels. The build and recruit queues are cleared with no refund.
- §6.4 applies: units homed in C anywhere are removed, and movements from C are deleted. Other players' ships still stationed in C sail home.
- A public event announces it.

**Capitals can never be conquered.** A winning attack with settlers on a capital takes loot as usual, and the settlers go home. This means no one is ever eliminated.

### 7.7 Battle report

The report contains:

- the time, the attacker (player and city) and the defender (player and city);
- every side's units by group;
- Na and Nd, the naval winner and the naval losses;
- A, Dbase, wall, D, q, the land winner and the losses per group;
- the loot and any overflow lost, whether a conquest happened, and when the survivors arrive home.

The report goes to the attacker, the city owner, every owner of a stationed group, and their alliance members through shared vision. **If the attacker lost** (either phase), the attacker's copy shows the defender's totals (Nd, or Dbase, wall and D) but not their units.

### 7.8 Worked example

- **Setup:** 300 raiders, 1 settler, 16 transports (capacity 320 ≥ 300 + 20) and 4 warships attack c14 across water. c14 is not a capital and has wall 3. Its own defense is 100 guards, 20 raiders and 2 warships, and p7 has 30 guards stationed there. The stock is 3 000 wood, 1 200 stone and 5 000 gold.
- **Naval phase:** Na 200 > Nd 100. q(100, 200) gives r = 500 and q = 250, so the attacker loses ⌊(4·250 + 500)/1000⌋ = 1 warship. Both defending warships are sunk.
- **Land phase:** A = 6 000. Dbase = 130·20 + 20·5 = 2 700. D = ⌊2 700·130/100⌋ = 3 510. A > D, so the attacker wins. r = 585 and q = 342, so the attacker loses ⌊(300·342 + 500)/1000⌋ = 103 raiders and 197 survive. All 150 defending land units die.
- **Conquest:** c14 changes owner. The 197 raiders, 16 transports and 3 warships stay as its garrison.
- **Without the settler:** carry 3 940 against lootable 1 500 wood, 600 stone and 2 500 gold. Taken in ascending order: stone 600, then wood 1 500, then gold 1 840.

## 8. Espionage

- `spy(from, to)` costs **200 gold**, paid at launch. It uses no units or ships and travels for `T`. It is invisible in transit and cannot be recalled.
- **On arrival** the spier gets a snapshot of that second: building levels, stock, units at home, stationed groups (owner and units), queues with their end times, and how many units homed there are away (but not where).
- **Counter-espionage:** spies cannot be blocked, but the target is **always told** "c14 spied by p3 (from c7) at t". Information costs a diplomatic incident.
- If the target changed owner while the spy was travelling, the report says so and contains no data. Spies are not refunded.

## 9. Diplomacy (nothing is binding)

- **Messages:** `send_message(to: [player ids] | "all", text ≤ 1 000 chars)` is delivered instantly. A message to a list of players is private. A message to `"all"` is public and visible to every player. The cap is **20 calls per player per game day**, and a call counts as 1 whatever the number of recipients. Messages reach the model as typed `{from, text}` fields.
- **Proposals:** `propose_alliance(to, kind: "alliance" | "pact", name?)`.
  - A player can have at most 3 pending outgoing proposals, and only one per (from, to, kind).
  - Proposals expire after **43 200 s**.
  - `answer_proposal(id, accept)` checks validity again at acceptance.
- **Alliance:** membership is public. The max size is `max(2, ⌊n/3⌋)`, and there is no leader.
  - When a proposal is accepted:
    - if neither player is in an alliance, a new alliance is formed (name ≤ 24 chars, else `a{k}`);
    - if exactly one is, the other joins that alliance (the proposal fails if it is full);
    - if both are, the proposal is invalid.
  - Any member can invite.
  - `leave_alliance()` takes effect at once and is public. An alliance left with one member dissolves.
  - **Effects:** shared vision (§10) and the domination bloc (§11). Nothing else. Allies can attack, spy on or conquer each other, and nothing is broken automatically.
- **Pact:** a public two-player non-aggression label. It has **no mechanical effect**, and attacking a pact partner is allowed. It is ended publicly with `leave_alliance({ pactWith })`.
- **Tribute:** `send_resources` to any city (§6). It is visible to the sender and the recipient (and their allies).
- **Public feed:** alliances formed, joined, left or dissolved; pacts signed or ended; cities founded or conquered; domination clock started or stopped; public messages. Battles are **not** announced publicly, so third parties hear about them through messages, which can lie.

## 10. Visibility (fog of war)

| Information                                                                                                                                       | Who sees it                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Islands (coords, slots, rich), cities (id, owner, island, slot, capital flag, points), players (points, city count, alliance, pacts), public feed | everyone                                                             |
| Full city state (buildings, stock, queues, units at home, units away, stationed groups)                                                           | owner + owner's allies                                               |
| Groups stationed in your city (owner, units)                                                                                                      | city owner (+ allies)                                                |
| Own movements in full                                                                                                                             | owner + allies                                                       |
| Incoming **attack**: origin city, owner, target, arrival time (no units)                                                                          | target owner, their allies, owners of groups stationed in the target |
| Incoming support or shipment, in full                                                                                                             | target owner (+ allies)                                              |
| Spies in transit, founding movements                                                                                                              | sender only (+ allies)                                               |
| Battle reports                                                                                                                                    | participants (+ their allies), with the §7.7 restriction             |
| Spy reports                                                                                                                                       | spier (+ allies). The target gets only the notice.                   |
| Private messages / notes                                                                                                                          | sender and recipients / author only                                  |
| Everything                                                                                                                                        | spectators                                                           |

Shared vision is **live, not copied**: leaving an alliance cuts off access at once. Whatever already reached your briefings stays in your archive.

## 11. Points, leaderboard, victory

- **City points** = 20 + Σ building levels (25 at start, 100 max). **Player points** = Σ city points. Points are public and live. `leaderboard` shows rank, points, cities, alliance and any running domination clock.
- **Domination:** a _bloc_ is an alliance (its current members) or a player outside any alliance. A bloc dominates when `2 × blocCities > totalCities`, counting every city in the world.
  - When a bloc starts dominating, a public **domination clock** starts and ends at `t + 86 400`.
  - The clock stops (publicly) if the condition fails or the bloc's membership changes.
  - If the clock reaches its end, the match ends at once and the bloc wins.
- **Time limit:** the match ends at t = 604 800, after every other event of that second.
- **Ranking:** after a domination win, bloc members come first (ordered by points) and everyone else follows by points. Otherwise the order is points desc → cities desc → army pop (Σ pop of living units owned) desc → shared rank. The points victory is **individual**. Capitals are immune, so no one is eliminated.

## 12. Determinism and ordering

- **Event key** `(time, class, seq)`. The classes are:
  - 0: build and recruit completions
  - 1: returns home
  - 2: support and shipment arrivals
  - 3: spy arrivals
  - 4: attack arrivals
  - 5: founding arrivals
  - 6: timers (proposal expiry, domination clock, match end)

  `seq` is a global counter assigned when the event is scheduled. So support that lands in the same second as an attack defends against it, and several attacks in the same second are resolved one after another in launch order.

- **Actions** stamped `t` are applied after every event with time ≤ t. They are checked against the current state and applied all-or-nothing. The order of actions within a second is the order in the log. The lockstep driver puts the seats acting in that second in a shuffle seeded with `mulberry32(seed ^ t)`. The real-time driver uses arrival order. Replays apply the log.
- **Bounds:** the largest tick value is 11 000·3 600 < 2³¹, and combat products stay below 10¹⁰, which is safe in float64 integers.
- **Events emitted** for the gateway: `attack_incoming`, `battle`, `city_conquered`, `city_founded`, `queue_idle`, `spied`, `shipment_arrived`, `support_arrived`, `message`, `proposal`, `diplomacy_changed`, `domination_clock`, `match_end`.

## 13. Gateway caps and wake-ups (config, not engine)

- **Urgent wake-ups** (outside the budget): a new attack heading for your city, or one of your cities conquered.
- **Non-urgent wake-ups:** a message or proposal received, a queue becoming empty (not each item finishing), an attack heading for a city where you have troops stationed, or a self-scheduled time.
- **Grouping and budgets:**
  - Events less than 600 s apart are grouped into one wake-up.
  - Non-urgent wake-ups are capped at **12 per game day**.
  - A self-scheduled wake-up must be between 1 800 s and 43 200 s away.
  - There is a safety wake-up 43 200 s after the last one.
- **Per wake-up:** at most 8 model round trips, each with at most 10 tool calls.
- **Notebook:** at most 4 000 chars. `write_note(text, mode: append | replace)`.
- **Errors** are data: `{ok: false, code, message, hint}`, with numbers, for example "need 450 wood, have 320 (+400/h): affordable in 18 game min".

## 14. Pacing sanity

### 14.1 A balanced opening (n = 8; times in game hours)

| Time      | What happens                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00      | Queue harbor 1 (done 0:15) then barracks 1 (done 0:30). Or barracks only, for an expansion opening.                                                                                                                       |
| 0:20–0:35 | First troops (5 min each at barracks 1).                                                                                                                                                                                  |
| 0:30      | Expansion opening: settler (1 000/1 000/1 000) ready at 2:30, then 1 h to walk to the free slot on the home island. **City 2 at about 3:30.**                                                                             |
| ~4:30     | **Earliest cross-island attack.** About 15 raiders and 1 transport, ready by 1:45, land on a neighbor capital 2 h 40 later. That is weak: it loses 7 of 15 against 10 guards for about 160 loot, so rushing does not pay. |
| 0–12 h    | Producers reach level 3–4 in the capital, plus barracks 2 and harbor 1; 50–120 troops.                                                                                                                                    |
| 12–24 h   | Second settler (2 000 each, which exactly fills warehouse 1) plus a transport, sent to a **rich border island** 1 h 50 – 2 h 30 away. The neighbor is racing for the same island: **first contact**.                      |
| Day 2     | 3–4 cities, 300–500 pop of troops. First raids for loot, and the first "claim-jumps" on new, unguarded cities (a settler walking into an empty city takes it).                                                            |
| Day 3–5   | 5–7 cities and the free slots are gone. Capital producers at level 8–10. Armies of 1 500–2 500 pop. **From here conquest is the only way to grow.**                                                                       |
| Day 5–7   | Developed cities hit 100 points and 1 000 pop. Armies of 4 000–6 000 pop before losses. Multi-wave attacks, coalitions against any domination clock, and late betrayals for individual points.                            |

These bands come from a rough greedy simulation with no fighting: it reaches 3 cities and about 500 troops on day 2, 5 cities and about 2 200 on day 4, and 7 cities and about 5 600 on day 7. A pure 1-city turtle maxes out at 100 points on day 4–5. **The phase-1 bots should check these bands in `sim`.**

### 14.2 Why contact and conflict are guaranteed within 7 days

1. Each seat shares a ×2 rich island (2 slots) with each neighbor, at the same distance from both. Both neighbors want it on day 1. Two cities on the same island attack each other by land in 1 h, with no naval defense.
2. There are about 6 free slots per seat, and N-scaled settlers take roughly 0.5–1 day each, so slots run out on days 3–5.
3. A city stops at 100 points and 1 000 pop, and a turtle's capital maxes out by day 4–5. Score can only grow through more cities, and once the slots are gone the only way to get cities is conquest.
4. Once the pop cap is reached, extra gold has nowhere to go except settlers and replacing losses. An idle army is wasted spending.

### 14.3 Anti-turtle

- Production has diminishing returns: the payback of level L is about L hours, and levels stop at 10.
- Points per city are capped, so one fortress tops out at 100 points against 500+ for an expander.
- Stock is always half lootable, and the warehouse cannot hide resources.
- Rich islands sit on the borders.
- A single city's army (at most about 900 raiders, 18 000 attack) cannot break a maxed fortress alone (500 guards at wall 10 = 20 000). It needs **coordinated waves or allies**. That makes alliances useful without making turtling a winning strategy.

### 14.4 Anti-snowball

- A settler costs 1 000·N.
- Capitals are immune, so there are no eliminations and no seat drops out of the match.
- Loot is at most 50 % of each resource per battle.
- A city's value is capped.
- Armies grow only with cities (pop cap).
- Losses follow a square law, the wall gives +100 %, and attacks cannot be combined, so cracking a developed city costs about two armies.
- Domination needs a 24 h hold that everyone can see, and alliance size is capped.

## 15. Every tool matters

| Tool                                                                               | Rule hook                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `view_city` / `view_island` / `view_map` / `view_player` / `leaderboard` / `rules` | §10, §1, §11, cheat sheet                                          |
| `build` / `recruit` / `cancel_queue`                                               | §4, §5, tail-cancel refunds                                        |
| `send_resources`                                                                   | Pooling for settlers (N-scaled costs), tribute, paying allies (§6) |
| `attack` / `support` / `spy` / `recall_troops` / `found_city`                      | §6–§8                                                              |
| `send_message` / `propose_alliance` / `answer_proposal` / `leave_alliance`         | §9 (leave also ends pacts)                                         |
| `write_note` / `read_notes`                                                        | Notebook limited to 4 000 chars (§13)                              |
| `end_turn(wakeAt?)`                                                                | Self-scheduled wake-up, 1 800–43 200 s (§13)                       |

## 16. Rules config sketch (rules are data; the match stores a hash of them)

```ts
type Res = { wood: number; stone: number; gold: number };
type BuildingId =
  | "hall"
  | "sawmill"
  | "quarry"
  | "mine"
  | "warehouse"
  | "barracks"
  | "harbor"
  | "wall";
type UnitId = "guard" | "raider" | "settler" | "transport" | "warship";

interface BuildingRule {
  maxLevel: number; // 10
  costPerLevel: Res; // level L costs costPerLevel × L   ({50,50,0})
  secondsPerLevel: number; // level L takes secondsPerLevel × L (900)
  effect:
    | { kind: "production"; resource: keyof Res; perLevelPerHour: number } // 100
    | { kind: "storage"; base: number; perLevel: number } // 1000, 1000
    | { kind: "population"; perLevel: number } // 100
    | { kind: "recruit"; units: UnitId[] } // time = max(1, ⌊base/L⌋)
    | { kind: "wall"; defensePercentPerLevel: number }; // 10
}
interface UnitRule {
  domain: "land" | "sea";
  trainedAt: "barracks" | "harbor";
  attack: number;
  defense: number;
  naval: number;
  pop: number;
  cost: Res;
  costTimesN: boolean; // true only for settler
  baseSeconds: number;
  maxPerOrder: number;
  carry: number;
  troopCapacity: number;
  cargoCapacity: number;
}
interface RulesConfig {
  rulesId: "lean-ring/1";
  time: { matchSeconds: 604800; daySeconds: 86400 };
  players: { min: 6; max: 12 };
  map: {
    sectorWidth: 10;
    height: 10;
    islandsPerSector: { max: 5; totalCap: 50 }; // P = min(max, ⌊totalCap/n⌋)
    home: { x: 5; yMin: 3; ySpan: 4; slots: 2 };
    rich: { x: 0; yMin: 2; ySpan: 6; slots: 2; productionMultiplier: 2 };
    plain: { xMin: 1; xSpan: 9; yMin: 0; ySpan: 10; slots: 1 };
    minGap: 3;
    placementTries: 200;
  };
  travel: { baseSeconds: 3600; secondsPerTile: 600 };
  economy: { ticksPerResource: 3600 };
  start: {
    buildings: Record<BuildingId, number>;
    resources: Res;
    units: Partial<Record<UnitId, number>>;
  };
  newCity: { buildings: Record<BuildingId, number>; resources: Res };
  buildings: Record<BuildingId, BuildingRule>;
  units: Record<UnitId, UnitRule>;
  queues: { buildMax: 5; recruitMax: 5; maxLevelsPerBuildCall: 5; startedRefundPercent: 50 };
  combat: { lossExponent: 1 | 2; lootPercent: 50; capitalsConquerable: false }; // V1: 2
  spy: { goldCost: 200 };
  diplomacy: {
    allianceSize: { min: 2; divisor: 3 };
    proposalTtlSeconds: 43200;
    maxPendingProposals: 3;
    messagesPerDay: 20;
    messageMaxChars: 1000;
    allianceNameMaxChars: 24;
  };
  points: { perCity: 20; perBuildingLevel: 1 };
  victory: { dominationHoldSeconds: 86400 }; // strict majority of all cities
  gateway: {
    notebookMaxChars: 4000;
    safetyWakeSeconds: 43200;
    selfWake: { min: 1800; max: 43200 };
    nonUrgentWakesPerDay: 12;
    groupWindowSeconds: 600;
    roundTripsPerWake: 8;
    toolCallsPerRoundTrip: 10;
  };
}
```

**Validation:** all numbers are non-negative integers, and `maxLevel ≥ 1`. The `costTimesN` flag must be set on exactly one unit. `troopCapacity > 0` implies `domain = "sea"`.

## 17. Tuning knobs, risks and alternatives considered

- **Pacing is unverified with LLMs.** These knobs set the pace: `perLevelPerHour`, `secondsPerLevel`, the settler cost, slots per island, and `islandsPerSector`. The phase-1 `sim` should measure the day-2, 4 and 7 bands.
- **The ring map** is perfectly fair but predictable, with 2 neighbors per seat. The alternative was a random archipelago with a seeded fairness search. It was rejected for V1 because its fairness is only approximate and its algorithm is more complex.
- **Capital immunity** keeps every seat in the match and keeps costs and comparisons clean. The risk is stalemates where a player shelters in the capital and raids from it. The knob is `capitalsConquerable`, which could also be set to open after day N.
- **Square-law losses, the wall and no combined attacks** could make the late game too defensive. The knobs are `wallPercent`, `lossExponent` (1 = linear), or adding joint attacks in V2.
- **Always-detected spying** may discourage spying. The alternative is detection only when the wall is above some level.
- **Irrevocable attacks:** an agent's mistakes stick, but this prevents wake-up spam from fake attacks.
- **Orders that complete all at once** are simpler than unit-by-unit delivery (one event per order). Agents can split orders if they want units sooner.
- **Uniform building costs** leave less texture, but costs can be set per building in the config with no code change.
