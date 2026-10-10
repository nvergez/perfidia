# Candidate ruleset: Ring & Crown (Perfidia rules v1.0)

> Phase-1 design candidate, kept for reference and as a future alternative ruleset. Not the active ruleset (see docs/rulesets/perfidia-1.md).

**Pitch.** Each player starts on a ring of home islands. Between every pair of neighbours sits a contested 2-site frontier island, 1.5 h away from both, so contact happens on day 1 and conflict by day 2. The rich hub and a garrisoned neutral Crown pull everyone toward the centre late in the match. Several mechanics push toward betrayal: allies share full vision, your own troops stationed in an ally's city stand aside when you attack it, conquest captures immediately and moves points both ways, and only one player wins. Turtling falls behind because building points are capped, the build queue runs on time, rams cancel walls, renown pays for fighting (x2 on the last day) and free sites run out by day 5-6. Comebacks stay possible through morale, settler costs that scale with city count, capital immunity until day 3 and scoring on a final snapshot. Everything is integer arithmetic with one seeded PRNG used only for map generation, so the spec can be implemented as written.

**Key trade-offs.**

- Immediate capture: a winning attack with a surviving settler takes the city at once, with no loyalty or siege state. This is simple and gives sharp, dramatic moments, but it is harsh. It is tempered by the 1 h minimum warning, capital immunity to the end of day 2, morale, and loss rounding that can kill a lone settler. The alternative, a loyalty or siege timer, gives allies a rescue window but adds per-city state and more events.
- Units whose home city is captured are disbanded wherever they are. This is trivial to implement and punishes overextension, but it can erase a whole army at once. A softer rule would re-home them to the oldest remaining city, at the cost of rerouting logic for in-flight movements.
- Fairness is exact for per-player islands only. The 12-island hub has 12-fold rather than N-fold symmetry, which is needed to stay inside 30-50 islands (I = 3N+13), so hub distances can differ by up to about 1 tile (about 10 transport-minutes) between players.
- Same-island travel uses a fixed 4-tile distance, with no geometry inside islands. Together with the 3600 s floor, nearly every short hop takes 1 h. That keeps the speed rule and the code simple but removes local positioning.
- Each land unit has one attack and one defence value, with no unit-type counters beyond walls, rams and the separate naval phase. The tactical depth comes from timing, trains, fakes, the abstention rule and diplomacy rather than from unit counters.
- Paying at enqueue with a 100% refund inside a 600 s grace period forgives LLM mistakes but allows mild loot-dodging (80% after the grace period). Paying when an item starts would close the loophole but makes queues stall unpredictably.
- Betrayal automatically dissolves the pact or alliance and is announced publicly. The attack itself stays allowed, so diplomacy is still non-binding, but this is a mechanical consequence that turns reputation into public data. The alternative, pure silence, means more hidden treachery but gives agents less to reason about.
- Renown awards points for kills to both sides, which works against turtling. Colluding allies (for example seats running the same model) could feed renown to one player as kingmakers. This is accepted and should be watched as a known risk.
- Victory is individual only, with no shared alliance win. That maximises late-game betrayal temptation, but cautious agents may avoid alliances or treat them as purely tactical.
- Domination will rarely trigger: it needs 50% of all existing cities on day 4, falling to 35% on day 7. The snapshot of points at the end is the main win path, and the falling threshold mainly adds pressure and leaderboard drama.
- Morale (minimum 50%) protects weak players and enables comebacks, but it slows eliminations and can let a crippled player become a nuisance kingmaker.
- Incoming attacks show their origin and arrival time but no composition. That enables fakes and bluffing, but fake spam could drain the victim's wake-up and LLM budget. This is countered by gateway caps: at most 40 attack launches per player per day, and at most one urgent wake every 1800 s.
- Economy tuning comes from a crude single-city integer simulation. Army sizes (about 100 on day 2, about 400-600 on day 4, about 1000-2000 on day 7) and when free sites run out (around day 5-6) are estimates that the phase-1 bot matches must confirm.

---

# Perfidia V1 rules: "Ring & Crown" (rules v1.0)

All numbers live in `RulesConfig` (§13). The engine reads them and never hard-codes them, and the match stores a hash of the config. The world uses neutral, reskinnable ids.

## 0. Conventions (apply everywhere)

| Topic             | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time              | `t` = integer game-seconds since match start. Game day d (1..7) = `[86400(d−1), 86400d)`. The match ends at `T = 604800`. Events with time ≥ T never resolve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Integer maths     | Integers only. `floorDiv` / `ceilDiv` on non-negative ints. `roundHalfUp(a,b) = floorDiv(2a+b, 2b)`. `rhaz(a,b)` = signed round-half-away-from-zero (coordinates only). `isqrt(n)` = exact floor square root for 0 ≤ n < 2^53 (Newton, or `Math.sqrt` followed by a ±1 correction loop). **Default rounding is floor.** Ratios are in permille (‰, /1000) or ppm (/10^6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Resources         | Stored per city in **sub-units**: 1 resource = 3600 sub-units. A rate of R/h adds exactly R sub-units per second, so accrual is exact and path-independent. Players see, spend, loot and send whole resources (`floorDiv(sub, 3600)`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Randomness        | Used only for map generation (and for ordering same-second actions in the lockstep driver). Combat, loot and everything else are deterministic. PRNG = mulberry32 (§1.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ids               | Players `p1..pN`, islands `i1..`, cities `c1..`, movements `mv1..`, reports `r1..`, messages `ms1..`, proposals `pr1..`, alliances `a1..`. Counters are global and monotonic and ids are never reused. Resources: `wood`, `stone`, `gold`. Building and unit ids: §4, §5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Same-second order | Engine events are keyed `(time, class, seq)`. Classes: **1** build_done · **2** recruit_done · **3** return (units arriving home) · **4** support / resources / found_city arrival · **5** spy arrival · **6** attack arrival · **7** system (proposal expiry, day start, domination check, match end). `seq` = global counter assigned when the event is scheduled, so it follows launch order: of two attacks launched in a row that arrive in the same second, the first one resolves first ("trains"). All events with time ≤ t are processed before any player action stamped t. Actions in the same second are applied in log order. In lockstep, the clock driver sorts each second's batch by `(h, playerIndex)` with `h = first output of mulberry32(seed ^ imul(t, 0x9E3779B1) ^ playerIndex)`, keeps each player's own submission order, and logs the result. Replays apply the log. |
| Errors            | Rejections are data `{ok:false, code, message, hint}` with numbers ("120 wood missing, available in 40 game-min").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 1. Map

### 1.1 Layout

There are `I = 3N + 13` islands (N=6 → 31, N=12 → 49) on an integer tile grid centred at (0,0). Every island is a point, and all cities on an island share its coordinates.

| Kind     | Count | Polar position (radius, angle°)                 | City sites                          | Production    | Size   | Role                                   |
| -------- | ----- | ----------------------------------------------- | ----------------------------------- | ------------- | ------ | -------------------------------------- |
| crown    | 1     | (0, 0)                                          | 1 (taken by the neutral Crown city) | ×1.5 (1500‰)  | large  | late-game prize                        |
| hub      | 12    | (rH, rot + hubRot + 30j), j = 0..11             | 1                                   | ×1.25 (1250‰) | small  | rich centre, contested by all          |
| home     | N     | (R, a_k)                                        | 2 (slot 0 = capital)                | ×1            | medium | start; slot 1 = safe first colony      |
| frontier | N     | (R + jF, a_k + floorDiv(a_{k+1} − a_k, 2) + aF) | 2                                   | ×1            | medium | between homes k and k+1, first contact |
| inner    | N     | (floorDiv(R·ip, 100), a_k + aI)                 | 1                                   | ×1            | small  | toward the centre, nearest to home k   |

- `a_k = rot + floorDiv(360k, N)` for k = 0..N (so `a_N = rot + 360`).
- `R` by N: {6:18, 7:21, 8:24, 9:26, 10:29, 11:32, 12:35}, which keeps neighbouring homes ≈ 18 tiles apart for every N.
- `rH = max(7, floorDiv(R·hp, 100))`.
- City sites = `5N + 13` (N=6: 43, N=8: 53, N=12: 73). Free at start: `4N + 12`.

### 1.2 Generation from `seed` (uint32)

- `rng = mulberry32((seed ^ 0x4D415031) >>> 0)`. Each step: `s = (s + 0x6D2B79F5) >>> 0; x = s; x = imul(x ^ (x >>> 15), x | 1); x ^= x + imul(x ^ (x >>> 7), x | 61); return (x ^ (x >>> 14)) >>> 0`.
- `randInt(lo, hi) = lo + (next() % (hi − lo + 1))`.
- Fixed draw order:
  1. `rot = randInt(0,359)`
  2. Seat permutation (Fisher–Yates: for i = N−1 down to 1, `j = randInt(0,i)`, swap)
  3. `jF = randInt(−2,2)`, `aF = randInt(−4,4)`, `ip = randInt(58,64)`, `aI = randInt(−8,8)`, `hp = randInt(30,34)`, `hubRot = randInt(0,29)`
- Polar to grid: `x = rhaz(r·cos10k(θ), 10000)`, `y = rhaz(r·sin10k(θ), 10000)`, with θ normalised to [0,360).
  - `SIN10K[d] = round(10000·sin d°)` for d = 0..90 is a committed 91-entry constant ([30]=5000, [45]=7071, [60]=8660, [90]=10000).
  - `sin10k` uses quadrant symmetry, and `cos10k(θ) = sin10k(θ+90)`.
- Ids: `i1` = crown; `i2..i13` = hub j=0..11; then for k = 0..N−1: home `i(14+3k)`, frontier `i(15+3k)`, inner `i(16+3k)`.
- Player `pm` (m = 1..N) gets home `k = perm[m−1]`. Its capital is `cm` at slot 0. The Crown city is `c(N+1)`. Each founded city takes the next free c-id.

### 1.3 Distance and travel

- Between islands: `d = isqrt((dx² + dy²)·10^6)` milli-tiles. On the same island: `d = 4000` (fixed walk).
- `travel(d, pace) = max(3600, ceilDiv(d·pace, 1000))`, with pace in game-seconds per tile.
- Group pace:
  - cross-island: the slowest **ship** in the group (land units ride on transports, §5.2);
  - same island: the slowest unit of any kind;
  - merchants: 600; spies: 450.
- **Speed rule**: every city-to-city movement takes ≥ 3600 s, so the fastest cross-island attack (warships only, pace 450) always takes ≥ 1 game hour.

Reference travel (median jitter; tiles → hours with transports (600) / warships only (450)):

| N   | neighbour home   | own frontier    | own inner      | nearest hub    | crown          | farthest home   |
| --- | ---------------- | --------------- | -------------- | -------------- | -------------- | --------------- |
| 6   | 18.4 → 3.1 / 2.3 | 9.2 → 1.5 / 1.2 | 8 → 1.3 / 1.0  | 11 → 1.8 / 1.4 | 18 → 3.0 / 2.3 | 36 → 6.0 / 4.5  |
| 8   | 18.4 → 3.1 / 2.3 | 9.2 → 1.5 / 1.2 | 10 → 1.7 / 1.3 | 17 → 2.8 / 2.1 | 24 → 4.0 / 3.0 | 48 → 8.0 / 6.0  |
| 12  | 18.7 → 3.1 / 2.3 | 9.1 → 1.5 / 1.1 | 14 → 2.3 / 1.8 | 24 → 4.0 / 3.0 | 35 → 5.8 / 4.4 | 70 → 11.7 / 8.8 |

Same island: raiders 1.0 h, guards and settlers 1.3 h, rams 2.0 h.

### 1.4 Fairness

- The per-player islands (home, frontier, inner) come from one template rotated N times. Every player therefore has identical geometry, up to 1° of angle rounding and ±1 tile of coordinate rounding.
- The hub ring and the crown are radially symmetric. The hub has 12-fold rather than N-fold symmetry, so hub distances differ by ≤ ~1 tile (≈ 10 transport-minutes) between players.
- The jitter `aF` gives every player a nearer "left" frontier and a farther "right" one, identically for all players.
- Seats are assigned to homes by the seeded permutation.
- Island separation is ≥ 2 tiles for all N (verified for the jitter extremes). The 3600 s floor makes closer islands irrelevant to travel.

## 2. Starting state

|                | Capital (per player, home slot 0)                                             | Newly founded city                                        | Crown `c(N+1)` (neutral)                                                      |
| -------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Buildings      | hall 1, lumber 1, quarry 1, mine 1, warehouse 1, barracks 1, harbor 0, wall 0 | hall 1, lumber 1, quarry 1, mine 1, warehouse 1, others 0 | hall 5, lumber 3, quarry 3, mine 3, warehouse 5, barracks 3, harbor 3, wall 5 |
| Resources      | 1000 / 1000 / 1000                                                            | 400 / 400 / 400                                           | 3000 / 3000 / 3000 (no production while neutral; no hideout)                  |
| Units          | 10 guard, 10 raider                                                           | none (escorts stay stationed, §6)                         | 300 guard, 20 warship (never regenerate, never act)                           |
| Pop used / cap | 20 / 150                                                                      | 0 / 150                                                   | –                                                                             |
| City points    | 130                                                                           | 125                                                       | 550 (250 + 300 crown bonus)                                                   |

Every player starts with no alliance and no pacts. **Attack protection** lasts until `t = 43200` (12 h): no player can launch an attack. **Capital immunity** lasts until `t = 172800` (end of day 2): capitals cannot be captured, but they can be attacked and looted.

## 3. Resources and population

| Level                                                | 0   | 1    | 2    | 3    | 4    | 5    | 6    | 7    | 8     | 9     | 10    |
| ---------------------------------------------------- | --- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ----- | ----- | ----- |
| Production /h (lumber→wood, quarry→stone, mine→gold) | 20  | 60   | 90   | 125  | 165  | 210  | 260  | 315  | 375   | 440   | 510   |
| Warehouse cap (per resource)                         | –   | 2000 | 2600 | 3400 | 4400 | 5700 | 7400 | 9600 | 12500 | 16000 | 20000 |
| Hall population cap                                  | –   | 150  | 220  | 300  | 390  | 490  | 600  | 720  | 850   | 990   | 1140  |

- Effective rate = `floorDiv(rate × islandProductionPermille, 1000)`.
- **Lazy accrual**: `sub(t) = min(cap·3600, sub(t0) + rate·(t − t0))`. The engine materialises the stock whenever an event or action touches the city, and re-anchors (`t0 = t`) whenever the rate, the cap or the stock changes. A new level produces from its completion second.
- **Hideout**: `floorDiv(cap × 15, 100)` of each resource cannot be looted (player cities only).
- Any delivery (loot return, tribute) above the cap is lost. The sender's hint states the expected loss.
- **Population**: `popUsed(city)` = Σ pop of every unit whose **home** is that city, wherever the unit is (home, stationed, travelling, queued).
  - Recruiting requires `popUsed + n·pop ≤ popCap(completed hall level)`.
  - Buildings use no pop.
  - Units that die, are consumed or are disbanded free their pop immediately.

## 4. Buildings (8)

### 4.1 List

| id                           | Max | Requires (level 1) | Effect / unlocks                                                                                                 |
| ---------------------------- | --- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `hall`                       | 10  | –                  | Pop cap; build time −4 % per level above 1; hall 3 unlocks settler                                               |
| `lumber` / `quarry` / `mine` | 10  | –                  | Wood / stone / gold production                                                                                   |
| `warehouse`                  | 10  | –                  | Storage cap and hideout                                                                                          |
| `barracks`                   | 10  | –                  | Land units; land recruit time −5 % per level above 1; barracks 5 unlocks ram                                     |
| `harbor`                     | 10  | hall 2             | Ships (transport at 1, warship at 3); ship recruit time −5 % per level above 1; trade capacity `500 + 500·level` |
| `wall`                       | 10  | hall 2             | Land defence +8 % per level; spy watch +50 per level                                                             |

### 4.2 Cost and time per level

- Cost: `cost(b,1) = base`, and `cost(b,L) = floorDiv(cost(b,L−1) × 1350, 1000)` for each resource.
- Raw time: same recurrence with 1300.
- The "cost of level L" is what you pay to go from L−1 to L.
- Queued duration: `ceilDiv(time(b,L) × (1000 − 40·(hall−1)), 1000)`, using the **completed** hall level at enqueue.

| id        | L1 (w/s/g · s)     | L5                 | L10                    | Σ levels 1–10 (w/s/g · raw h) |
| --------- | ------------------ | ------------------ | ---------------------- | ----------------------------- |
| hall      | 150/150/100 · 2700 | 495/495/330 · 7710 | 2215/2215/1475 · 28623 | 8127/8127/5415 · 32.0         |
| lumber    | 50/60/20 · 900     | 163/198/64 · 2570  | 729/885/283 · 9539     | 2677/3249/1046 · 10.7         |
| quarry    | 70/40/20 · 900     | 229/130/64 · 2570  | 1023/579/283 · 9539    | 3758/2130/1046 · 10.7         |
| mine      | 70/60/10 · 1080    | 229/198/29 · 3083  | 1023/885/126 · 11442   | 3758/3249/472 · 12.8          |
| warehouse | 100/100/30 · 1200  | 330/330/97 · 3426  | 1475/1475/429 · 12715  | 5415/5415/1581 · 14.2         |
| barracks  | 120/100/60 · 1800  | 396/330/198 · 5140 | 1771/1475/885 · 19081  | 6499/5415/3249 · 21.3         |
| harbor    | 160/120/80 · 2400  | 529/396/263 · 6853 | 2369/1771/1177 · 25441 | 8689/6499/4320 · 28.4         |
| wall      | 80/160/40 · 1800   | 263/529/130 · 5140 | 1177/2369/579 · 19081  | 4320/8689/2130 · 21.3         |

Maxing one city costs ≈ 105k resources and ≈ 151 h of raw build time (≈ 110 h with the hall bonus), so no city can be maxed before about day 5. Buildings use mostly wood and stone; units (§5) use mostly gold.

### 4.3 Build queue

- One queue per city, up to **4 items** including the one in progress. Items run strictly one after another.
- Cost is paid at enqueue and the duration is fixed at enqueue. An item starts when the previous one ends, or at enqueue if the queue is idle.
- Validation uses **projected levels** (completed + queued): the level must be ≤ max and requirements must be met.
- **cancel_queue**: refund per resource = `floorDiv(paid × pct, 100)`:
  - not started and ≤ 600 s since enqueue → 100 %;
  - not started otherwise → 80 %;
  - started → 50 %.
- A cancel also cancels every later item of the same building, and every later item whose requirement is no longer met. Each is refunded by its own status. The remaining items keep their durations and close up back-to-back.
- When a city is captured, all its queues are wiped without refund.

## 5. Units (6)

### 5.1 Stats

| id          | Domain | Att | Def | Naval att/def | Pace s/tile | Carry | Transport cap (pop) | Pop | Cost w/s/g       | Recruit s | Queue    | Requires   |
| ----------- | ------ | --- | --- | ------------- | ----------- | ----- | ------------------- | --- | ---------------- | --------- | -------- | ---------- |
| `guard`     | land   | 5   | 30  | –             | 1200        | 5     | –                   | 1   | 20/35/35         | 300       | barracks | barracks 1 |
| `raider`    | land   | 30  | 8   | –             | 900         | 25    | –                   | 1   | 25/15/60         | 360       | barracks | barracks 1 |
| `ram`       | land   | 5   | 5   | –             | 1800        | 0     | –                   | 3   | 120/120/160      | 1200      | barracks | barracks 5 |
| `settler`   | land   | 0   | 0   | –             | 1200        | 0     | –                   | 10  | 400/400/1000 × S | 3600      | barracks | hall 3     |
| `transport` | naval  | 0   | 0   | 0/0           | 600         | 0     | 20                  | 2   | 100/40/100       | 900       | harbor   | harbor 1   |
| `warship`   | naval  | 0   | 0   | 50/50         | 450         | 0     | –                   | 4   | 120/80/250       | 1500      | harbor   | harbor 3   |

- **Ram**: every 4 attacking rams cancel 1 wall level for that battle only.
- **Settler**: founds a city (§6) or captures one (§7). Price multiplier `S‰ = 1000 + 600·k`, with `k` = cities owned + settlers owned (alive anywhere or queued) − 1. Each resource costs `floorDiv(base × S, 1000)`. Settler batches have size 1. A player reduced to one city pays the base price again.
- **Recruitment**:
  - A batch of n units (1..500).
  - `unitTime = ceilDiv(base × (1000 − 50·(lvl−1)), 1000)`, using the queue building's completed level at enqueue.
  - Unit k of the batch becomes available at `start + k·unitTime`; the engine materialises it lazily, as with resources.
  - Each city has two recruit queues (barracks, harbor) of ≤ 4 batches each. Each queue is sequential. Both run in parallel with each other and with the build queue.
  - Cost and pop are reserved at enqueue. Cancelling refunds the uncompleted units by the §4.3 rule (the unit in training counts as uncompleted).

### 5.2 Transport rule

- If origin and target are on different islands, the movement's land units must fit: Σ transport capacity ≥ Σ land pop. Ships carry themselves.
- Homebound trips (returns, recalls, dismissals) never need capacity. Land units travelling without ships sail at pace 600.
- Ships in a same-island movement never fight.

## 6. Movements

Only units **at home in their home city** can be sent. Units stationed elsewhere can only be recalled. A movement stores owner, origin, target, units, kind, launch time, arrival time, seq, and **the target's owner at launch**.

| Action           | Contents                                                           | Arrival effect                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attack`         | ≥ 1 land unit or ≥ 1 warship (+ transports)                        | Battle (§7). Not allowed before t = 43200. Never against your own city. The neutral Crown is a valid target.                                                                                  |
| `support`        | Any units                                                          | Stationed in the target (any player city, not neutral). They defend it, and their pop stays charged to their home city. Groups merge by (owner, home city).                                   |
| `found_city`     | ≥ 1 settler (+ escorts, transports) to an island (+ optional slot) | If a site is free (the requested slot, else the lowest free index): the city is founded, 1 settler is consumed, and everything else stays stationed there. Otherwise the whole group returns. |
| `spy`            | Gold ≥ 100 (no units)                                              | §8. No return trip.                                                                                                                                                                           |
| `send_resources` | Wood/stone/gold, pace 600                                          | Added to the target's stock (cap applies).                                                                                                                                                    |
| return           | Survivors + loot                                                   | Rejoin home; loot is added.                                                                                                                                                                   |

- **Target changed hands** (owner at arrival ≠ owner at launch):
  - new owner = sender → an attack or support is stationed there and resources are delivered;
  - new owner is the sender's alliance member or pact partner → the attack returns without fighting (no accidental betrayal);
  - otherwise supports and shipments return, and attacks resolve against the new owner.
  - A shipment that must return to a city its sender no longer owns is lost.
- **recall_troops**:
  1. Your own outgoing attack, support or found_city, if no more than **900 s** have passed since launch: it turns back and arrives home at `t + (t − launch)`. The target's incoming view drops it ("turned back").
  2. Some or all of your stationed units anywhere: they travel home with `travel(d, group pace)`.
  3. **Dismiss** foreign units stationed in your own city: they travel home.
- **Trade capacity**: the resources in a city's outbound shipments still in transit must total ≤ `500 + 500·harbor`.
- Return after a battle takes the same duration as the outbound trip.
- Movements cannot be intercepted.

## 7. Combat (deterministic)

An attack arriving at city C at time t (class 6) resolves in the steps below. Scores used in step 2 are the scores at time t.

1. **Forces**
   - Attacker: the movement's units.
   - Defenders: every unit physically in C **not owned by the attacker**: the owner's units at home, every stationed support, and the neutral garrison.
   - The attacker's own units stationed in C **abstain**: they don't fight and are unharmed. This is the "trojan support".
2. **Morale** `m‰`:
   - 1000 if the target is neutral or `defScore ≥ attScore`;
   - otherwise `max(500, 300 + floorDiv(700·defScore, attScore))`.
3. **Loss function**: `lossPpm(L, W)` for 0 ≤ L ≤ W, W > 0, approximately (L/W)^1.5:
   - `r = floorDiv(L·10^6, W)`
   - `lossPpm = floorDiv(r·isqrt(r·10^6), 10^6)`
   - A stack of n loses `roundHalfUp(n·ppm, 10^6)` units.
4. **Naval phase** (only if origin island ≠ target island). `A_n = floorDiv(Σwarships·50·m, 1000)`, `D_n = Σ defending warships·50`.
   - A_n = D_n = 0: no naval battle.
   - A_n > D_n: the attacker wins. **All** defending ships in C are destroyed (any owner, transports included). Attacking warships lose `lossPpm(D_n, A_n)`. Attacking transports are untouched.
   - Otherwise (D_n ≥ A_n, D_n > 0): the defender wins. All attacking ships **and the land units aboard** are destroyed. Each defending owner's warship stack loses `lossPpm(A_n, D_n)`. The battle ends.
5. **Land phase** (if any attacking land units remain).
   - `effWall = max(0, wall − floorDiv(rams, 4))`
   - `A_l = floorDiv(Σatt·n · m, 1000)`
   - `D_l = floorDiv((Σdef·n + 50) × (1000 + 80·effWall), 1000)` (base defence 50)
   - A_l > D_l: the attacker wins. **All** defending land units die. Each attacking unit type loses `lossPpm(D_l, A_l)`.
   - Otherwise: the defender wins. All attacking land units die. Each defending stack (per owner, per type) loses `lossPpm(A_l, D_l)`. Attacking ships return empty.
   - A naval-only attack that wins has no land phase; its ships return with no loot.
6. **After a land win**:
   - If ≥ 1 settler survived, C is not owned by the attacker, and C is not a capital with t < 172800 → **capture** (step 8).
   - Otherwise → **loot** (step 7). The survivors and ships return.
7. **Loot**.
   - `capacity = Σ surviving land units × carry`.
   - `lootable_r = max(0, stock_r − hideout_r)`; the hideout is 0 in the Crown.
   - Water-fill allocation:
     - Repeat:
       - `open` = resources (in order wood, stone, gold) that still have lootable stock left.
       - Stop if `open` is empty or no capacity remains.
       - `share = floorDiv(capacity, |open|)`.
       - If `share = 0`, take 1 from each open resource in order until capacity runs out, then stop.
       - Otherwise take `min(share, left_r)` from each open resource and subtract it from capacity.
   - The loot leaves C at t and is added at home when the survivors return.
8. **Capture**:
   1. C's owner becomes the attacker. One settler is consumed. The other survivors (ships included) stay stationed in C and keep their home city.
   2. Every unit in C that the attacker does not own is destroyed (counted as killed).
   3. Units whose home is C are **disbanded wherever they are**, and their movements are deleted.
   4. C's queues are wiped. Buildings and the remaining resources stay.
   5. If the former owner now has 0 cities, they are **eliminated** (§11).
   6. A captured Crown becomes a normal city that keeps ×1.5 production and its +300 points.
9. **Renown**. `dayMult‰ = [1000,1000,1000,1000,1000,1500,2000][day−1]`. Killed pop includes ships and drowned units.
   - The attacker gains `floorDiv(killedDefPop·500·dayMult, 10^6)`.
   - Each defending player o gains `floorDiv(killedAttPop·500·dayMult·pop_o, 10^6·totalDefPop)`, where `pop_o` = the pop o had in the battle. If `totalDefPop = 0`, everything goes to the city owner.
   - Neutral defenders earn nothing.
10. **Betrayal**. If at t the attacker and C's owner share an alliance or a pact:
    - the pact ends;
    - the attacker leaves the alliance (with the rejoin cooldown);
    - a **public `betrayal` event** is emitted.
11. **Report `r#`**.
    - Contents: time, city and island, attacker (player, origin), defender, supporters, morale, wall (level, rams, effective level, bonus), base defence; for each phase: forces by owner and type, powers, winner, loss ppm and losses; loot, capture, renown per player, abstained units.
    - Defenders and supporters get the full report. The attacker gets the full report only if any attacking unit survived; otherwise it sees the outcome and its own losses.
    - **Public notice** (everyone): time, city, attacker, defender, result, captured or not.

Worked examples (morale 1000):

| Situation                                                        | A     | D     | Result                                                                                     |
| ---------------------------------------------------------------- | ----- | ----- | ------------------------------------------------------------------------------------------ |
| Day-1 raid: 40 raiders vs 10 guard + 10 raider, wall 0           | 1200  | 430   | Win, ppm 214501 → −9 raiders; 31 × 25 = 775 carry                                          |
| Fresh colony: 10 raiders + 1 settler vs empty city               | 300   | 50    | Win, ppm 68040 → −1 raider; **captured**                                                   |
| Day-4 capital: 500 raiders vs 300 guard + 50 raider, wall 6      | 15000 | 13986 | Win but −450 raiders                                                                       |
| Same, with 24 rams                                               | 15120 | 9450  | Win, −247 raiders, −12 rams                                                                |
| Crown: 600 raiders + 20 rams + 1 settler vs 300 guards, wall 5→0 | 18100 | 9050  | Win, ppm 353553, settler survives → capture (also needs ≥ 21 warships for the naval phase) |

## 8. Espionage

- `spy(from, target, gold)`: `gold ≥ 100`, deducted at launch. Pace 450 (≥ 3600 s).
- Allowed during protection and against the Crown. Not allowed against your own cities.
- **Invisible** to everyone except the sender.
- At arrival: `watch = 100 + 50·wall`, and the spy **succeeds iff gold ≥ watch**. The gold is spent either way.
- **Success**: a snapshot report at t with resources, buildings, all units present by owner, build and recruit queues, and the watch value. The target is not told.
- **Failure**: the sender learns only "caught". The target is notified: "spy from cX (pY) caught at t".

## 9. Diplomacy (engine level; nothing is binding)

| Item               | Rule                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messages           | `send_message(to: 1–5 player ids \| "all", text ≤ 600 chars)`, delivered instantly. Private messages are seen by recipients and spectators. `"all"` is public and goes into the news feed of every player.                                                                                |
| Proposals          | `propose_alliance(to, kind: "alliance" \| "pact", text ≤ 300, pactUntil?)` creates `pr#`, which expires after 86400 s. Pending proposals are private. `answer_proposal(id, accept)` is re-validated at answer time, and the result is public if accepted.                                 |
| Alliance formation | On accept: if both players are unallied, a new alliance `a#` forms with an optional name (≤ 24 chars). If exactly one is allied, the other joins that alliance. If both are allied, the accept fails ("leave first"). Max size = `max(2, floorDiv(N,3))` (N = 6–8 → 2, 9–11 → 3, 12 → 4). |
| Alliance effects   | Public membership, plus **shared vision**: members see each other's cities exactly as the owner does (§10). Nothing else: no combat effect and no shared victory.                                                                                                                         |
| Leaving            | `leave_alliance()` takes effect at once and is public. The leaver cannot join or form an alliance for 21600 s. An alliance left with one member dissolves.                                                                                                                                |
| Pacts              | Bilateral and public. They last until `pactUntil` (optional, ≥ now + 3600), until `leave_alliance({pactWith})`, or until a betrayal (§7.10).                                                                                                                                              |
| Tribute            | `send_resources` to any city; the recipient sees the incoming shipment. Private.                                                                                                                                                                                                          |
| Betrayal           | Attacks on allies and pact partners are allowed. When the battle resolves, the tie breaks and a public `betrayal` event fires. Spying never triggers it.                                                                                                                                  |

## 10. Visibility (fog of war)

| Information                                                                                                                      | Self                                                                                                                                         | Alliance member                      | Everyone else                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| Map: islands, coordinates, kinds, sites free or taken                                                                            | ✓                                                                                                                                            | ✓                                    | ✓                                                                    |
| Each city: id, owner, island/slot, **points**, capital flag                                                                      | ✓                                                                                                                                            | ✓                                    | ✓                                                                    |
| City resources, buildings, queues, units present (by owner)                                                                      | ✓                                                                                                                                            | ✓                                    | Only from spy or battle report snapshots, shown with their timestamp |
| Incoming **attack** on a city                                                                                                    | Shown at launch: movement id, origin city and player, target, arrival time. **No composition** (fakes are possible). Disappears if recalled. | ✓ (on members' cities)               | ✗                                                                    |
| Incoming support or shipment to a city                                                                                           | ✓ full                                                                                                                                       | ✓                                    | ✗                                                                    |
| Your own movements and stationed units                                                                                           | ✓ full                                                                                                                                       | ✗ (unless targeting a member's city) | ✗                                                                    |
| Spies, settlers in flight                                                                                                        | Own only                                                                                                                                     | ✗                                    | ✗ (a failed spy notifies its target)                                 |
| Players: score, renown, rank, city list, alliance, pacts, eliminated                                                             | ✓                                                                                                                                            | ✓                                    | ✓ public                                                             |
| News feed: public messages, alliances and pacts, betrayals, battle notices, foundings, captures, eliminations, domination status | ✓                                                                                                                                            | ✓                                    | ✓                                                                    |
| Battle and spy reports                                                                                                           | Participants as in §7.11 and §8                                                                                                              | Not shared automatically             | ✗                                                                    |

Spectators see everything.

## 11. Points, leaderboard, victory

- **City points** = `100 + 5·Σ building levels` (+300 for the Crown city). A capital starts at 130 and a maxed city is worth 500.
- **Score** = Σ city points + renown. It updates live and is public.
- **Leaderboard ranking**: score desc → cities desc → renown desc → player index asc.
- **Elimination**: a player at 0 cities is eliminated.
  - Its remaining units disband, its proposals are voided, and its alliance and pacts end.
  - The seat stops acting.
  - Eliminated players rank below all survivors, the later-eliminated first.
- **Domination (early win)**. A player wins at once if `owned·100 ≥ pct·existingCities`, where `existingCities` = every city on the map, the neutral Crown included.
  - `pct` by day: days 1–3 none, day 4: 50, day 5: 45, day 6: 40, day 7: 35.
  - Checked at the end of every second in which a city was founded or captured, and at each day start (class 7).
  - The match ends after that second. If several players qualify, the winner has the most cities, then the highest score, then the lowest index.
- **Time victory**: at T = 604800 the final ranking is the leaderboard. Rank 1 wins. There is no shared victory.

## 12. Pacing sanity (typical balanced player, N = 8; from an integer sim of these tables)

| Game time | State                                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H0        | Queue: lumber 2, quarry 2, mine 2, hall 2. Pre-buy 10 raiders.                                                                                                                                                              |
| H2–3      | Hall 2 → harbor 1. First 2 transports by ≈ H3–6. Production ≈ 375/h at L3.                                                                                                                                                  |
| H5–8      | Earliest settler (hall 3 + 1800 res, gold-bound). Home slot 1 founded 1.3 h later.                                                                                                                                          |
| **H12**   | Protection ends, earliest attack launch. A rusher has 30–40 raiders + 2 transports. First battles land at **H13.5** (frontier colonies) and **H15** (neighbour capitals).                                                   |
| H24       | 2 cities; capital ≈ 630/h; ≈ 50 units. Frontier islands (1.5 h from two players, 2 sites) are being raced for, which means **contact on day 1**.                                                                            |
| H48       | 2–3 cities; capital level-sum ≈ 40, ≈ 900/h; army ≈ 100–150. Neighbours share frontier islands (1 h land attacks, no ships), and the first colonies get captured.                                                           |
| H72       | Capital immunity is over. 3–4 cities; army ≈ 250–350; rams available. Conquest of developed cities (200–375 pts, a double swing) now beats founding.                                                                        |
| H96       | 4–5 cities; army ≈ 400–600. A strong player or a pair of allies can break the Crown: ≈ 600 raiders + 20 rams + ≥ 21 warships + 34 transports, for a jackpot of 3000/3000/3000 and 550 pts. Domination check starts at 50 %. |
| H120–144  | Free sites are exhausted (4N+12 free sites at ≈ 0.8 settlers per player per day), so growth now means conquest. Renown ×1.5 then ×2. Domination threshold 45 → 35 %.                                                        |
| H168      | Armies ≈ 1000–2000 recruited per player (pop cap ≈ 3–4k over 5–6 cities). Expected scores: conqueror ≈ 2000–2600, turtle with 2 maxed cities ≈ 700–900.                                                                     |

**Anti-turtle**

- Building points are capped (≤ 500 per city) and the build queue is time-bound (≈ 110 h to max one city), so points come from cities.
- Renown pays both sides of a fight, ×2 on day 7.
- 4 rams cancel one wall level.
- Only 15 % of storage is hidden from looting.
- Free sites run out around day 5.
- The Crown is a jackpot.
- The final score is a snapshot, so armies left unused at the end are wasted.

**Anti-snowball**

- Settlers cost +60 % per city or settler already owned.
- Morale reduces attacks on smaller players (floor 50 %).
- Units launch only from their home city, and captured cities start ungarrisoned.
- If a home city falls, its army disbands, which punishes overextension.
- The leaderboard is public, which invites coalitions.
- Domination thresholds are high.

**Comeback**

- Morale.
- The settler price resets to base when a player shrinks to one city.
- Capitals are immune until the end of day 2.
- A late capture of a leader's capital swings about 750 points.
- Renown can come from defence.

## 13. Rules config sketch

```ts
type Res = { wood: number; stone: number; gold: number };
type BuildingId =
  | "hall"
  | "lumber"
  | "quarry"
  | "mine"
  | "warehouse"
  | "barracks"
  | "harbor"
  | "wall";
type UnitId = "guard" | "raider" | "ram" | "settler" | "transport" | "warship";
type IslandKind = "crown" | "hub" | "home" | "frontier" | "inner";
type Range = readonly [min: number, max: number];
type CitySeed = {
  buildings: Record<BuildingId, number>;
  resources: Res;
  units: Partial<Record<UnitId, number>>;
};

interface BuildingRule {
  maxLevel: number;
  baseCost: Res;
  baseTimeSec: number;
  costGrowthPermille: number;
  timeGrowthPermille: number;
  requires: Partial<Record<BuildingId, number>>;
}
interface UnitRule {
  domain: "land" | "naval";
  attack: number;
  defense: number;
  navalAttack: number;
  navalDefense: number;
  paceSecPerTile: number;
  carry: number;
  transportCapacity: number;
  pop: number;
  cost: Res;
  recruitTimeSec: number;
  queue: "barracks" | "harbor";
  requires: Partial<Record<BuildingId, number>>;
}

interface RulesConfig {
  rulesId: "ring-crown";
  version: "1.0"; // hashed into the match record
  time: {
    matchSec: 604800;
    daySec: 86400;
    minTravelSec: 3600;
    attackProtectionUntilSec: 43200;
    capitalImmunityUntilSec: 172800;
    recallWindowSec: 900;
  };
  map: {
    players: Range /*[6,12]*/;
    homeRingRadius: Record<number, number> /*{6:18,7:21,8:24,9:26,10:29,11:32,12:35}*/;
    hubCount: 12;
    hubRadiusPct: Range /*[30,34]*/;
    hubRadiusMin: 7;
    innerRadiusPct: Range /*[58,64]*/;
    frontierRadiusJitter: Range /*[-2,2]*/;
    frontierAngleJitterDeg: Range /*[-4,4]*/;
    innerAngleJitterDeg: Range /*[-8,8]*/;
    sites: Record<IslandKind, number> /*crown 1, hub 1, home 2, frontier 2, inner 1*/;
    productionPermille: Record<IslandKind, number> /*crown 1500, hub 1250, else 1000*/;
    sameIslandDistanceMilli: 4000;
    sin10k: readonly number[] /*91 entries*/;
    rngSalt: 0x4d415031;
  };
  start: { capital: CitySeed; newCity: CitySeed; crown: CitySeed }; // §2
  economy: {
    productionPerHour: number[] /*11*/;
    warehouseCap: number[];
    popCap: number[];
    hideoutPct: 15;
    hallBuildSpeedPermillePerLevel: 40;
    recruitSpeedPermillePerLevel: 50;
    trade: { base: 500; perHarborLevel: 500; paceSecPerTile: 600 };
  };
  buildings: Record<BuildingId, BuildingRule>; // §4.2, growth 1350 / 1300
  queues: {
    buildSlots: 4;
    recruitSlotsPerQueue: 4;
    maxBatch: 500;
    refund: { graceSec: 600; gracePct: 100; notStartedPct: 80; startedPct: 50 };
  };
  units: Record<UnitId, UnitRule>; // §5.1
  settler: { costStepPermille: 600; batchMax: 1 };
  combat: {
    baseDefense: 50;
    wallPermillePerLevel: 80;
    ramsPerWallLevel: 4;
    morale: { basePermille: 300; slopePermille: 700; floorPermille: 500 };
    renownPermille: 500;
    renownDayMultiplierPermille: [1000, 1000, 1000, 1000, 1000, 1500, 2000];
  };
  spy: { minGold: 100; watchBase: 100; watchPerWallLevel: 50; paceSecPerTile: 450 };
  scoring: { cityBase: 100; perBuildingLevel: 5; crownBonus: 300 };
  victory: { dominationPctByDay: [null, null, null, 50, 45, 40, 35] };
  diplomacy: {
    allianceSize: { divisor: 3; min: 2 };
    proposalTtlSec: 86400;
    rejoinCooldownSec: 21600;
    allianceNameMaxChars: 24;
    proposalTextMaxChars: 300;
  };
  gateway: {
    // enforced by gateway, hashed with the rules
    roundTripsPerWake: 8;
    toolCallsPerWake: 40;
    messages: { maxChars: 600; maxRecipients: 5; privatePerDay: 24; publicPerDay: 4 };
    proposalsPerDay: 6;
    attackLaunchesPerDay: 40;
    notesMaxChars: 4000;
    wake: {
      safetySec: 43200;
      selfWakesPerDay: 12;
      selfWakeMinDelaySec: 900;
      selfWakeMaxDelaySec: 43200;
      groupingWindowSec: 300;
      urgentMinGapSec: 1800 /*anti fake-spam*/;
      urgent: ["incoming_attack", "city_captured", "betrayed"];
    };
  };
}
```

## Appendix: tools → rules

| Tool                                                                                    | Rule hook                                                                                                                              |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `view_city(c)`                                                                          | Full view for own and alliance cities. Other cities: public fields + latest intel snapshot (§10).                                      |
| `view_island(i)`                                                                        | Kind, coordinates, sites (free/taken, owners, points), production bonus, travel times from each own city (transport / warship / walk). |
| `view_map`                                                                              | All islands, kinds, coordinates, site occupancy and owners.                                                                            |
| `view_player(p)`                                                                        | Public profile: score, renown, rank, cities, alliance, pacts, recent public events.                                                    |
| `leaderboard`                                                                           | Ranking (§11), alliances, current domination threshold and the top city share.                                                         |
| `rules`                                                                                 | This config plus formulas and precomputed cost/time tables.                                                                            |
| `build(c, b[])`                                                                         | §4.3. Several buildings per call, up to the queue limit.                                                                               |
| `recruit(c, u, n)`                                                                      | §5.1.                                                                                                                                  |
| `cancel_queue(c, itemId)`                                                               | §4.3 refunds and cascade.                                                                                                              |
| `send_resources(from, to, res)`                                                         | §6 trade capacity, pace 600.                                                                                                           |
| `attack` / `support(from, to, units)`                                                   | §5.2, §6, §7.                                                                                                                          |
| `spy(from, to, gold)`                                                                   | §8.                                                                                                                                    |
| `recall_troops(movementId \| stationed group \| dismiss)`                               | §6.                                                                                                                                    |
| `found_city(from, island, slot?, units)`                                                | §6.                                                                                                                                    |
| `send_message` / `propose_alliance` / `answer_proposal` / `leave_alliance({pactWith?})` | §9.                                                                                                                                    |
| `write_note(text, append \| replace)` / `read_notes`                                    | Notebook ≤ 4000 chars (gateway).                                                                                                       |
| `end_turn(wakeAt?)`                                                                     | Self-wake within [now + 900, now + 43200], limited by the daily budget (gateway).                                                      |
