# Judgments of the phase-1 ruleset candidates

Three judges, one lens each, scored the three candidates. The synthesis that became `perfidia-1` used these.

## Lens: balance

**Best:** Design 2: Lean Ring. On the legibility and implementability lens it wins clearly. About ten one-line formulas cover the game, the map is a Manhattan ring with no trig, recruit orders complete in one event, there is no siege and no elimination, and every number I checked is exact, including the exhaustive 43-cell claim. It needs a handful of targeted fixes. The biggest is the undefined case where the attacker's own stationed troops sit in the target city. Fixes can be grafted mostly from D1 (stand-aside rule, tie-break stream, base defense) and D3 (lockstep ordering formula, dismiss, build lists).

### Design 1: Archipelago Classic (classic-1) — 6/10

Strengths:

- Every number I re-checked is exact. Worked example: naval f=192 gives losses 1/2/58, D=3204, land f=465 gives 113 lost, loot 2801/2150/1498, battle points 146/72+79/33. Target defenses 310/1067/3392/11557 and loss rates 90 and 136 per mille are also correct.
- I re-ran the map fairness claim over 1500 jitter samples per N: minimum island separation is exactly 50, and the nearest-8 spread is at most 10 (worst cases N=7 and N=11, caused by floor(360k/N) rounding). Islands 30-49 and slots 66-116 fit the brief.
- Closed-form polynomial formulas: w(L)=L^2+3L+6, prod=30+20L+4L^2, pop=40+20H+2H^2, cost=base*w(L)/10. An LLM can compute any level from the formulas.
- Strong determinism scaffolding: canonical orders for resources, buildings and units; named PRNG streams (FNV-1a of seed:stream), so map changes do not shift other randomness; a public tiebreak shuffle; ids never reused; 12 explicit same-second classes.
- Edge cases are spelled out: units the attacker has stationed in the target stand aside, the foe is fixed at launch, and drowning order and capacity recompute are given. lossPm(0,x)=0 covers D=0 garrisons, casualties never exceed n, and the attacker's report is redacted when no attacker survives.
- Matches the brief exactly: 8 buildings, 5 units, the 22 tools mapped one to one, build lists allowed in one call, and view_map(fromCity) returns precomputed travel times.

Weaknesses:

- Too many concepts for phase 1. The 6 h siege alone brings a garrison location, relief and homecoming battles, foe/party bookkeeping, a 6-row bounce table, partial garrison recall, 'abandoned' sieges and refunds on cancelled queues. That roughly doubles the combat and arrival code paths.
- Recruitment trickles in (done(t) counted lazily), so home units must be materialized before every read. That is a second lazy-accrual system next to the resource one.
- The loss curve lossPm (about x^1.5 via isqrt at per-mille resolution) cannot be computed exactly in an LLM's head. Euclidean isqrt distances need tool support.
- Same-second action ordering is only described as '(seeded)', with no algorithm. Lockstep runs are therefore not reproducible from seed + bots alone, only from the log.
- Internal contradiction: 'Every scheduled duration is >= 1 s', but a recall at 0 elapsed seconds 'arrives home immediately'.
- The 360-entry committed cos table plus polar placement and rdiv is more machinery than needed for a symmetric map.
- Some state hidden behind diplomacy rules: pacts expire after 48 h with renewal semantics, separate caps of 2 allies and 2 pacts, and caps checked at acceptance. Battle points split pro-rata by def contribution with discarded remainders.
- The 24 h attack protection takes 1/7 of the match. The pacing table comes from a bot that never fights.

### Design 2: Lean Ring (lean-ring/1) — 8/10

Strengths:

- The fewest concepts by far. One travel formula (3600+600*d), one cost formula (50L wood + 50L stone, 900L s), and linear production, storage and pop, plus the square law. The whole game fits in the cheat sheet, and an LLM can do all of it in its head.
- The map is trivial to implement and to reason about: Manhattan distance on a wrapping 10n x 10 ring, no trig table and no isqrt. Translation symmetry makes it exactly fair, and the rich border island is equidistant from both neighbours by construction.
- Claims verified: islands 30-50 and slots 42-72 fit the brief. I re-ran the '>= 43 valid cells' placement claim exhaustively and the minimum is exactly 43, so the fallback scan can never fail. All crossings are >= 3 tiles, i.e. >= 1 h 30.
- Worked example exact: q(100,200)=250 gives 1 warship lost, D=3510, q=342 gives 103 raiders lost, and the ascending water-fill loot is 600/1500/1840. The rush check also holds: 15 raiders vs 10 guards lose 7 and carry 160.
- Smallest phase-1 implementation. Recruit orders complete all at once (one event, no trickle), queue cancels are tail-only so end times never move, there is no siege, no elimination (capitals immune), no protection window and no spy-success maths.
- Event key (time, class, seq) uses a global seq assigned at scheduling, which gives deterministic 'trains' and lets support landing in the same second defend. Integer bounds are stated (ticks < 2^31).
- Errors are data with numbers, the bounds are explicit, and every knob lives in config.

Weaknesses:

- Real hole: the defending side is 'every stationed group in C', with no rule for the attacker's own group stationed there. Its troops would fight themselves. The host also cannot dismiss stationed groups, so you can park troops in an enemy city.
- Final ranking ends in a 'shared rank', so there is no deterministic single winner on a full tie.
- Lockstep ordering is 'shuffle seeded with mulberry32(seed ^ t)', but neither the base seat order nor the shuffle routine is stated.
- build(city, building, levels) takes one building per call. That goes against brief principle 4 ('queue these 3 buildings').
- Shipments auto-assign transports at 1000 resources each, and it is unclear whether a same-island shipment needs them. This couples trade to ship units for no legibility gain.
- Cities with no units have D=0 and fall to a lone settler (A=0), so 'D=0 means attacker wins' is a special case. The square-law exact tie (q=1000) annihilates both sides, which is surprising for agents.
- Pacts have no mechanical or recorded effect and attacks are never announced, so agents get no betrayal signal from the engine. Spies are always detected, which may kill spying.
- Small config inconsistency: section 17 names `wallPercent`, while the config uses `defensePercentPerLevel`. Pacing comes from a rough no-fight sim.

### Design 3: Ring & Crown (ring-crown 1.0) — 5/10

Strengths:

- Best spec of same-second ordering: the batch is sorted by (h, playerIndex) with h = first output of mulberry32(seed ^ imul(t,0x9E3779B1) ^ playerIndex), each player's own submission order is kept, and the result is logged. Final ranking ties go to player index ascending.
- Worked examples are all exact: ppm values 214501, 68040, 900332, 494105 and 353553; D=430, 13986, 9450 and 9050; the loss counts; the recurrence tables (hall L10 2215/2215/1475 and 28623 s; the per-building sums and 151 h).
- Map separation >= 2 tiles holds (I re-checked across jitters). The 91-entry sin table with quadrant symmetry is smaller than D1's.
- Useful explicit rules: the attacker's own stationed units abstain, foreign stationed units can be dismissed, recall within 900 s drops the attack from the target's view, betrayal fires a public event, and errors are returned as data.

Weaknesses:

- Not formula-driven. Building costs are an iterated floor(x*1.35) recurrence and production, warehouse and pop are arbitrary 11-entry tables, so an LLM cannot compute a level without the rules tool.
- Concept count is the highest of the three per rule area: 6 units including the ram, a neutral Crown city (null owner in every code path), 12 hubs, morale based on live scores, renown with day multipliers, refund tiers (100/80/50 with a 600 s grace), cancel cascades that re-check requirements, alliance join with a rejoin cooldown, a 3-way owner-changed rule, capital immunity plus attack protection, and trickle recruitment.
- Morale depends on live scores, which include renown, so agents cannot predict a battle outcome from the units they see.
- The hub fairness claim is understated. I measured the nearest-hub spread between seats at up to 2.36 tiles (about 24 transport-minutes), not '<= ~1 tile'. It is unfair for any N other than 12.
- Pacing is inconsistent with its own rate. 4N+12 free sites at 0.8 settlers per player per day is 5+15/N days, about 6.9 days at N=8, not 'exhausted H120-144'.
- Contradiction: 'captured cities start ungarrisoned' while the capture survivors 'stay stationed in C'.
- The gateway's urgentMinGapSec=1800 contradicts the brief ('an urgent one ... wakes it again as soon as the turn ends'). It also adds caps the brief does not ask for: a 5-recipient limit, 4 public messages per day, 6 proposals per day, 40 attacks per day.
- randInt uses modulo, which is deterministic but biased. Events at t >= T never resolve, so an attack landing at exactly 604800 silently vanishes.

**Grafts:**

- From D1/D3: units owned by the attacker that are stationed in the target stand aside (do not fight, unharmed). This fills D2's biggest hole.
- From D3: the host can dismiss foreign stationed groups through recall_troops (they travel home). This closes D2's 'park troops in an enemy city' problem.
- From D3: the exact lockstep same-second ordering, sorting by (h, playerIndex) with h = mulberry32(seed ^ imul(t,0x9E3779B1) ^ playerIndex), keeping each player's submission order and logging the result. Make the clock driver's ordering reproducible from seed + bots, not only from the log.
- From D1: named PRNG streams via FNV-1a(`${seed}:${stream}`) (map, seats, tiebreak, lockstep), so adding a draw in one place never shifts another. Also a public seeded tiebreak order of players, used for final ranking and any simultaneous win.
- From D1: canonical iteration orders (resources, buildings, units, ids ascending) stated once and applied to every loop, tie-break and display.
- From D1/D3: a small flat base defense per city (D3's constant 50, or D1's 50+20*hall). This removes the D=0 special case and the free claim-jump by a lone settler, at the cost of one constant.
- From D1/D3: build(city, buildings[]) accepts a list (brief principle 4). Recruit should also accept several orders in one call.
- From D1/D3: shipments carry no units. Cap a city's resources in flight at base + perHarborLevel*harbor and use the same travel formula. Drop D2's auto-assigned transports.
- From D1/D3: a public `betrayal{by, against, relation}` event when a player attacks an ally or pact partner, without preventing the attack. It gives agents and spectators an engine-recorded fact at near-zero cost. Fire it at launch (D1), which is simpler than at resolution.
- From D3: a short recall window for attacks (600-900 s, return time = now + elapsed, at least 1 s), with the target's incoming view dropping the attack. This forgives LLM mistakes. Any wake already sent stays sent, and the gateway's urgent-wake grouping handles spam.
- From D3: make capital immunity a config value with an end time (e.g. capitalImmuneUntil = end of day 3) instead of permanent. That brings back late-game stakes and elimination without new mechanics.
- From D1: the attacker's battle report is redacted when no attacking unit survives (only outcome, phase reached and own losses). Also public battle headlines without numbers, as an optional config flag.
- From D1: view_map(fromCity) and view_island return precomputed travel times. That is cheap in the gateway even with D2's mental-math formula.
- From D1: validation hints for affordability ('available in X game-min', from ceilDiv((X*3600 - ticks), rate)). D2 already has this; keep it as the canonical error hint.

**Must fix:**

- Define exactly who fights in a city battle: the owner's home units plus stationed groups not owned by the attacker. The attacker's own stationed units stand aside. Say what happens to every party's ships in a same-island attack, where no naval phase runs.
- Give a fully deterministic tie-break for every ordering. Same-second events use (time, class, seq), with seq assigned at scheduling. Same-second actions in lockstep use a stated formula from seed, t and player index, with the base order and shuffle routine named. Final ranking and simultaneous domination use a seeded public tiebreak order. A 'shared rank' must not be allowed for the winner.
- Decide whether events at exactly t = 604800 resolve: resolve all events of that second, then end (D1/D2), or drop events at t >= T (D3). State it once.
- Every scheduled duration must be >= 1 s, including recall of a movement at 0 elapsed seconds. D1 contradicts itself here.
- The wake-up policy must match the brief. An urgent event wakes the seat as soon as its current turn ends, so no urgent minimum gap (D3's 1800 s violates this) unless the brief is changed. Group events within a stated window, keep a per-day budget for non-urgent wakes, a 12 h safety wake, and 8 round trips per wake.
- The tool surface must be exactly the 22 tools in the brief, with high-level arguments: build and recruit take lists, recall_troops covers in-transit recall, stationed recall and dismiss, and leave_alliance covers pacts. Document every overloaded mode in the Zod schema.
- Spell out the owner-change rule completely: movements to a city whose owner changed, units homed in a lost city, in-flight loot and cargo, stationed foreign ships, and queues (cleared, with or without refund). Each case needs exactly one outcome.
- Avoid D=0 and W=0 special cases, for example with a flat base defense. Make sure loss rounding can never remove more units than exist. Document the square-law exact tie (q=1000, mutual wipe-out), or switch ties to 'attacker dies, defender loses q(A,D)<1000'.
- Specify shipments without transport units, or say explicitly whether a same-island shipment needs transports. Specify what happens to warehouse overflow on arrival (lost and reported).
- Make the settler cost fit the warehouse: either state the warehouse-level requirement explicitly in the error hint (D2 does), or cap N-scaling so the cost never exceeds the reachable storage.
- State integer bounds for every product (ticks, combat sums, loot and loss numerators) and keep them below 2^53. The loss function must use only integer ops (prefer D2's r*r/1000 over the isqrt-based x^1.5 for LLM computability).
- Mark every pacing table in all three designs as an unverified target: none came from fighting bots. The phase-1 sim must measure cities, army pop and free-slot exhaustion by day, with knobs for production, build time, settler cost and slots.
- Map generation must use no floating-point trig at runtime. Use D2's grid ring, or a committed integer table. State the fairness property and add a CI property test for it with fast-check over seeds and N=6..12.
- Make the betrayal or relation record explicit (at least a public event when an ally or pact partner is attacked). Without it, 'pact' is a label with no engine-visible consequence.
- If capitals stay immune, the domination threshold (alliance > 50% of all cities) must stay reachable under the alliance size cap at N=12, or immunity should expire on a configured day.

## Lens: drama

**Best:** Design 3, Ring & Crown. It is the only design whose geometry forces contact on day 1 (a frontier 1.5 h from both neighbours, attacks from H12) and whose map has a late-game focal point that pulls everyone in: the hub cluster plus a neutral Crown worth about 740 points to its captor. Its betrayal mechanics best fit the lens: full shared vision until the attack lands, abstaining trojan support, immediate capture, an individual-only win, and a public betrayal that fires on impact, which keeps the fake/bluff window open. It has eliminations after day 2 and rams that break turtles. It needs three hard fixes before it is final: a domination hold countdown instead of an instant win, collusion-proof renown, and a rescue window after an attack lands.

### Design 3: Ring & Crown (rules v1.0) — 7/10

Strengths:

- Contact on day 1 comes from the geometry. Each 2-site frontier is 1.5 h from both neighbours, settlers arrive at H5-8, attacks open at H12 and land at H13.5 (colonies) or H15 (capitals). First blood lands in the first real-time evening of the show.
- It has the best focal points. The 12 single-site x1.25 hubs sit about 3.6 tiles apart at N=6, so the centre becomes a cluster of constant 1 h skirmishes. The neutral Crown is worth about 740 points to the captor (550 city points + about 190 renown for 380 garrison pop) plus 3000/3000/3000 loot, and its garrison never regenerates. That produces soften-then-snipe vultures and 'you soften it, I'll take it' alliance betrayals. Example: a 300-raider softening wave kills about 60% of the garrison, then a 200-raider wave carrying a settler wins. That second wave can still lose its settler (795k ppm rounds to 1 dead settler), which is the kind of moment spectators remember.
- Betrayal is the most tempting and best rewarded of the three designs. The ally keeps full shared vision (stock, queues, troops) until the attack lands, its own stationed troops abstain (trojan support), capture is immediate, and only one player can win. The public betrayal fires when the attack lands, not at launch. The victim therefore watches an incoming attack from an ally with no composition shown, and the 'it's a fake, I'll recall within 900 s' bluff plays out in front of everyone.
- Anti-turtle measures bite. Every 4 rams cancel 1 wall level (the day-4 example drops from -450 raiders to -247). Only 15% of stock is hidden, building points are capped, and the build queue is time-bound (about 110 h to max a city).
- Comebacks are built in: morale floor of 50%, the settler price resets at 1 city, and capitals are immune only until the end of day 2. After that capitals fall and players are eliminated, so there are real stakes.
- Public battle notices and the 'all' channel give third parties what they need to form coalitions. The gateway also counters fake-attack spam: 40 launches per day and at least 1800 s between urgent wakes.
- I re-derived every worked example and all of them are exact: 214501 ppm / -9 raiders; 68040 ppm / -1 raider + capture; 900334 ppm / -450; 494105 ppm / -247 raiders / -12 rams; Crown 18100 vs 9050 at 353553 ppm with the settler surviving.

Weaknesses:

- Domination is instant, with no hold period, and the threshold drops at each day start (50 -> 45 -> 40 -> 35%). A match can end at 00:00 of a day with no warning window and no coalition counter-play.
- Renown can be farmed to pick the winner. On day 7 a defender earns 1 point per attacking pop killed (500 x 2000 / 10^6). An ally who throws away a 2000-3000 pop army, which is worth nothing at the final snapshot anyway, hands over 2000-3000 points. That matches or beats the design's own winner estimate of 2000-2600.
- There is no rescue window after an attack lands. Warnings are 1-1.5 h on the frontier, agents wake about 7 times per game day, allies get no urgent wake, and support needs at least 1 h of travel. Calls for help will almost never arrive in time, so a city falls suddenly instead of in a suspenseful way.
- The day-7 renown x2 lets one battle outweigh an empire. A score of 100 + 5 per building level + renown + Crown bonus is also harder to read in one minute than a city count.
- The pacing claims don't add up. Taking the Crown at H96 needs about 822 pop from ONE city (600 raiders + 60 ram pop + 10 settler + 84 warship + 68 transport), while the design's own estimate is 400-600 troops in total per player. Free sites (4N+12, so 36-60) at about 0.8 settlers per player per day run out around days 6.5-7.5, not days 5-6. 'Turtle with 2 maxed cities ≈ 700-900' contradicts the 500-point cap per city (2 maxed cities = 1000).
- The mechanics pile up: morale, rams, renown day multipliers, hideout, three refund tiers, cascade cancels, same-second trains and hub asymmetry. At about 7 wakes per day, LLMs will leave much of it unused or misuse it.
- Hubs have 12-fold symmetry, so for N=7, 9, 10 and 11 hub distances are slightly unfair (up to about 1 tile).

### Design 1: Archipelago Classic (classic-1) — 6/10

Strengths:

- The 6 h public siege is the strongest set piece of all three designs. It starts with a public event. Relief battles fight a garrison of mostly raiders (def 6, no wall or base defence), so a modest relief force can break it. Away units can come home and fight a homecoming battle. Third parties can break a siege but not steal the city. Together these create 'save c12' story arcs that need allies.
- Domination requires max(N, 30% of cities) and a public 24 h countdown that is cancelled if the condition fails. This gives a built-in 'everyone against the leader' endgame window.
- Public battle headlines (no numbers) and public betrayal events give agents reputation data to reason about. Pacts expire after 48 h, which creates recurring renewal moments.
- The trojan play exists. The attacker's stationed supports stand aside during the battle and then join the siege garrison.
- For N>=8 the single centre island (6-8 slots, x1.5) puts many cities on one island, so it becomes a king-of-the-hill brawl with 1 h land attacks.
- The numbers can be trusted. I re-derived the worked example (192‰, D=3204, 465‰, 129 survivors, loot 2801/2150/1498, battle points 146 / 72+79 / 33) and the 9% and 13.6% pacing losses, and all are exact.

Weaknesses:

- The tempo is the slowest of the three. There is a 24 h no-attack window, and the first settler only arrives at about 38 h: it costs 3000 gold, gold is the binding resource, and it needs warehouse 5. Day 1 is pure chat. The first realistic battle is about 27-28 h, on a neighbour's capital, with about 30 raiders. At 2-3 game hours per real hour, spectators get 8-12 real hours with nothing physical happening.
- Slot scarcity never bites. The reference bot ends at 6 cities. At N=6 that uses 36 of 66 slots (30 still free at the end of the match); at N=12 it uses 72 of 116 (44 free). The design's own table puts the first contested slot at the end of day 5, which contradicts the pitch's 'safe slots full by about day 3.5'.
- Argument #5 for forced contact is false. Each ring seat has only 2 neighbours and can hold 4 relations (2 allies + 2 pacts), so both neighbours can be covered.
- The relation breaks automatically and publicly when the attack is launched. That removes the 'it's a fake' bluff, and the victim gets a public betrayal flag plus an urgent wake for the whole 2-3.7 h flight. Betrayal is announced up front and never comes as a surprise, so it pays off less.
- Alliances are pair relations capped at 2, with no named blocs, so alliance wars are hard to read on the leaderboard. Ally intel is limited to units present and incoming attacks.
- A host cannot dismiss foreign supports, so a suspected trojan ally cannot be expelled.
- Defender battle points (pop/10) can still be fed by colluding seats: a 2100-pop suicide gives 210 points, about 2 cities.
- The economy is slow (6 cities by day 7) and garrisons are cheap to break, so sieges may often fail and actual conquests may be rare.

### Design 2: Lean Ring (lean-ring/1) — 4/10

Strengths:

- Contact is the fastest of the three. There is no protection window, and the 2nd city arrives at about 3:30 (settler 1000/1000/1000, plus a 1 h walk). A double-yield border island with 2 slots sits exactly between neighbours, 1 h 50 to 2 h 30 from each, and is raced for on day 1. Cities on the same island fight by land in 1 h.
- The maths is the simplest of the three (T = 1 h + 10 min per tile, losses = (L/W)²). LLM attention goes to diplomacy, which fits the brief's 'depth from interactions'.
- A city is capped at 100 points and 1000 pop. A turtle plateaus by day 4-5, and conquering a developed city swings ±100 points against 25 for founding one.
- There is a public 'all' channel but no public battle feed, so rumours and lies spread through messages. That is good for comparing which model lies best.
- The worked example checks out (q=250, D=3510, q=342 -> 103 lost, loot 600/1500/1840).

Weaknesses:

- Capitals can never be conquered. Nobody is eliminated, there are no sieges of capitals and no last stands, and a beaten player can sit in its capital and raid for the rest of the match. This removes the biggest climaxes a spectator could see.
- The map is a ring with 2 neighbours each and no centre or focal prize. At n=12 the opposite seat is 11 h away, so the match plays out as n parallel local feuds on a predictable layout. There are no world-scale alliance wars.
- Shared domination is a hollow incentive. The alliance cap is 2 for n<=8, so a pair needs more than 50% of about 42-56 cities, that is 22-29 cities. That is out of reach. The premise that alliances pay off through domination, and the shared-versus-individual tension behind late betrayal, mostly disappear.
- Betrayal is badly modelled. There is no stand-aside rule, so your own stationed support defends against your own attack. Shared vision shows allies your movements in full, so attacking while still allied reveals your composition. Nothing breaks automatically and battles are not public, so third parties cannot learn about wars or betrayals except through messages.
- Pacts have no mechanical effect. Spies are always detected and named, so covert intel and perfect-information betrayal setups disappear.
- Capture is instant and every unit moves at one speed. There is no rescue window, and no contrast between fast raids and slow assaults.
- A lone settler (A=0) conquers any empty non-capital city, because the attacker wins when D=0 and there is no base defence. Claim-jumping is very swingy.
- The pacing claim contradicts the design's own sim. It says free slots are gone by days 3-5, but 7 cities (all 6 free slots per seat) are only reached on day 7.

**Grafts:**

- From D1: replace instant capture with a short public siege or occupation (3-4 h on D3's tighter map; D1 uses 6 h). Keep D1's relief battles against the garrison, its homecoming battles, and the rule that third parties can break a siege but not steal the city. This creates 'save cX' arcs where allies matter.
- From D1: domination at max(N, X% of all cities) with a public 24 h countdown, cancelled as soon as the condition fails, plus D1's tie order. Use it in place of D3's instant win with falling thresholds.
- From D1: pacts expire by default (48 h) and are renewed by re-proposing, so diplomacy has recurring moments. D3's pactUntil field can stay as an option.
- From D1: score kill rewards at a small scale (D1 uses pop/10), with the defender's credit split by contribution. Prefer this to D3's large renown with a x2 day multiplier.
- From D1: spy counter-intel that also counts land pop present, and on failure the target is told the origin city and the gold spent.
- From D1: the committed integer trig table, the fairness-check script and fully worked numeric examples, reused as engine acceptance tests in phase 1.
- From D2: a one-screen cheat sheet returned verbatim by `rules`, with mental-math forms (travel ≈ 1 h + k min per tile, a small loss-ratio table), so LLMs can reason without computing isqrt.
- From D2: make D3's frontier island double-yield, exactly equidistant from both neighbours, as the explicit day-1 race object.
- From D2: per-city caps on points and army so a turtle visibly plateaus and the leaderboard stays readable.
- From D2: tail-cancel of queues (cancelling an item also cancels everything after it, so remaining end times never move), and public 'all' messages that count once against the daily cap.

**Must fix:**

- Domination must need a public, cancellable hold countdown (12-24 h). It must never be an instant win, and never one triggered by a threshold dropping at a day boundary (D3).
- Points for kills (renown or battle points) must not be farmable by collusion. Give defenders no day multiplier, give no credit for battles between seats that were allied or in a pact within the last 24 h, and cap kill points at about 20-25% of total score. In D3, a 2000-3000 pop suicide on day 7 currently hands an ally 2000-3000 points.
- Defenders and allies need a real counter-move after a winning attack lands: either a public siege window, or a wake for allies when an attack heads for a member's city. Check this against the 12 normal wakes per day and the 1-1.5 h minimum warnings. As things stand, D3's calls for help almost never arrive in time.
- Phase-1 sims must show that free-slot scarcity bites by about day 4-5. D1 leaves 30-44 slots free on day 7; D3 runs out only around days 6.5-7.5. Tune free sites per player (about 4-5) or settler speed.
- Physical contact and first blood must happen on game day 1 (protection of 12 h or less). Avoid D1's dead zone of 24 h protection plus a first settler at 38 h, which is 8-12 real hours of chat only.
- Capitals must become conquerable after a short early immunity. Eliminations and last stands are core drama, and D2's permanent immunity kills them.
- Specify the attacker's own stationed units: they abstain, never defend against their owner, and may join the captor. Let the host dismiss foreign supports. D2 has its own troops defending against its own attack; D1 has no dismiss.
- Record betrayal publicly when the attack lands, not at launch (D1), so the 'it's a fake' bluff survives. Publish battle headlines without numbers so third parties can track wars and reputations (D2 has none).
- Alliances should be named, capped blocs (max(2, floor(N/3))) so the leaderboard shows alliance wars. D1's pair relations capped at 2 can't be read in one minute.
- Units being erased when their home city is captured, combined with instant capture, can delete an army with no time to respond. Keep this rule only if there is a siege or occupation window, or re-home the survivors.
- Reconcile every pacing claim with the phase-1 bot sims: the D3 Crown at H96 needs about 822 pop from one city while players have 400-600 troops in total; D3's '2 maxed cities ≈ 700-900' contradicts the 500-point cap per city; D1 says day 3.5 in the pitch but day 4 in its table; D2 says slots run out on days 3-5 but its sim only gets there on day 7.
- Hold the rules to a complexity budget that an LLM waking about 7 times per game day can use. Every mechanic must fit on the cheat sheet. If bots show morale, hideout or the three refund tiers going unused, cut or simplify them.
- Keep the caps on fake-attack spam (launches per day, minimum gap between urgent wakes), but every briefing must still list all incoming attacks, so the minimum gap can never hide a real one.

## Lens: legibility

**Best:** Design 1, Archipelago Classic (classic-1), as the base. It is the most numerically coherent: every worked example and defense target re-computes exactly. It has the fewest exploitable degenerate strategies. Its 6h public siege gives the best attacker/defender counterplay, and it has working anti-turtle levers (wall breach on loss, spy counter-intel that scales with pop). Its main faults are calibration problems, not structural ones: too many slots, a possible peace ring, and negligible battle points. Design 3 has more depth and pressure, but it carries a structural kingmaking exploit (renown ×2 on day 7 plus army dumping), wall-voiding rams and instant domination. Design 2 is defense-locked (immune capitals, ×2 wall, no combined attacks) and its economy is trivial (payback in L hours).

### Design 1: Archipelago Classic (classic-1) — 7/10

Strengths:

- Numbers hold up. I re-ran every worked example and they all match: naval lossPm(280,840)=192‰ giving -1 warship, -2 transports and -58 raiders; land lossPm(3204,5324)=465‰ giving -113 raiders; the loot split 2801/2150/1498; battle points 146/72+79/33. The section 13 defense targets also match (310/1067/3392/11557), as do the 9% and 13.6% loss claims.
- The economy has real trade-offs. Gold is the binding resource: settlers cost 3000×(k+2)/3 gold and raiders 90. Producer payback rises from about 8h at L6 to 18h at L15, which gives diminishing returns. Warehouse caps gate settlers implicitly: the 1st settler needs warehouse 5 (3560 ≥ 3000 gold) and the 6th needs warehouse 9 (7000 gold).
- The 6h public siege is the best counterplay mechanic of the three. The defender, allies and the owner's returning army (homecoming) all get a move, which creates help-call and coalition moments without instant snowball.
- Anti-turtle levers that actually bite: the wall loses 1 level on every lost land battle, spy counter-intel scales with land pop present (a 1000-pop city needs a spy of more than 1600 gold), and pacts lapse after 48h.
- Naval/land sequencing (clear the harbour, then land in the same-second attack train) rewards scouting and coordination. A maxed fortress (H15, wall 10, 790 guards, D=24225) cannot be cracked by a single city (max about 681 raiders, A=14982), but two full-city waves do it (wave 1 kills 48.5%, wave 2 wins against 12735). Fortresses are strong but breakable.
- Weak rushes are by design: 30 raiders against 15 guards at H5 loses 56% for at most 650 loot. With 24h protection, day 1 is for diplomacy.

Weaknesses:

- Land never becomes scarce. Total slots per player are 9.7-11 (N=8: 78 slots), while the reference bot reaches only 6 cities by day 7 (48 cities). That leaves 46 contested slots that are never used. The 'must win cities from neighbours' claim is false: peaceful founding on contested islands stays the cheapest growth path all game.
- The anti-war argument #5 is wrong. On the ring each player has exactly 2 neighbours and may hold 2 alliances, so a closed ring where everyone is allied with both neighbours is legal and stable. Only the centre stays contested.
- Battle points divided by 10 are negligible. The worked example's big battle gives the attacker 146 bp, which is 14 score against 105+ for one city. Listing them as an anti-turtle lever is cosmetic.
- The defence is too cost-effective. A guard gives 0.143 def per resource against 0.122 atk per resource for a raider, before base defense, a +50% wall and transport overhead. Because 'land units aboard share naval losses', a defender with half the attacker's naval strength kills 35% of the invading army (lossPm(1400,2800)=353‰) for about a quarter of the resources. Unless attackers learn the warship-first train, naval turtling dominates.
- Sieges are fragile against anything but guard garrisons. Garrison battles use no wall and no base defense, and a raider has def 6. A garrison of 64 raiders plus a settler (D=384) falls to 18 relief raiders. Besiegers must park around 200 guards to hold a 105-point colony, so conquest is rarely worth it compared with free founding. That reinforces the peaceful equilibrium.
- Raiding is not economic. A raider costs 180 for 50 carry, and 100×warehouse is protected. The worked example trades about 32k of attacker losses for 6.4k of loot. Military is useful almost only for conquest or defense, so the economy-versus-military choice is lopsided toward economy.
- No comeback or anti-bully mechanic (no morale). 'Units homed in a lost city removed everywhere' is an acknowledged snowball multiplier.
- Domination is decorative for large N. At N=12 the threshold is max(12, 30% of about 70 cities) = 21 cities, against a pace of about 6 per player.
- Internal inconsistency: the pitch says safe slots fill by about day 3.5, while the table shows 4 cities only at the end of day 4.

### Design 2: Lean Ring (lean-ring/1) — 4/10

Strengths:

- Easiest arithmetic for LLMs. The worked example checks out: q(100,200)=250 giving -1 warship; q(3510,6000)=342 giving -103 raiders; the loot split 600/1500/1840. The 'rush loses 7 of 15' claim also checks out.
- Exact translation-symmetric sectors with a ×2 rich border island equidistant from both neighbours. This creates a guaranteed day-1 focal contest, and same-island fights then happen by land in 1h without ships.
- Slot supply is closest to the bot pace: 6 free per seat for n ≤ 10 and 5 for n=11-12. Scarcity is real by around day 6-7.
- City value and army are capped per city (100 points and 1000 pop), so growth has to come from more cities. An empty city (D=0) falls to a lone settler, which forces garrison discipline on every colony.
- Guard and raider are cost-symmetric (100 each, 20 def against 20 atk), so balance knobs reduce to the wall and the loss exponent.

Weaknesses:

- The economy is trivial. A producer at level L costs 100·L and returns +100/h, so payback is L hours (10h at max). Buildings never cost gold, so wood and stone pile up and only gold binds. That leaves almost no economic decisions, and wood/stone loot is meaningless.
- Score is 80% building levels, which are pure queue time (110h to max a city). Points measure cities × elapsed time more than skill.
- The late game is defense-dominant by construction: wall up to ×2, ties to the defender, no base needed, no combined attacks, supports from every own city stack, and attacks are visible at launch with 1.5-2.7h intra-sector reinforcement against 2h40+ neighbour attacks. A 1000-guard wall-10 city (D=40000) needs four 900-raider waves to crack. Three are lost outright, about a 2.7:1 resource exchange against the attacker.
- Permanent capital immunity creates an unkillable fortress and raid base for every seat. Stalemates and griefing kingmakers follow, and eliminations never happen.
- Alliances are nearly worthless. Pacts have no effect, and the only payoff besides vision is domination: more than 50% of all cities for a bloc capped at 2 members for n ≤ 8, with 6 immune enemy capitals. That is unreachable in practice, so agents have little reason to ally.
- Spies are always detected and the loser loses everything. Scouting becomes a diplomatic incident while blind attacks are coin-flips, which pushes toward passivity.
- There is no recall and no attack-launch cap. One-raider fake attacks (100 resources each) still trigger urgent wakes. The claim that irrevocability prevents fake spam is false.
- Pacing claims contradict each other. 'Slots run out day 3-5' does not fit the design's own sim (5 cities on day 4, 7 cities on day 7 out of 7 available per seat).

### Design 3: Ring & Crown (ring-crown 1.0) — 6/10

Strengths:

- Strongest forced interaction. Frontier islands are 1.5h from both neighbours, protection is only 12h, and fresh colonies can be captured from H12. The neutral Crown is a late jackpot only one player can hold (a natural betrayal trigger), and free sites are about 5.5 per player.
- Best economic texture. Costs grow ×1.35 against slowly rising production, so payback runs from 3.3h at L1 to 27h at L10. Buildings use mostly wood and stone, units mostly gold. The 105k total to max a city checks out: hall 21669, harbor 19508, etc.
- Real comeback and anti-snowball tools: morale with a 50% floor, the settler price resetting to base at one city, capital immunity until the end of day 2, and renown paid to successful defenders.
- Rams create a wall counter-play choice. The 'trojan support' abstention makes betrayal mechanically meaningful.
- Worked examples verified: 214501 ppm giving -9 raiders; 353553 ppm with the lone settler surviving; 494105 ppm giving -247 raiders and -12 rams. The settler rounding creates an implicit capture threshold (1 settler dies when D/A ≥ about 0.63), which is a nice 'decisive win needed' rule.

Weaknesses:

- Renown can be farmed and used for kingmaking. A killed attacker is worth 0.5 points per pop to the defender, ×2 on day 7, and end-of-match armies are otherwise worthless. A colluding seat (the brief flags same-model collusion) can dump a 2000-pop army into a partner's walls on day 7 for +2000 score, which doubles the expected conqueror score of 2000-2600. Even before day 6, guards at 180 resources per point beat late building levels at more than 1000 resources per point.
- Ram efficiency does not scale. Four rams (12 pop) cancel one wall level (+8% of the whole D) whatever the defender's size. Against 1000 guards one ram pop is worth about 6.7 raider pop, so a reusable 40-ram set (16k) voids a wall-10 investment (15k plus 21h of queue) across every target.
- Domination is instant, with no hold, and thresholds drop at day start. A player at 36% on day 6 wins automatically at the start of day 7, with no coalition counter-move. At N ≥ 10 it is unreachable anyway.
- Immediate capture plus 'units homed there disbanded everywhere' is a large snowball swing. Morale is the only brake, and its 50% floor goes the other way too: leaders cannot finish crippled players, who become free harassers.
- Spy watch is capped at 600 (100 + 50·wall), so a 600-gold spy always succeeds and fog of war on big cities is cheap to pierce.
- The Crown cost is understated. Beating 20 warships needs 21 (1050 against 1000 naval), and lossPpm(1000,1050)=929k sinks 20 of the 21. With 550 points plus about 190 renown, the Crown is roughly 25% of a winning score from one battle, which risks deciding the match.
- Most mechanics of the three (morale, renown with day multipliers, rams, the Crown, immunity, hideout, refund grace), so the largest tuning surface and the most exploit paths. Pacing claims are optimistic: sites run out at about 6.9 days at the stated 0.8 settlers/player/day for N=8, not day 5-6.

**Grafts:**

- From D2: calibrate total slots to about 6-7 per player, so free land runs out around day 4-5 at reference-bot pace. D1's 9.7-11 slots per player never run out.
- From D2: make the island shared between two neighbours clearly richer (×1.5 to ×2, not D1's +10%) and equidistant from both homes. It becomes the day-1/2 focal contest.
- From D3: put shared frontier islands about 1.5h from both neighbours, with 2 slots, so contact happens on day 1. Consider shortening attack protection from 24h to about 12h so day 1 is not combat-free.
- From D3: a mild morale rule for anti-bullying and comebacks (for example floor 70% rather than 50%, based on city count or score excluding kill points).
- From D3: reset the settler price to base when a player is reduced to one city, and give capitals immunity until the end of day 2 (timed, never permanent as in D2).
- From D3: a single neutral central city as a late-game prize, with a garrison that never regenerates. Cap its bonus (for example +100 rather than +300) so one battle does not decide the match.
- From D3: gateway caps on attack launches per day and a minimum gap between urgent wakes, so fakes stay a bluffing tool without draining budgets.
- From D2: a cheat-sheet of formulas that the rules tool returns verbatim, so LLMs can compute outcomes exactly. The defender/attacker balance only works if agents can do the math.
- From D2: an alliance-bloc domination win alongside an individual points ranking. It creates the late-betrayal tension the show wants, if the threshold is reachable.

**Must fix:**

- Scarcity must be real. With D1's map, at N=8 there are 78 slots for about 48 cities by day 7, and 46 contested slots are never used, so peaceful founding stays the dominant growth path. Cut slots, or the land-grab-then-conquest arc never happens. Every design's 'slots run out on day X' claim contradicts its own numbers, so derive this from the phase-1 sim.
- Close the peace-ring equilibrium. On a ring with 2 neighbours and 2 allowed alliances, every seat can ally both neighbours permanently. Use 1 ally max, alliance-bloc rules that don't cover both neighbours, or contested resources between allies.
- Kill points must be bounded and hard to farm. No end-game multiplier: D3's ×2 on day 7 lets colluders dump otherwise-worthless armies for about 1 point per pop. Keep them small relative to city value (D1's /10 is about right, maybe with a per-pair or per-day cap), and treat collusion between same-model seats as a known risk.
- Rebalance naval defense. Under D1's 'land units aboard share naval losses', half the attacker's naval strength kills 35% of the invading army (lossPm(1400,2800)=353‰). Either drop the shared losses (D2/D3 approach) or document and support warship-first attack trains in the gateway, and verify in the sim.
- Siege garrisons must not be paper. D1 garrisons get no wall or base defense and raiders have def 6, so relief needs only about 0.27× the garrison's pop. Give garrisons a base defense, or accept it and state in the rules hint that besiegers must garrison guards. Test conquest viability against peaceful founding.
- Wall counters must scale with defender size (D3's 4 rams per level voids walls on big cities), or use D1's permanent -1 wall level on a lost battle instead.
- Domination needs a public hold (24h, as in D1 and D2), never an instant win on a day-start threshold drop (D3). The threshold must be reachable or explicitly decorative for N=10-12 (D1 needs 21 cities at N=12).
- No permanent capital immunity (D2): it guarantees stalemates and unkillable raid bases.
- Add some comeback or anti-snowball brake to D1. Conquest removing every unit homed there plus no morale lets a leader snowball. Consider removing only units at home or stationed, or re-homing.
- Raiding must be a real economic option. D1's raider costs 180 for 50 carry with 100×warehouse protected, so loot rarely repays losses. Tune carry or protection so the economy-versus-military trade-off is two-sided.
- Defense is structurally favored in all three: no combined attacks, unlimited support stacking, attacks visible at launch, and intra-region reinforcement as fast as enemy attacks. Make sure attack trains (same-second sequential resolution, in launch or id order) are explicit, and confirm in sim that a coordinated 2-3 city offensive can take a developed city.
- Spy economics must scale with the target. Reject D3's 600-gold always-success cap and D2's always-detected spying, and keep D1's counter-intel based on pop present.
- Fakes: in every design, 1-unit attacks are cheap, and D1/D3 recall windows (600/900 s) make fakes free. Add a launch cap, a minimum attack size, or visible recalls so urgent wakes cannot be spammed.
- Every economy claim (pacing tables, payback, scarcity day, army sizes) is from no-combat greedy bots. Final rules must be re-tuned from phase-1 sim matches with fighting bots before LLM spend.
