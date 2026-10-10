# Candidate ruleset: Archipelago Classic (rules id `classic-1`)

> Phase-1 design candidate, kept for reference and as a future alternative ruleset. Not the active ruleset (see docs/rulesets/perfidia-1.md).

**Pitch.** This is the Grepolis loop cut down to 3 resources, 8 buildings and 5 units. Production buildings feed a warehouse, the hall caps population, and armies cross water on transports behind warships. Fights run a naval phase and then a land phase against wall and base defense. Winners loot, and a settler starts a public 6-hour siege before a city changes hands, which gives the defender a counter-move and the show its "call for help" moments. Everything is integer and table-driven. The map is a seeded ring that is symmetric by construction. I checked it with a script: islands at least 50 tiles apart, and every player's 8 nearest islands within ±10 tiles of everyone else's. A reference-bot economy sim shows the 3 safe slots per player fill by about day 3.5. Cities, which carry most of the score, then have to be won on shared islands or taken from neighbours, while day-3/4 armies already outclass fresh colonies 5 to 8 times over.

**Key trade-offs.**

- Six-hour public siege instead of instant conquest. It adds siege state, garrison battles and bounce rules, but defenders and allies get a counter-move after the 1-hour warning, and spectators and diplomacy get a 'save c12' moment. The alternative was Grepolis-style instant capture or a revolt timer: simpler, but easier to snowball.
- Symmetric seeded ring map with a committed integer cosine table. Fairness is guaranteed (nearest-8 distances within ±10 tiles) and the generation is deterministic in any JS engine. The cost is less organic maps, since the seed only changes rotation, a shared jitter and seat assignment. The alternative was random scatter with rejection sampling, which needs fairness checks and re-rolls.
- One attack value and one defense value per unit, with no damage types. LLMs can compute outcomes exactly, but there is less rock-paper-scissors depth. Variety comes from the land/naval split, the wall and transports.
- Troops aboard share their fleet's naval losses, and any defending warship sinks unescorted transports. This is proven Grepolis sequencing (clear the harbour, then land), but agents that skip spying get punished hard.
- A lost city's units are removed everywhere. The rule is simple and the stakes are dramatic, but it pushes towards snowballing. The 6 h siege, settler cost scaling, the domination countdown and the 2-ally cap offset it. The alternative was re-homing to the nearest city: kinder, but it adds more edge cases.
- Build and recruit durations are fixed at enqueue. ETAs are stable for agents and for the event queue, but a hall upgrade finishing mid-queue does not speed up items already queued.
- Pacts are public, expire after 48 h, and break automatically and publicly when an attack is launched. Betrayal costs reputation and is visible to the show, which reduces permanent peace; secret deals stay possible only through private messages.
- Allies share the troops in each other's cities and incoming attacks. That makes alliances mechanically valuable and betrayals better informed, at the cost of some fog of war.
- Score is mostly cities: 100 per city, plus building levels and battle points divided by 10. The leaderboard reads easily, and expansion and conquest are what win. The risk of founding spam is kept down by settler cost scaling and by the 3 safe slots per player.
- Every movement takes at least 3600 s, and walking inside an island takes a fixed time per unit type. The speed rule holds everywhere, including same-island raids, but slot positions no longer matter for travel.
- 24-hour opening with no attacks allowed. Day 1 is for diplomacy and the economy, and early rushes are already weak. It delays the first blood, which a shorter window or no protection would bring forward.
- Resources accrue exactly as integers scaled by 3600, so the result does not depend on how often the stock is computed, at the cost of larger numbers (still far below 2^53).
- An attack's foe is fixed at launch, and the attack turns back if the target has changed hands or someone else is besieging it. This rules out hitting an ally by accident, but troops in flight cannot be redirected to an opportunity.
- Battle headlines are public (no numbers). They feed diplomacy and give spectators a story, at the cost of some fog of war.
- Calibration caveat: the pacing figures come from one scripted reference bot that never fights, so they are an upper bound on peaceful growth. Real wake-up rates and fights in phase-1 bot matches should be used to retune the costs (gold is the binding resource), the size of the protection window and the domination threshold for large N.

---

# Perfidia V1 game rules: "Archipelago Classic" (`classic-1`)

All numbers are defaults held in the rules config (§15). Every formula uses integers only. A division is **floor** unless stated otherwise, and every operand is ≥ 0 unless stated.

---

## 0. Conventions

| Item                | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time                | `t` = integer game-seconds since start. Match end `T_END = 604800`. Game day = `floor(t/86400)+1`.                                                                                                                                                                                                                                                                                                                                                  |
| Fixed point         | Resource stocks are stored ×3600 (§3). Fractions are permille (‰).                                                                                                                                                                                                                                                                                                                                                                                  |
| `isqrt(n)`          | Largest `s ≥ 0` with `s² ≤ n`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `rdiv(n,d)`         | Map coordinates only (n may be negative): `sign(n)·floor((2                                                                                                                                                                                                                                                                                                                                                                                         | n   | +d)/(2d))`, i.e. round half away from zero. |
| `lossPm(lo,wi)`     | `0` if `lo=0`; else `r=floor(1000·lo/wi)`, result `floor(r·isqrt(1000·r)/1000)`. This is about `1000·(lo/wi)^1.5`; equal strengths give 1000.                                                                                                                                                                                                                                                                                                       |
| `casualties(n,f)`   | `floor((n·f+500)/1000)` (round half up), applied per unit type per owner.                                                                                                                                                                                                                                                                                                                                                                           |
| `ceilDiv(a,b)`      | `floor((a+b-1)/b)`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Canonical orders    | resources `wood, stone, gold`; buildings `hall, lumber, quarry, mine, warehouse, barracks, harbor, wall`; units `guard, raider, settler, transport, warship`. They apply to every iteration, tie-break and display.                                                                                                                                                                                                                                 |
| IDs                 | Players `p1..pN` (seat order), islands `i1..`, cities `c1..` (in creation order, never reused, kept on conquest; starting cities `c1..cN` belong to `p1..pN`), movements `m1..`, reports `r1..`, proposals `q1..`, messages `g1..`.                                                                                                                                                                                                                 |
| PRNG                | mulberry32: `s=(s+0x6D2B79F5)>>>0; t=s; t=Math.imul(t^(t>>>15),t\|1); t^=t+Math.imul(t^(t>>>7),t\|61); return (t^(t>>>14))>>>0`. Stream seed = FNV-1a-32 (offset 2166136261, prime 16777619, `Math.imul`) of UTF-8 `"${matchSeed}:${stream}"`. `randInt(lo,hi)=lo+floor(u·(hi−lo+1)/2^32)`. Shuffle = Fisher–Yates with i from n−1 down to 1, `j=randInt(0,i)`. Streams: `map`, `seats`, `tiebreak`. **Combat, spying and loot use no randomness.** |
| Same-second actions | The clock driver orders actions stamped with the same second (seeded) and records that order in the log. Replay uses the log order.                                                                                                                                                                                                                                                                                                                 |

---

## 1. Map generation

**Inputs:** `matchSeed` (uint32) and `N ∈ [6,12]`.

- Home ring radius: `R = homeRadius[N] = {6:240, 7:277, 8:314, 9:351, 10:388, 11:426, 12:464}`, i.e. `round(120/sin(π/N))`. Adjacent homes are about 240 tiles apart for every N.
- Map centre `(C,C)` with `C = R+180`. Coordinates are integer tiles, all ≥ 0, and the map spans `[0,2C]²`.
- `COS[d]` for d = 0..359 is `round(10000·cos d°)`, stored as a **committed constant table**; `SIN[d]=COS[(d+270) mod 360]`. The engine never calls `Math.cos`.

**Algorithm** (rng = stream `map`):

1. `rot = randInt(0,359)`.
2. For each kind in the order `center, home, frontier, inner, backyard`: `jr[kind]=randInt(−10,10)` and `ja[kind]=randInt(−2,2)`. The same jitter applies to every sector, so the map keeps its rotational symmetry.
3. For sector `k=0..N−1`: `A_k = rot + floor(360k/N)` and `M_k = rot + floor(360(2k+1)/(2N))`.
4. Place the islands in polar coordinates `(r, a°)`:

| kind     | count                     | r                              | angle    | slots                   | richness ‰ |
| -------- | ------------------------- | ------------------------------ | -------- | ----------------------- | ---------- |
| center   | N if N ≤ 7 (ring), else 1 | `70+jr` (ring) / exactly (C,C) | `A_k+ja` | 2 each / `2+floor(N/2)` | 1500       |
| home     | N                         | `R+jr`                         | `A_k+ja` | 2 (slot 0 = start city) | 1000       |
| frontier | N                         | `R+jr`                         | `M_k+ja` | 3                       | 1100       |
| inner    | N                         | `R−120+jr`                     | `M_k+ja` | 2                       | 1200       |
| backyard | N                         | `R+110+jr`                     | `A_k+ja` | 2                       | 900        |

`x = C + rdiv(r·COS[a mod 360],10000)` and `y = C + rdiv(r·SIN[a mod 360],10000)`. 5. Island ids follow generation order: the center island(s) with k ascending, then for each k: home, frontier, inner, backyard. 6. Seats: `perm = shuffle([0..N−1])` on stream `seats`. Player `p(j+1)` gets home sector `perm[j]`, and city `c(j+1)` sits in slot 0 of that home island. 7. Tie-break order is a shuffle of `[p1..pN]` on stream `tiebreak`. It is public from the start.

**Totals for N = 6..12:** islands 30/35/33/37/41/45/49, city slots 66/77/78/87/97/106/116.

**Checked by script** over all N and all jitter values: islands are at least 50 tiles apart, and for every home the sorted distances to its 8 nearest islands match every other home's within ±10 tiles.

**Distances from a home (all N):** backyard 110; two frontiers about 121–124; two inners about 148–159; two neighbour homes about 240; center between 170 (N ≤ 7) and 464 (N = 12).

**Safe slots:** 3 per player (1 free slot at home and 2 in the backyard). Frontier and inner slots are shared by two neighbours, and the center is shared by everyone.

**Island size** is cosmetic: display radius `8+4·slots`. All cities on an island share its coordinates for travel purposes.

**Island distance:** `d = isqrt(dx²+dy²)` between island centres.

---

## 2. Starting state (each player)

|                          | Value                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cities                   | 1, in slot 0 of its home island                                                                                                                    |
| Buildings                | hall 1, lumber 1, quarry 1, mine 1, warehouse 1, barracks 0, harbor 0, wall 0                                                                      |
| Resources                | wood 600, stone 600, gold 400 (cap 1000)                                                                                                           |
| Units                    | 10 guards at home (population 10/62)                                                                                                               |
| Relations, queues, notes | none                                                                                                                                               |
| Protection               | No player can **launch** an `attack` before `t = 86400` (day 1 is for economy and diplomacy). Spying, support, shipments and founding are allowed. |
| New city (founded)       | hall 1, lumber 1, quarry 1, mine 1, warehouse 1, everything else 0; stock 500/500/500                                                              |

---

## 3. Resources, storage and population

| L   | w(L) | prod/h (‰1000) | warehouse cap | loot-protected | hall pop cap | base defense (hall) | wall bonus |
| --- | ---- | -------------- | ------------- | -------------- | ------------ | ------------------- | ---------- |
| 1   | 10   | 54             | 1000          | 100            | 62           | 70                  | +5%        |
| 2   | 16   | 86             | 1460          | 200            | 88           | 90                  | +10%       |
| 3   | 24   | 126            | 2040          | 300            | 118          | 110                 | +15%       |
| 4   | 34   | 174            | 2740          | 400            | 152          | 130                 | +20%       |
| 5   | 46   | 230            | 3560          | 500            | 190          | 150                 | +25%       |
| 6   | 60   | 294            | 4500          | 600            | 232          | 170                 | +30%       |
| 7   | 76   | 366            | 5560          | 700            | 278          | 190                 | +35%       |
| 8   | 94   | 446            | 6740          | 800            | 328          | 210                 | +40%       |
| 9   | 114  | 534            | 8040          | 900            | 382          | 230                 | +45%       |
| 10  | 136  | 630            | 9460          | 1000           | 440          | 250                 | +50%       |
| 11  | 160  | 734            | 11000         | 1100           | 502          | 270                 | –          |
| 12  | 186  | 846            | 12660         | 1200           | 568          | 290                 | –          |
| 13  | 214  | 966            | 14440         | 1300           | 638          | 310                 | –          |
| 14  | 244  | 1094           | 16340         | 1400           | 712          | 330                 | –          |
| 15  | 276  | 1230           | 18360         | 1500           | 790          | 350                 | –          |

Formulas:

- `w(L)=L²+3L+6`
- `prod(L)=30+20L+4L²`
- `cap(L)=1000+400(L−1)+60(L−1)²`
- `protect=100·warehouseLevel` per resource
- `pop(H)=40+20H+2H²`
- `baseDef(H)=50+20H`
- wall `+50‰/level`

**Production** of a resource per game hour: `rate = floor(prod(level of lumber|quarry|mine) × richness / 1000)`.

**Lazy accrual**:

- Store `S = stock × 3600` (resource·seconds).
- Over `[t0,t1]`: `S = min(cap·3600, S + rate·(t1−t0))`.
- Visible stock is `floor(S/3600)`.
- Spending or adding `x` changes S by `±3600x`. Every addition (refund, loot, shipment) is capped by the warehouse and the excess is lost; the event reports the loss.
- A city materializes its stock before any event or action that touches it, and before any change of rate or cap.
- This is exact and path-independent: rates are ≥ 0, and hall and warehouse never go down.

**Population:**

- `used(X)` = pop of every unit whose home is X (at home, stationed, moving or in a garrison) + pop of every unit in X's recruit queues.
- Recruiting requires `used + new ≤ pop(hall)`.
- Re-homing (founding or conquest) may push `used` over the cap. Recruiting in that city is then blocked until it drops.

---

## 4. Buildings

| id        | role          | max | base cost w/s/g | base time (s) | requires   | effect                                                   |
| --------- | ------------- | --- | --------------- | ------------- | ---------- | -------------------------------------------------------- |
| hall      | town centre   | 15  | 70/90/60        | 1500          | –          | pop cap, build speed, base defense                       |
| lumber    | wood          | 15  | 20/40/30        | 1050          | –          | wood production                                          |
| quarry    | stone         | 15  | 50/20/30        | 1050          | –          | stone production                                         |
| mine      | gold          | 15  | 50/50/10        | 1050          | –          | gold production                                          |
| warehouse | storage       | 15  | 50/60/20        | 900           | –          | cap, loot protection                                     |
| barracks  | land units    | 10  | 50/70/50        | 1500          | hall 2     | recruits guard/raider/settler; recruit speed             |
| harbor    | ships         | 10  | 100/60/60       | 2250          | hall 3     | recruits transport/warship; recruit speed; shipment size |
| wall      | fortification | 10  | 20/110/30       | 1500          | barracks 1 | +5%/level land defense; counter-espionage                |

**Formulas:**

- Cost of level L, per resource: `floor(base·w(L)/10)`.
- Duration: `floor(baseTime·w(L)/(9+H))`, where H is the completed hall level **at enqueue**.

Examples:

- lumber L2 at H1: 32/64/48, 1680 s.
- hall L5 at H4: 322/414/276, 5307 s.
- hall L10 at H9: 952/1224/816, 11333 s.
- hall L15 at H14: 1932/2484/1656, 18000 s.
- producer L15 at H15: 12075 s.

**Build queue:**

- One queue per city, up to **5 items**, processed one at a time.
- `build(city, building)` targets level = completed level + same-building items already queued + 1, and that level must be ≤ max.
- Requirements are checked against **completed** levels at enqueue.
- Cost is paid at enqueue. Duration is fixed at enqueue (later hall upgrades do not shorten it).
- An item starts when the previous one ends, or at enqueue if the queue is idle. The level applies at completion.
- **cancel_queue(item i):** cancels i and every later item of the same building.
  - Refund for a not-started item: 100%.
  - Refund for the active item: `floor(cost_r·remaining/duration)` per resource.
  - Refunds are capped by the warehouse. Later items move up and keep their durations.
- There is no demolition.

---

## 5. Units

| id        | domain | atk | def | land trip (s) | sea pace (s/tile) | carry | capacity | pop | cost w/s/g        | time (s) | built at / requires |
| --------- | ------ | --- | --- | ------------- | ----------------- | ----- | -------- | --- | ----------------- | -------- | ------------------- |
| guard     | land   | 5   | 20  | 4500          | –                 | 15    | –        | 1   | 30/70/40          | 300      | barracks 1          |
| raider    | land   | 22  | 6   | 3600          | –                 | 50    | –        | 1   | 60/30/90          | 330      | barracks 1          |
| settler   | land   | 0   | 0   | 5400          | –                 | 0     | –        | 25  | 2000/2000/3000 ×k | 10800    | barracks 3 + hall 5 |
| transport | naval  | 0   | 0   | –             | 50                | 0     | 25 pop   | 4   | 200/60/100        | 1200     | harbor 1            |
| warship   | naval  | 140 | 140 | –             | 40                | 0     | –        | 6   | 300/200/400       | 2400     | harbor 3            |

- Warships fight only in the naval phase. Land units fight only in the land phase.
- **Settler scaling:** `k = citiesOwned + settlersOwned` (alive anywhere, or queued). Cost per resource = `floor(base·(k+2)/3)`. With 1 city and no settler that is the base cost; k = 4 gives 4000/4000/6000; k = 10 gives 8000/8000/12000.
- **Recruitment:**
  - The barracks queue (guard, raider, settler) and the harbor queue (transport, warship) run in parallel. Each holds up to 5 batches of 1–500 units, run in sequence.
  - Time per unit: `u = floor(baseTime·10/(9+L))` with the building's completed level at enqueue (barracks L10 gives about ×0.53).
  - Cost and pop are reserved at enqueue.
- **Trickle:** a batch started at `s` has `done(t)=min(n, floor((t−s)/u))` units, which join home units lazily. A batch-end event fires at `s+n·u`.
- **Cancelling a batch** keeps completed units and refunds 100% of the rest (capped by the warehouse), freeing their pop.
- **Transport rule:** a movement between **different islands** needs `Σ pop(land units) ≤ Σ capacity(transports)`. This is checked only when it departs from home. Within an island, land units walk.

---

## 6. Movements

**Kinds:** `attack`, `support`, `spy`, `shipment`, `found`, `return`. Units always depart from their **home** city, never from a city where they are stationed.

**Travel time** (from island A to island B):

| case              | time                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| same island       | `max(3600, slowest landTrip among land units)`; a group with no land units (ships, spy, shipment) takes 3600        |
| different islands | `max(3600, 1200 + d·pace)`; pace = slowest seaPace among ships; spy 30; shipment 50; a return with no ships uses 50 |

Reference times (warship / transport / spy):

| d (tiles)            | warship | transport | spy   |
| -------------------- | ------- | --------- | ----- |
| 50                   | 3600    | 3700      | 3600  |
| 110 (backyard)       | 5600    | 6700      | 4500  |
| 121 (frontier)       | 6040    | 7250      | 4830  |
| 240 (neighbour home) | 10800   | 13200     | 8400  |
| 464                  | 19760   | 24400     | 15120 |

**Speed rule:** every movement takes at least 3600 s, so the fastest attack between two islands is always ≥ 1 game hour.

**Departure checks.** The gateway explains each failure and the engine re-checks:

- Common to every departure:
  - The origin is the player's own city and is not besieged.
  - The units are at home.
  - Transport capacity is sufficient.
- `attack`:
  - Allowed from `t ≥ 86400`.
  - The target is another player's city, or the player's own city while it is besieged (relief).
  - Attacking a city you are already besieging is rejected; send `support` instead.
  - The attack needs at least 1 unit with atk > 0.
  - Each attack records a **foe**: the besieger if the target is besieged at launch, otherwise the target's owner.
  - **Launching an attack immediately and publicly breaks any alliance or pact with the foe, even if the attack is later recalled.**
- `support`:
  - Any city may be supported. A besieged city may be supported only by its besieger.
  - The support records its **party**: the target's owner, or the besieger.
- `found`:
  - The target island has a free slot at departure.
  - The movement carries at least 1 settler and may carry escorts.
- `spy`: the target is not the player's own city, and `100 ≤ gold ≤ stock`.
- `shipment`:
  - Total load is between 1 and `1000+500·harbor(origin)`.
  - The origin city has no other shipment in flight.

**Recall (`recall_troops`):**

- An outbound attack, support or found movement can be recalled within **600 s** of departure, as a whole. It then arrives home at `now+(now−departAt)` (immediately if 0).
- Stationed supports and siege garrisons can be recalled at any time, fully or in part. The return takes normal travel time.
- Returns, spies and shipments cannot be recalled.

**Arrival resolution:**

| kind     | state at arrival                                      | result                                                                                                                            |
| -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| return   | home owned by mover, not besieged                     | units become home units; cargo added (capped)                                                                                     |
| return   | home besieged                                         | **homecoming battle** against the garrison (§7). If won: siege broken, units home, cargo added. If lost: all units and cargo lost |
| support  | target besieged by mover                              | joins the garrison                                                                                                                |
| support  | target owned by party, not besieged                   | stations there (home city unchanged)                                                                                              |
| support  | anything else                                         | bounces (returns with the outbound duration)                                                                                      |
| attack   | target besieged by foe                                | **relief battle** against the garrison                                                                                            |
| attack   | target owned by foe, not besieged                     | **city battle**                                                                                                                   |
| attack   | target besieged by mover                              | joins the garrison                                                                                                                |
| attack   | anything else (owner changed, someone else besieging) | bounces. An attack only ever fights its foe                                                                                       |
| spy      | always                                                | §9                                                                                                                                |
| shipment | always                                                | added to the stock of the current owner (capped)                                                                                  |
| found    | island has a free slot                                | new city in the lowest free slot; 1 settler consumed; other units re-homed to the new city                                        |
| found    | no free slot                                          | bounces                                                                                                                           |

**Homeless units:** when a city changes owner, every unit whose home is that city is removed at once, wherever it is: stationed, in a garrison or moving (the movement is deleted). When a player is eliminated, all their units and movements are removed.

**Same-second order:**

1. build completions
2. recruit batch ends
3. returns
4. supports
5. shipments
6. spies
7. attacks
8. founds
9. siege ends
10. pact and proposal expiries
11. domination countdown ends
12. match end

Within a class, events run in ascending movement or event id. The engine processes all events at second t, then the actions stamped t in log order. Every scheduled duration is ≥ 1 s.

---

## 7. Combat (deterministic)

**City battle participants:**

- Attacker side: the movement's units.
- Defender side: every unit present in the city, meaning the owner's home units plus all stationed supports.
- Units owned by the attacker that are stationed in the city **stand aside** and are unaffected.

**Naval phase** (only if the attack contains a ship):

- `AN = Σ atk of attacking ships`; `DN = Σ def of defending ships`.
- Land units are "aboard" only if the attack crossed between islands.
- If `DN = 0`, nothing happens.
- If `AN > DN`:
  - `f = lossPm(DN, AN)`, and casualties apply to every attacking ship type **and to the land units aboard**.
  - All defending ships are destroyed.
  - **Drowning:** if the land pop aboard exceeds the surviving transport capacity, remove land units in the order guard → raider → settler (each type `min(count, ceilDiv(excess,pop))`, then recompute) until they fit.
- If `AN ≤ DN`:
  - Every attacking unit, ships and land units aboard, is destroyed.
  - Defending ships take `casualties(n, lossPm(AN, DN))`.
  - The battle ends.
- An unescorted transport fleet is wiped out by any defending warship.

**Land phase** (if the attacker still has land units):

- `A = Σ atk of attacking land units`
- `D = floor((Σ def of defending land units + baseDef(hall)) × (1000 + 50·wall) / 1000)`
- If `A > D` (attacker wins):
  - Attacking land units take `casualties(n, lossPm(D, A))`.
  - **Every** defending unit is destroyed, including ships that did not fight.
  - **The wall drops 1 level** (minimum 0).
  - Then one of:
    - **Conquest attack** (it carried ≥ 1 settler at launch): no loot. If at least 1 settler survives, a **siege starts** (§8).
    - **Raid:** the attacker loots.
- If `A ≤ D` (defender wins; ties go to the defender):
  - All attacking land units die. Attacking ships survive and go home empty.
  - Defending land units take `casualties(n, lossPm(A, D))` per owner and per type.

**Loot:**

- `carry = Σ carry·surviving land units`.
- `lootable_r = max(0, stock_r − 100·warehouse)`, and `T = Σ lootable`.
- If `T ≤ carry`, take everything lootable. Otherwise `take_r = floor(lootable_r·carry/T)`; leftover capacity stays unused.
- Loot leaves the city immediately and is delivered when the survivors get home.

**Survivors** return home. Travel is computed for the surviving group.

**Garrison battles** (relief or homecoming) use the same phases, with the garrison as defender and `D = Σ def of garrison land units`. There is no base defense, no wall effect, no wall loss and no loot.

- A siege ends as soon as the garrison has **no settler left** (all units die when the attacker wins).
- Relief survivors return home. Homecoming survivors stay home.

**Battle points:**

- Every destroyed unit's pop is credited to the opposing side.
- The attacker side's credit goes to the attacker.
- The defender side's credit is split by each owner's contribution in that phase (ship def in the naval phase; land def in the land phase, with base defense credited to the city owner), floored per owner. The remainder is discarded.
- Drowned units credit nobody.

**Battle report** (`r#`) contents:

- time, city, island, attacker, foe/owner, kind (raid | conquest | naval | relief | homecoming)
- per phase:
  - strengths: AN/DN, or A plus the D components (Σdef, baseDef, wall level, wall ‰)
  - winner and loss ‰
  - per side, per owner, per unit type: before / lost / survived
  - drowned units
- wall before and after, loot per resource, siege started or broken, battle points credited
- **Recipients:** the attacker, the city owner (or the besieger, for a garrison battle) and every supporter involved.
- If no attacking unit survived, the attacker's copy shows only the outcome, the phase reached and its own losses. Defender details are redacted.

**Worked example** (all numbers checked):

- **Setup:** p2 sends 300 raiders, 12 transports and 6 warships at c5, 121 tiles away. Travel takes 7250 s.
- **Defenders at c5:** hall 8, wall 4, warehouse 7. The owner p4 has 80 guards, 10 raiders, 2 warships and 1 transport. Ally p6 supports with 40 guards. Stock is 5000/4000/3000.
- **Naval phase:**
  - AN 840 against DN 280 gives f = 192‰.
  - The attacker loses 1 warship, 2 transports and 58 raiders.
  - All defending ships are sunk.
  - 242 raiders fit in the 250 capacity of the 10 surviving transports, so none drown.
- **Land phase:**
  - A = 5324.
  - D = floor((1600 + 60 + 800 + 210) × 1200/1000) = 3204.
  - The attacker wins with f = 465‰: 113 raiders lost, 129 survive.
  - All 130 defending land units die. The wall goes from 4 to 3.
- **Loot:**
  - Carry is 6450; lootable is 4300/3300/2300.
  - Taken: 2801/2150/1498.
- **Battle points:**
  - p2 earns 146 (12 + 4 + 130).
  - p4 earns 72 (naval) + 79 (land).
  - p6 earns 33.

---

## 8. Sieges and conquest

| Step              | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start             | A conquest attack wins a city battle and at least 1 settler survives. The survivors, plus any stand-aside units of the attacker, form the **garrison**. Siege `{by, endsAt = t+21600}` (6 h). Public event.                                                                                                                                                                                                                                                                                                             |
| City during siege | The owner keeps ownership and production keeps accruing to the stock. At start, the city's build and recruit queues are cancelled with the normal refunds. The owner cannot build, recruit or send anything from the city.                                                                                                                                                                                                                                                                                              |
| Reinforcing       | `support` or `attack` from the besieger joins the garrison. Support from anyone else bounces.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Breaking          | Any relief or homecoming battle that leaves the garrison with 0 settlers. The besieger may also recall the garrison (partly or fully); losing the last settler that way ends the siege as "abandoned". The besieger's elimination also breaks it. Surviving garrison units go home. Public event.                                                                                                                                                                                                                       |
| Conquest          | At `endsAt` (class 9), if the garrison still has a settler: the owner becomes the besieger; 1 settler is consumed; the rest of the garrison is **re-homed** to the city. Buildings and stock are kept (the wall already lost its breach level). The old owner's units homed there are removed everywhere (§6). Pending movements follow the arrival table: the old owner's supports bounce, attacks aimed at the old owner bounce, shipments go to the new owner. Public event, then elimination and domination checks. |

Relief attacks never start a siege. Only an attack launched against the city's owner can.

---

## 9. Espionage

- `spy(fromCity, target, gold)`: `gold ≥ 100` is paid at departure. Travel uses pace 30.
- The spy is **invisible** to the target and cannot be recalled.
- **Counter-intel** = `100 + 50·wall + land pop present` (all owners, garrison included).
- **Success** if `gold > counter-intel` (ties go to the defender). The gold is spent either way.
- On success, the spy owner gets a report and the target is not told. The report contains:
  - building levels
  - stock (floored)
  - units present, by owner and role (home, support, garrison)
  - siege state
  - It does not include queues or units that are away.
- On failure:
  - The spy owner learns only that it failed.
  - The city owner gets a notice: spy owner, origin city and gold spent.
- Spying never breaks a relation.

---

## 10. Diplomacy (engine level, nothing binding)

| Item      | Rule                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messages  | `send_message(to[1..N−1], text ≤ 1000 chars)`. Delivered instantly; recipients see the full list (no BCC). At most **20 sends per seat per game day**.                                                                                                         |
| Proposals | `propose_alliance(to, kind: "alliance" \| "pact", text?)`. At most 3 open outgoing proposals per player; each expires after 12 h. `answer_proposal(id, accept)`. Caps are checked at acceptance; if one fails, the error explains and the proposal stays open. |
| Alliance  | Public pair relation. **Max 2 allies per player.** Accepting an alliance with a pact partner replaces the pact. Effect: shared intel (§11).                                                                                                                    |
| Pact      | Public non-aggression pair relation. **Max 2 pacts per player.** It **expires 48 h** after acceptance; proposing a pact to a current pact partner renews it. A pact cannot be proposed to an ally.                                                             |
| Leaving   | `leave_alliance(player)` ends the alliance or pact with that player immediately. Public event.                                                                                                                                                                 |
| Betrayal  | Launching an attack against an ally or pact partner (as foe) dissolves the relation at launch. Public event `betrayal{by, against, relation}`. It is never prevented.                                                                                          |
| Tribute   | `send_resources` (shipment, §6). Visible to the recipient and not public.                                                                                                                                                                                      |

**Public events:**

- relations formed, left, expired or betrayed
- cities founded or conquered
- sieges started, broken or abandoned
- battle headlines `{t, city, attacker, defender, kind, winner}` with no numbers
- eliminations
- domination countdown start or cancel
- match end

---

## 11. Visibility (fog of war)

| Information                                                                                                                                                           | Visible to                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Map: islands, coordinates, kind, richness, slots; every city's id, island, slot, owner, points and siege flag                                                         | everyone                                              |
| Players: score with all components, city count, relations (pacts with expiry), eliminations, domination countdowns, public events                                     | everyone                                              |
| Own cities in full: stock, rates, buildings, queues, pop, units present including foreign supports                                                                    | owner                                                 |
| Own units anywhere, own movements, own reports                                                                                                                        | owner                                                 |
| Incoming to own cities: **attack** (id, origin city and owner, arrival time; _no composition, no settler flag_), support (full), shipment (full). Spies are invisible | target owner                                          |
| Allies' cities: units present, and incoming attacks with the same fields as above                                                                                     | allies                                                |
| Foreign city details                                                                                                                                                  | only through a spy report (snapshot with a timestamp) |
| Battle and spy reports                                                                                                                                                | as in §7 and §9                                       |
| Messages and proposals                                                                                                                                                | sender and addressees only                            |
| Everything, including thoughts and private messages                                                                                                                   | spectators (outside the game)                         |

---

## 12. Points, leaderboard, victory

- **Score** = `Σ owned cities (100 + Σ building levels) + floor(battlePoints/10)`.
  - A new city is worth 105; a maxed city is worth 205.
  - Battle points are the cumulative pop the player destroyed (§7).
- **Leaderboard** (public): rank, player, score, cities, building points, battle points, relations, eliminated flag, domination progress.
- **Elimination:** a player with 0 cities is out at once. All their units, movements and garrisons are removed (their sieges break), their proposals are cancelled and their relations dissolve publicly. Their score freezes.

**Victory:**

1. **Domination.** A player owns `≥ max(N, ceilDiv(300·totalCities, 1000))` cities (30% of all existing cities, and at least N). This starts a public 24 h countdown.
   - The countdown is cancelled as soon as the condition fails.
   - At the countdown's end (class 11), if the condition still holds, that player wins and the match ends.
   - If several countdowns end in the same second, the order is: more cities, then higher score, then tie-break order.
2. **Last standing:** every other player has been eliminated.
3. **Time:** at `t = 604800`, after every other event of that second, the highest score wins.

**Final ranking:**

- The winner comes first.
- Survivors follow, ordered by score, then cities, then battle points, then tie-break order.
- Eliminated players come last, ordered by latest elimination first, then tie-break order.

---

## 13. Pacing and balance

Reference bot: economy first, settlers as soon as eligible, surplus spent on guards and raiders at 2:3, never fights. Exact rules, 60-second simulation step.

| Time                         | Typical player                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00                         | H1, producers L1 (54/h each), 10 guards                                                                                                                  |
| ~2:00 / 5:00 / 12:30 / 19:00 | hall 2 / barracks 1 / harbor 1 / hall 5                                                                                                                  |
| 24:00 (protection ends)      | H5, producers L6 (294/h), ~15 guards, ~8 raiders, 2 transports. A rush opener instead has ~30 raiders and 2 transports (wood and gold limited)           |
| first possible attack        | launched at 24:00; lands at the earliest at **25:00** (same island), ~26:00 (frontier colony) or **27:00–27:40** (neighbour home, warships / transports) |
| ~38:00                       | 1st settler (H6/B3); city 2 at ~42:00 (backyard ~1 h 52 by transport)                                                                                    |
| end of day 2                 | 2 cities; ~70 pop army (24 guards, 36 raiders); attack ~0.9k                                                                                             |
| end of day 3                 | 3 cities; ~160 pop; attack ~1.9k                                                                                                                         |
| end of day 4                 | 4 cities (**safe slots used up**); H10; ~370 pop (134 guards, 183 raiders, 11 transports); attack ~4.7k                                                  |
| end of day 5                 | 5 cities (**1st contested slot**); ~750 pop; attack ~10k                                                                                                 |
| end of day 6                 | 6 cities; ~1350 pop; attack ~18k                                                                                                                         |
| end of day 7                 | 6 cities, home H12; ~2100 pop (772 guards, 1140 raiders, 54 transports); attack ~29k                                                                     |

**Target defense for comparison:**

- Fresh colony (H1–3, wall 0, ≤ 10 guards): D ≤ 310.
- Day-4 colony (H6, wall 2, 40 guards): 1067.
- Day-4 home (H10, wall 3, 135 guards): 3392.
- Day-7 home (H12, wall 6, 400 guards + 100 raiders): 11557.
- A day-3 strike of 70 raiders (1540) against a fresh colony loses 9%. A day-4 army (4026) against a day-4 colony loses 13.6%, so conquest is viable from day 3 to 4.

**Why 7 days force contact:**

1. Only 3 safe slots per player, all filled by about day 3.5. The 5th and later cities must be founded on shared frontier or inner islands, on the center, or taken by conquest.
2. Score and domination are mostly about cities, at 100 points each.
3. Contested islands are richer (+10% to +50%) and only about 2 h away, which allows several strike cycles per day.
4. Fresh colonies are 5 to 8 times weaker than a day-3/4 army.
5. Each player has at most 4 relations, so with N ≥ 6 at least one neighbour has neither alliance nor pact. Pacts lapse every 48 h.

**Anti-turtle:**

- the wall loses a level on every lost land battle
- warehouse caps waste idle production (the reference home is full by day 7)
- richer contested islands
- battle points go to both sides
- cities make up most of the score
- pacts expire and relations are capped

**Anti-snowball:**

- settler cost grows with each city (×(k+2)/3)
- a domination win needs a public 24 h hold, which invites a coalition against the leader
- at most 2 allies
- 6 h sieges leave time to respond
- defenders earn battle points from failed attacks
- loot protection
- far-flung empires take a long time to defend (cross-map trips run 10–13 h)

**Known snowball risk:** a lost city's units are removed everywhere.

---

## 14. Tools and the rules they use

| Tool                                                                       | Rules                                                                                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `view_city`                                                                | own city: full §11; foreign city: public data + latest spy report                                   |
| `view_island`                                                              | island data, slots, cities                                                                          |
| `view_map(fromCity?)`                                                      | all islands and cities; with `fromCity`, also walk, transport, warship and spy times to each island |
| `view_player`                                                              | public profile, score breakdown, cities, relations                                                  |
| `leaderboard`                                                              | §12                                                                                                 |
| `rules`                                                                    | this config + derived per-level tables                                                              |
| `build` / `recruit` / `cancel_queue`                                       | §4, §5 (lists allowed in one call)                                                                  |
| `send_resources`                                                           | shipment §6                                                                                         |
| `attack`                                                                   | §6–8 (a settler in the attack means a conquest attempt)                                             |
| `support` / `recall_troops` / `found_city`                                 | §6, §8                                                                                              |
| `spy`                                                                      | §9                                                                                                  |
| `send_message` / `propose_alliance` / `answer_proposal` / `leave_alliance` | §10                                                                                                 |
| `write_note` / `read_notes`                                                | gateway notebook, 4000 characters                                                                   |
| `end_turn(nextWakeIn?)`                                                    | next wake in 600–43200 s                                                                            |

**Wake-ups** (gateway):

- **Urgent:** a new attack on one of your cities, a siege on your city, a lost city, a betrayal against you.
- **Normal:** a message or proposal, a queue running empty, a report, a self-scheduled wake, the 12 h safety wake.
- **Grouping:** events within 600 s are merged.
- **Budget:** 12 normal wakes per game day; urgent wakes are exempt.
- **Round trips:** 8 per wake.

---

## 15. Rules config sketch

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
type UnitId = "guard" | "raider" | "settler" | "transport" | "warship";
type IslandKind = "center" | "home" | "frontier" | "inner" | "backyard";
type Poly2 = { c0: number; c1: number; c2: number }; // c0 + c1·x + c2·x²

export interface RulesConfig {
  id: string; // "classic-1"; hash of canonical JSON stored per match
  time: {
    day: 86400;
    matchEnd: 604800;
    protectionEnd: 86400;
    minTravel: 3600;
    seaOverhead: 1200;
    recallWindow: 600;
    siegeDuration: 21600;
    dominationHold: 86400;
    proposalTtl: 43200;
    pactDuration: 172800;
  };
  map: {
    homeRadius: Record<number, number>; // {6:240,7:277,8:314,9:351,10:388,11:426,12:464}
    margin: 180;
    innerOffset: -120;
    backyardOffset: 110;
    centerRingRadius: 70;
    centerRingMaxPlayers: 7;
    jitter: { radius: 10; degrees: 2 };
    islands: Record<IslandKind, { slots: number; richnessPm: number }>; // center single: 2 + floor(N/2)
    cos10k: readonly number[];
  }; // 360 committed ints
  start: {
    buildings: Record<BuildingId, number>;
    resources: Res;
    units: Partial<Record<UnitId, number>>;
  };
  newCity: { buildings: Record<BuildingId, number>; resources: Res };
  economy: {
    resourceScale: 3600;
    production: Poly2 /*30,20,4*/;
    warehouseCap: Poly2 /*in L-1: 1000,400,60*/;
    lootProtectPerLevel: 100;
    popCap: Poly2 /*40,20,2*/;
    baseDefense: Poly2 /*50,20,0*/;
    shipment: { base: 1000; perHarborLevel: 500; maxInFlightPerCity: 1; seaPace: 50 };
  };
  levelWeight: Poly2 & { div: 10 }; // w(L)=L²+3L+6
  buildTimeOffset: 9;
  recruitTimeOffset: 9; // /(9+H), ·10/(9+L)
  queues: { buildMax: 5; recruitBatchesMax: 5; batchMaxUnits: 500 };
  buildings: Record<
    BuildingId,
    { max: number; cost: Res; time: number; requires: Partial<Record<BuildingId, number>> }
  >;
  units: Record<
    UnitId,
    {
      domain: "land" | "naval";
      atk: number;
      def: number;
      landTrip?: number;
      seaPace?: number;
      carry: number;
      capacity: number;
      pop: number;
      cost: Res;
      time: number;
      at: "barracks" | "harbor";
      requires: Partial<Record<BuildingId, number>>;
    }
  >;
  settlerScaling: { offset: 2; div: 3 };
  combat: { wallPmPerLevel: 50; wallBreachOnLoss: 1; drownOrder: UnitId[] };
  spy: { minGold: 100; seaPace: 30; counterBase: 100; counterPerWall: 50; counterPerLandPop: 1 };
  diplomacy: {
    maxAllies: 2;
    maxPacts: 2;
    maxOpenProposals: 3;
    messagesPerDay: 20;
    messageMaxChars: 1000;
    publicBattleHeadlines: true;
  };
  scoring: { cityBase: 100; perBuildingLevel: 1; battlePopPerPoint: 10 };
  victory: { dominationPm: 300; dominationMinCitiesPerPlayerCount: 1 }; // threshold = max(N·1, ceil(300·total/1000))
  gateway: {
    roundTripsPerWake: 8;
    safetyWake: 43200;
    wakeBudgetPerDay: 12;
    wakeGroupWindow: 600;
    scheduledWakeMin: 600;
    scheduledWakeMax: 43200;
    notesMaxChars: 4000;
  };
}
```

The `rules` tool returns this object plus derived tables (cost, time, production and capacity per level). Change numbers between matches only.
