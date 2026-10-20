# Phase 4: the multi-model arena (Pass 1a and Pass 1b as built)

> **Status.** Roadmap step 4 of `docs/brief.md`, "Multi-model arena": seats with different models
> and personalities, budgets, per-model stats. Exit criterion: the cost per match is known and
> under the set budget.
>
> - **Pass 1a is built** (§1–§14): the exit path on the Claude family. A match budget with a kill
>   switch, the prediction stored before turn 1 (`estimate.json`), the `budget` and `exit4` blocks
>   of `arena.json` (`perfidia-arena/2`), `arena estimate`, `arena reconcile`, lineup files and the
>   `claude-duo` and `claude-family` presets.
> - **Pass 1b is built** (§15–§24): the provider plumbing. The `PERFIDIA_<PROVIDER>_*` environment,
>   the provider registry, the guarded transport `model/http.ts`, price cards in pico-dollars per
>   provider, endpoint, tier and validity window (every model of design §5.4, the OpenRouter fee),
>   the controller-label grammar with endpoints, the operator-channel variants and reminder cadence,
>   the tool transform hook, the fake path mirroring each seat's intended provider, and the
>   `budget-mix`, `mid-tier`, `mid-tier-flash` and `frontier` presets. Seats of every provider plan
>   and run on `--fake`; only `anthropic` seats run for real (this build has no other adapter).
> - **Not built yet:** Pass 2 (the OpenAI, Gemini and OpenAI-compatible adapters, calibration
>   profiles, `arena calibrate`), Pass 3 (per-model stats and their spectator pages).
> - This document describes what was built. The reviewed phase-4 design (with its `[critic]`
>   corrections) is the source of the decisions; "design §x" below and in code comments refers to
>   it. Where this document and the code disagree, the code wins; fix this document. Where
>   `docs/phase2.md` and the code disagree, the code wins too (§12 lists the cases met).
> - Nothing here has called a real API: no test touches the network, and every figure below comes
>   from the code, `--fake` runs or the pricing page.

**Contents:**

1. What Pass 1a delivers
2. The exit criterion, operationally
3. Lineups
4. The prediction: `arena estimate`
5. The guarantee: the match budget and its kill switch
6. The run directory
7. Reconciliation: `arena reconcile`
8. Security
9. Commands
10. Owner steps: M0 and M1
11. Tests and measurements
12. Deviations
13. Compatibility
14. Open items
15. What Pass 1b delivers
16. Providers, keys and the transport
17. Price cards
18. Seats of every provider
19. Fairness: the operator channel, the cadence, the tools
20. The fake path
21. The new presets
22. The run directory and the spectator (Pass 1b)
23. Tests and measurements (Pass 1b)
24. Deviations and open items (Pass 1b)

---

## 1. What Pass 1a delivers

"Known and under budget" has four parts (design §0):

| Part                             | As built                                                                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Predicted** before             | `arena estimate`, and the start of `arena run`, print per seat and for the match low / central / high, the reserve and the kill threshold. `arena run` writes the same numbers once to `estimate.json` before turn 1; `seats.json` holds its sha256. |
| **Guaranteed** during            | `MatchBudget` (`budget/ledger.ts`): every charge counts, a kill flag stops every model attempt once spend reaches `K = budget − reserve`, and the reserve covers everything that can still land. Spend never exceeds the budget.                     |
| **Reported** after               | `arena.json` (`perfidia-arena/2`): the `budget` block (every figure a sum of logged line costs) and the `exit4` block.                                                                                                                               |
| **Reconciled** with the provider | `arena reconcile <run-dir>`: tokens first (±2%), then dollars within `max(3%, $0.25)`; `reconcile.json`, `exit4.reconciled`, exit code 4 outside tolerance.                                                                                          |

Where it lives (`packages/orchestrator/src` unless noted):

- `protocol/src/arena.ts`: hand-off reasons `cap | match_budget | outage | operator`; the new
  `llm_calls.jsonl` lines (`preflight`, `prompt_cap`, `kill_switch`, `operator`, `carry`);
  `perfidia-estimate/1`, `perfidia-lineup/1`, `perfidia-reconcile-input/1`, `perfidia-reconcile/1`;
  `perfidia-arena/2` with `budget` and `exit4`; optional `seats.json` fields (`lineup`,
  `estimateSha256`, `promptCapTokens`, `budgetNanoUsd`, per seat `fallbacks`).
- `budget/ledger.ts`: `MatchBudget`, the kill flag in `over()`/`overReason()`, the carry.
- `seat/agent.ts`: the prompt cap and the kill check right before every attempt and thought call.
- `model/adapter.ts`: `attemptBoundNano`, the broken-stream rule. `model/anthropic.ts`:
  `redirect: "error"`, `fallbacks: off`. `model/prices.ts`: Claude cards with ids, source and check
  date.
- `arena/`: `estimate.ts`, `lineup.ts` and `reconcile.ts` (new); the budget, signals, probes and
  `estimate.json` in `run.ts`; `plan.ts`, `cli.ts`, `cost.ts`, `report.ts`, `preflight.ts`.
- `packages/orchestrator/lineups/`: `claude-duo.json`, `claude-family.json`.
- `spectator/src/annotations/`: reads the widened hand-off reasons and skips the new lines.

## 2. The exit criterion, operationally

One run directory meets it when all of these hold (design §5.1). `arena.json` carries them as
`exit4: { models, ended, estimateStored, noHandoff, withinPrediction, under, levelE, reconciled, met }`:

1. **Finished** (`ended`, `levelE`): a lockstep match with status `ended` (not stopped, aborted or
   degraded) and Level E ok.
2. **Several models** (`models`): at least 2 distinct served models among the LLM seats' attempts.
3. **Prediction stored** (`estimateStored`): the run wrote `estimate.json` once (exclusive
   create) before `seats.json` and turn 1; its sha256 is in `seats.json` and in
   `budget.estimate`.
4. **No hand-off** of any reason (`noHandoff`), and the kill switch never fired. Wake caps are
   allowed (counted per seat).
5. **Inside the prediction** (`withinPrediction`, `under`): the run's total (attempts, start
   preflight and probes, from the logged line costs) lies in [low, high] of the stored estimate,
   and total + carry ≤ budget.
6. **Reconciled** (`reconciled`): `null` until `arena reconcile` runs, then its verdict.

`met` is the conjunction, `reconciled` included: a run is never "met" before reconciliation. The
**Claude form** of the exit is met by `claude-duo` (M1, §10); the **cross-provider form** by
`budget-mix` after Pass 2.

On fake models the whole path runs at $0 of real money: a 7-day
`arena run --fake --lineup claude-duo --seed 1 --id-key seed` spends a ledger $5.14 (fake brains
are bots priced as Claude), inside the predicted [$3.47, $44.28], and after
`arena reconcile <dir> --usd fake=5.144326470` its `exit4.met` is `true`. A 2-day fake run spends
less than the 2-day low ($0.84 < $0.99), so its `withinPrediction` is `false`: fake wake counts and
tokens are bot-shaped, never a prediction source.

## 3. Lineups

A lineup file (`perfidia-lineup/1`, Zod in `protocol/src/arena.ts`) names every seat and the
lineup-wide limits: `budgetUsd` (USD as an exact decimal string), `maxTokens`,
`attemptTimeoutMin`, `promptCapTokens`, `reminders`, `defaults` (`effort`, `fallbacks`) and the
seats (`llm`: provider, model, optional endpoint, effort, profile, `capUsd`, `wakeCapUsd`,
`handoffBot`, `fallbacks`; `bot`: label). `--lineup <name>` reads
`packages/orchestrator/lineups/<name>.json`; a value with a `/` or a `.json` suffix is a path.
`--seat` and the other flags override the lineup.

**Presets** (7-day lockstep scenario estimates, printed by `arena estimate`, pinned in
`arena/phase4.test.ts`; Pass 1b's four presets are in §21):

| Preset          | Seats                                                                                | `maxTokens` | Low / central / high      | Reserve | Budget | K       |
| --------------- | ------------------------------------------------------------------------------------ | ----------- | ------------------------- | ------- | ------ | ------- |
| `claude-duo`    | p1 Sonnet 5.5 (fallbacks off), p2–p4 Haiku 5.5; p5 `opportunist@3`, p6 `conqueror@3` | 16,000      | $3.47 / $12.05 / $44.28   | $2.00   | $55    | $53.00  |
| `claude-family` | Opus 5.5, Sonnet 5.5 (off), Haiku 5.5, Opus 5.5 at `low`; the same bots              | 16,000      | $13.54 / $46.38 / $168.92 | $18.48  | $180   | $161.52 |

Both keep phase 2's request shape: `every-round` reminders, 16,000 output tokens, a 10-minute
attempt timeout (§12). One calibration day of `claude-duo` (`--stop-after 1`) is
$0.50 / $1.72 / $6.33.

**Defaults** for lineup seats without their own values (design §3.9): seat cap = 2 × the seat's
predicted high, at least $5 (the sum of caps may exceed the budget: the match budget is the
guarantee); wake cap = 20 × the model's central wake cost, at least $0.10 (Sonnet 5.5 $1.92, Haiku
5.5 $0.10); fallbacks `off` for Sonnet 5.5 (its fallback, Sonnet 5, rejects the operator entries),
`default` for Opus 5.5, `off` for models without server-side fallbacks. Without a lineup, phase 2's
defaults stay ($100 cap, $2 wake cap, no budget).

**Validation** (exit 3, nothing written, the message names the seat or field and the fix): an
unparseable file (`not a perfidia-lineup/1 file: budgetUsd …`), a missing seat, `fallbacks:
"default"` on a model without them, a repeated model in a `comparison: true` lineup (a warning), the
budget checks of §5, and from Pass 1b the seat checks of §18 (endpoint slugs, ZDR, efforts, output
limits, price cards). Pass 1a refused other providers and `last-round` reminders; Pass 1b plans both
(§18, §19), and a real run of a provider without an adapter is refused
(`p2: openai has no adapter in this build (phase 4 Pass 2 adds it): rehearse the lineup with --fake, which mirrors openai at $0`).

## 4. The prediction: `arena estimate`

`bun run arena -- estimate --lineup claude-duo` takes the same flags as `arena run` (without
`--out`) and prints the table without running anything:

```
estimate for claude-duo: perfidia-1@1.1.0 · 6 players · 7 game day(s) · lockstep · cache 5m · max_tokens 16000 · prompt cap 160000
seat  model              effort  fallbacks  cap        wake cap   low        central    high       attempt bound  source
p1    claude-sonnet-5-5  medium  off        $76.65     $1.92      $2.99      $10.41     $38.33     $0.96          scenario
p2    claude-haiku-5-5   medium  off        $5.00      $0.10      $0.16      $0.55      $1.99      $0.24          scenario
p3    claude-haiku-5-5   medium  off        $5.00      $0.10      $0.16      $0.55      $1.99      $0.24          scenario
p4    claude-haiku-5-5   medium  off        $5.00      $0.10      $0.16      $0.55      $1.99      $0.24          scenario
match (scenario, the sum of the seat bounds): $3.47 low · $12.05 central · $44.28 high
reserve $2.00 = attempt bounds $1.68 + one probe $0.16 + start preflight $0.16
budget $55.00 · kill threshold K = $53.00 (budget − reserve) · on budget: handoff
price cards: anthropic:claude-sonnet-5-5@2026-10-20, anthropic:claude-haiku-5-5@2026-10-20, anthropic:claude-haiku-5-5@2026-10-20#over100k
assumption: …
```

- **Source.** Pass 1a has the `scenario` source only: phase 2's scenario (`docs/phase2.md` §8.1)
  with today's cards and an effort factor on output per call (low 0.6, medium 1.0, high 1.5, xhigh
  2.0, max 3.0; an assumption, printed). Per-model wake and round counts are Opus-medium's until
  calibration profiles (Pass 2) replace them. The match interval is the sum of the seat bounds
  (conservative).
- **Days.** The game days the run plays: `--stop-after N` predicts N days of the full-length match.
- **Price cards.** `model/prices.ts`: every Claude card has an id
  (`anthropic:<model>@2026-10-20`, Haiku 5.5's long-prompt tier `#over100k`), its source
  (`https://platform.claude.com/docs/en/about-claude/pricing.md`) and its check date
  (2026-10-20). Opus 5 and Opus 4.8 stay as fallback-target cards. Every `llm_call` and
  `preflight` line logs its cost; logged costs are the source of truth (`arena cost` sums them;
  `--reprice` recomputes at today's cards).
- **Phase 2's scenario is unchanged:** 4 Opus 5.5 seats at medium, 7 lockstep days, $83.29 central
  (pinned).

## 5. The guarantee: the match budget and its kill switch

**Budget.** `--budget-usd <usd>` or the lineup's `budgetUsd`. Without either, no match budget (phase
2's behaviour; the caps still apply).

**Threshold.** `K = budget − reserve`, with

`reserve = Σ attemptBound(LLM seat) + one probe bound + the start-preflight bound`.

- **`attemptBound`** (`model/adapter.ts`, `arena/estimate.ts`): the prompt cap (default 160,000
  tokens) at the highest input-side price of every card the seat can be billed at (cache writes
  included, the 1-hour write too; Haiku 5.5's long-prompt tier), plus the retry limit's output
  (2 × `maxTokens`, the `max_tokens` retry) at the highest output price; plus one iteration per
  fallback target at that target's cards when fallbacks are on. `claude-duo`: Sonnet 5.5 $0.96,
  Haiku 5.5 $0.24; Opus 5.5 with fallbacks on: $6.72.
- **Probe and start-preflight bounds:** one check of every preflight group, cold: the group's
  sample prompt (one token per UTF-8 byte, an upper bound) at the highest input-side price plus the
  check's output, on the model and on each fallback target when fallbacks are on. `claude-duo`:
  $0.16 each.

**Refusal and warning** (design §4.2, exit 3, nothing written): a K below the predicted low (the
carry counted) is refused:

```
budget $5.00 leaves K = $3.00 after the reserve ($2.00 = attempt bounds $1.68 + one probe $0.16 + start preflight $0.16), below the predicted low $3.47: raise --budget-usd
```

(`raise the lineup's budgetUsd` when the budget came from the lineup). A K below the predicted
high is a warning: the kill switch might fire, and the exit criterion would then fail
(`claude-family` at $180).

**What counts.** Every charge: seat attempts (retries, failed and estimated ones), thought calls,
the start preflight and every probe (failed groups too, with their partial spend), and the carry of
a crashed run (`--budget-carry <dir>` sums that run's logged cost lines, its own carry included).

**The kill.** The charge that brings spend to K or above fires the switch once: a `kill_switch`
line, an alert, every LLM seat's hand-off queued with reason `match_budget` (taken at its next
turn: the match plays on with bots to its end, so it ends and verifies), and from then on:

- `ledger.over(seat)` is true for every seat. It is checked right before every attempt and every
  thought call, **after** the pause gate and the model's rate-gate slot: an attempt that was
  queued for a slot when the switch fired never starts. Each seat's attempt in flight at the kill
  is therefore its last.
- Probes stop: the pause gate's probe returns without calling the API once the seats are halted,
  and the start preflight stops between groups.
- `--on-budget abort` aborts the run instead (status `aborted`, exit 2).

**Why it holds.** At most one attempt per LLM seat and one probe can be in flight when spend
reaches K, and each charge stays within its bound, so final spend ≤ K + reserve = budget. Two
rules keep each charge within its bound:

- **The prompt cap** (`seat/agent.ts`). Before every attempt and thought call the prompt is
  estimated from above: the turn's last measured prompt, plus its reply's measured output, plus
  the entries appended since at one token per UTF-8 byte and 32 tokens per part; in round 0, the
  stable prefix (the preflight's measured shape-check prompt, else its bytes) plus every entry. A
  retry of the same request costs its measured prompt. Over the cap, nothing is sent: a
  `prompt_cap` line, and the turn closes (not systemic, counted per seat in `arena.json`).
- **Broken streams** (`model/anthropic.ts`): a stream that broke after `message_start` is charged
  its prompt and the full `max_tokens` of output (`estimated: true`); a stream that never started
  is charged nothing.

**Operator signals.** SIGINT or SIGTERM once: an `operator` line, every LLM seat handed to its bot
(reason `operator`), no attempt after it, the match plays to its end. Twice: the run aborts (exit
2).

**Provider backstops** stay owner steps: an Anthropic Console spend limit on a dedicated workspace
(phase 2).

## 6. The run directory

New or changed in a run directory (`docs/phase2.md` §7 has the rest):

- **`estimate.json`** (`perfidia-estimate/1`): written once (`wx`) before `seats.json` and turn 1:
  lineup, ruleset, players, `matchDays` and `days`, clock, cache TTL, `maxTokens`,
  `promptCapTokens`; per seat model, effort, fallbacks, profile, cap, wake cap, low / central / high,
  source, price-card ids and attempt bound; the match interval, the reserve, the budget (budget, K,
  carry, on-budget) and the assumptions.
- **`seats.json`**: optional `lineup`, `estimateSha256`, `promptCapTokens`, `budgetNanoUsd`, and
  per LLM seat `fallbacks`.
- **`llm_calls.jsonl`** gains:
  - `preflight`: `{phase: "start"|"probe", group, provider, model, endpoint, t, ok, usage, costNanoUsd, priceCard, error, wallStart?}`,
    one per group, failed ones too (start lines are buffered until the directory exists);
  - `prompt_cap`: `{seat, turn, round, kind, t, estimateTokens, capTokens}`;
  - `kill_switch`: `{t, wall?, spentNanoUsd, killAtNanoUsd, budgetNanoUsd, action}`;
  - `operator`: `{signal, action, t, wall?}`;
  - `carry` (first line, with `--budget-carry`): `{from, lines, costNanoUsd}`;
  - `handoff.reason`: `cap | match_budget | outage | operator`.
- **`arena.json`** (`perfidia-arena/2`): per seat `promptCaps` and `handoff.reason`; `totals`
  include the start preflight and probes; the `budget` block (`budgetNanoUsd`, `reserveNanoUsd`,
  `killAtNanoUsd`, `carryNanoUsd`, `onBudget`, `estimate` {sha256, low, central, high, source},
  `actualNanoUsd` = attempts + preflight + probes, `estimatedNanoUsd`, `feesNanoUsd`, `under`,
  `withinPrediction`, `killSwitch`, the wall window, `byProvider`); the `exit4` block (§2).
- **`reconcile.json`** (`perfidia-reconcile/1`), after `arena reconcile`.

## 7. Reconciliation: `arena reconcile`

`bun run arena -- reconcile <run-dir> (--input <file> | --usd <provider=usd> ...)`

- **When:** at least 48 hours after the run's wall end (the command warns if earlier; a `--fake`
  run's wall times are virtual and it says so).
- **Input:** per provider, the pre-tax usage cost of the run's wall window from the usage page of a
  dedicated workspace, and, in a `perfidia-reconcile-input/1` file, the token counts per model
  where the page shows them (`input`, `cacheWrite`, `cacheRead`, `output`) and fees apart.
- **Check, in order:** tokens first, ±2% per model and kind (an accounting bug and a wrong card
  separate here); then dollars: the reported figure must lie in
  `[ledger − estimatedExcess − tol, ledger + tol]`, `tol = max(3%, $0.25)`, where
  `estimatedExcess` is the conservative part of estimated (broken-stream) lines.
- **Output:** `reconcile.json`, `arena.json`'s `exit4.reconciled` (and `met`) rewritten, exit 0
  within tolerance, **4** outside it.

```
fake: ledger $0.84 (estimated excess $0.00), reported $2.00, accepted $0.59–$1.09: OUTSIDE
reconciled: OUTSIDE tolerance (exit 4)
```

## 8. Security

- **Redirects.** Bun 1.4.3's `fetch` follows a cross-origin 307 and forwards `x-api-key` (a test
  shows it on two loopback servers). The Anthropic client's guarded fetch sends
  `redirect: "error"`: a redirecting base URL fails as a connection error, the second origin gets
  nothing, and no error message carries the key (`model/redirect.test.ts`, and the whole CLI in
  `arena/phase4.test.ts`).
- **Environment.** Pass 1a: only `PERFIDIA_ANTHROPIC_API_KEY` and `PERFIDIA_ANTHROPIC_BASE_URL`
  (and `PERFIDIA_LIVE` for the live test), read in `arena/` only; nothing reads `ANTHROPIC_*`.
  Pass 1b adds `PERFIDIA_<PROVIDER>_API_KEY` and `_BASE_URL` for the other providers (§16).
- **Prompt bytes and labels.** The Anthropic request bodies and controller labels are ec8e2ad's
  (phase 3, before phase 4), pinned by hash per model and profile in `arena/pins.test.ts`. The only
  request change: a seat whose fallbacks are `off` (Sonnet 5.5's default) sends neither
  `fallbacks` nor its beta header.

## 9. Commands

| Command                                                  | What it does                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `bun run arena -- estimate [--lineup <x>] …`             | The prediction, reserve and K of a run, without running it (same flags as `run`, no `--out`).       |
| `bun run arena -- run --out <dir> --lineup <x> …`        | A match under the lineup's budget; prints the estimate first; writes `estimate.json` before turn 1. |
| `bun run arena -- reconcile <dir> --usd anthropic=<usd>` | Reconciles the ledger with the provider's usage page (§7).                                          |
| `bun run arena -- cost <dir> [--reprice]`                | Spend per seat and billed model from the logged costs (or at today's cards).                        |

New flags of `run` and `estimate`: `--lineup <preset | file>`, `--budget-usd <usd>`,
`--on-budget handoff|abort`, `--budget-carry <run-dir>`, `--prompt-cap <tokens>`. Exit codes: 0 ok,
1 replay divergence, 2 fatal error, abort or degraded run, 3 usage, config, budget or preflight
error (nothing written), **4** reconciliation outside tolerance. Rehearse any command line for free
with `--fake` (and `--seed 1 --id-key seed` for byte-identical reruns).

## 10. Owner steps: M0 and M1

Owner defaults (decisions for the owner, design): `claude-duo` first; budgets $10 for the
calibration day and $55 for the match; lockstep; medium effort; Anthropic fallbacks off on Sonnet
5.5; the prompt cap at 160,000 tokens; costs published (the phase-3 server's default). The other
defaults (OpenRouter pinned to `z-ai/fp8` with `data_collection: "deny"` and `zdr: true`, Flex off,
the native operator channel, `last-round` reminders, 32,768 output tokens and a 15-minute timeout
for comparison lineups; budgets $8/$40 for `budget-mix` and $40/$200 for `mid-tier`) apply from
Pass 1b and Pass 2. Each run is bounded by its budget: M0 + M1 spend at most
$0.23 + $0.11 + $10 + $55.

1. **Key and backstop.** On the owner's machine (the cloud container's egress proxy may block
   `api.anthropic.com`): `export PERFIDIA_ANTHROPIC_API_KEY=…`, a dedicated Anthropic workspace
   with a Console spend limit (e.g. $100).
2. **M0, the phase-2 smokes** (≤ $0.0054 and ≤ $0.2175, printed before sending):
   ```
   bun run arena -- smoke
   bun run arena -- smoke --model opus-5-5 --effort low
   ```
   Recommended before M1, since `claude-duo`'s p1 is Sonnet 5.5 without fallbacks (≤ $0.11):
   ```
   bun run arena -- smoke --model sonnet-5-5 --effort medium
   ```
3. **Rehearse for free:**
   ```
   bun run arena -- run --fake --lineup claude-duo --stop-after 1 --budget-usd 10 --out runs/rehearsal
   ```
4. **M1, the calibration day** (central $1.72, high $6.33, budget $10, K $8.00):
   ```
   bun run arena -- estimate --lineup claude-duo --stop-after 1 --budget-usd 10
   bun run arena -- run --lineup claude-duo --stop-after 1 --budget-usd 10 --out runs/claude-duo-cal --watch
   ```
   Read `arena.json`: `budget.actualNanoUsd` against the estimate, per-seat cost, cache reads,
   `promptCaps`, hand-offs (there should be none), refusals.
5. **M1, the 7-day match** (central $12.05, high $44.28, budget $55, K $53.00):
   ```
   bun run arena -- estimate --lineup claude-duo --budget-usd 55
   bun run arena -- run --lineup claude-duo --budget-usd 55 --out runs/claude-duo-1 --watch
   ```
   Lockstep takes about 10–15 hours of wall time. If it crashes, rerun with
   `--budget-carry runs/claude-duo-1` into a new directory: the crashed run's spend counts toward
   the same $55.
6. **After 48 hours,** read the pre-tax usage cost of the run's wall window (`arena.json`
   `budget.wall`) on the workspace's usage page, then:
   ```
   bun run arena -- reconcile runs/claude-duo-1 --usd anthropic=<usd>
   ```
   (or `--input usage.json` with token counts). Exit 0 and `exit4.met: true` in `arena.json` is the
   Claude form of the exit; `bun run sim -- verify runs/claude-duo-1` re-checks Level E.

## 11. Tests and measurements

No test touches the network (loopback servers only). Run under `bun test` (default suite):

- `arena/phase4.test.ts`: the estimate pinned (above) with the design's $3.69 / $12.59 / $45.68
  reproduced at the design's Sonnet card and phase 2's $83.29; the §4.2 refusal from `estimate` and
  `run`; a 2-day `--fake --lineup claude-duo --budget-usd 55` run (Level E, `estimate.json` before
  the first model call with its sha in `seats.json`, `exit4`, two runs byte-identical file by
  file); a budget one or two cents above the refusal threshold on a 4-day match (two cents lower
  is refused; K about $1.99; the kill switch fires, every seat handed off `match_budget`, the total
  under the budget, every `llm_call` at or before the kill's game time, the match ended); SIGINT
  once and twice; probes stop after the kill and a failed probe's spend is charged;
  `--budget-carry`; `arena reconcile` in and out of tolerance (USD and tokens); a redirecting base
  URL through the whole CLI.
- `budget/scheduler.test.ts`: a fast-check property over 200 scenarios (seed 4242) with four real
  `LlmSeatAgent`s on fake models whose replies a scheduler resolves in random order, random usages
  up to each attempt's limits, retries charged like broken streams, `max_tokens` retries, thought
  calls, probes in flight, a start preflight, a carry, rate gates of 1, 2 or 4 slots and a kill
  threshold from 0 to twelve Sonnet bounds. Always: total ≤ budget, nothing starts after the kill,
  every seat handed off, every charge within its bound. Coverage measured: 148 of 200 killed, 83 of
  them with attempts in flight (up to 4), 2,717 attempts, 1,596 probes. Removing the kill check
  after the rate-gate slot, the thought-call check or `redirect: "error"` fails the suite.
- `budget/ledger.test.ts`, `model/bound.test.ts`, `model/redirect.test.ts`,
  `model/prices.test.ts` (card ids, sources and rates), `seat/agent.test.ts` (prompt cap),
  `arena/pins.test.ts` (ec8e2ad hashes), `arena/plan.test.ts` (lineups, defaults, errors).
- `packages/server/src/compat.test.ts`: a phase-4 run directory and the same run rewritten as phase
  3 wrote it are both listed, ended, with the same seats and annotations.

Measured on the shared 4-vCPU container: `arena estimate` 0.4 s; a 2-day fake `claude-duo` run
3.6 s ($0.84 ledger); a 7-day one 12.5 s ($5.14, inside the prediction, `exit4.met` after
reconcile); the orchestrator suite 29 s.

## 12. Deviations

- **Sonnet 5.5's cache-read price.** The pricing page read on 2026-10-20 bills Sonnet 5.5 cache
  reads at $0.10 per MTok (0.05 × input); the design priced them at $0.20. `claude-duo` therefore
  predicts $3.47 / $12.05 / $44.28 instead of $3.69 / $12.59 / $45.68 (and `claude-family`
  $13.54 / $46.38 / $168.92 instead of $13.77 / $46.92 / $170.32). A test reproduces the design's
  figures at its card, so the cost model itself is unchanged. `docs/phase2.md` §8.1's Sonnet row
  moves from $43.80 to $41.65 for the same reason.
- **Reserve.** The design's formula is Σ attempt bounds + one probe; the code adds the start
  preflight (design §4.2's message already does) and bounds a probe from above with one token per
  byte of the sample prompt at the 1-hour cache-write price: $0.16 per probe for `claude-duo`
  instead of about $0.05, a reserve of $2.00 instead of about $1.8, K $53.00 instead of about $53.2.
- **Prompt estimate.** One token per UTF-8 byte and 32 tokens per part instead of the design's
  `ceil(bytes ÷ 2)`: an upper bound for any byte-level tokenizer, so the cap and the attempt bound
  hold whatever the text. Each round starts from a measured prompt, so the overestimate does not
  accumulate.
- **Kill check placement.** The design checks before every attempt; the code checks after the
  pause gate and the rate-gate slot (and before thought calls), because an attempt waiting for a
  slot when the switch fires would otherwise start after it. The property test runs with rate gates
  of 1, 2 and 4 slots so that this case occurs.
- **Comparison defaults.** `last-round` reminders, 32,768 output tokens and a 15-minute timeout are
  the defaults of mixed comparison lineups (Pass 1b's presets, §21). The Pass 1a presets keep
  `every-round`, 16,000 and 10 minutes so the Anthropic prompt bytes stay ec8e2ad's.
- **Code over `docs/phase2.md`.** Exit code 4 is new; hand-off reasons are no longer only `cap`;
  `arena.json` is `perfidia-arena/2`. `docs/phase2.md` was left as written except the Sonnet row.

## 13. Compatibility

- Run directories written before phase 4 (`perfidia-arena/1`, no `estimate.json`, no phase-4
  fields or lines) are still served: the server reads `arena.json` leniently (status and `fake`)
  and parses `seats.json` and `llm_calls.jsonl` with the widened schemas (new fields optional, new
  line kinds additive). The spectator annotations accept the widened hand-off reasons and ignore
  the new lines.
- Goldens, fingerprints and fixtures are unchanged; engine, gateway, bots and sim are untouched.

## 14. Open items

- **Unverifiable without the network:** Sonnet 5.5's request without `fallbacks` (the Sonnet smoke
  checks it); that a stream broken after `message_start` is billed no more than its prompt and
  `max_tokens`; the usage page's token breakdown (reconciliation falls back to dollars).
- **Pass 2 and later:** `calibrated` and `measured-point` prediction sources; the other adapters;
  `arena calibrate`, `arena series`, per-model stats (Pass 1b's open items are in §24).
- **Crash resume** is still not built (phase 2): a crashed match is rerun with `--budget-carry`.

---

# Part II: Pass 1b, provider plumbing

## 15. What Pass 1b delivers

The plumbing every provider shares, with no adapter but Anthropic's: seats of every provider plan,
are priced, estimated and bounded, and run on the fake path, which mirrors each seat's intended
provider (§20). Pass 2's adapters plug into it. Where it lives (`packages/orchestrator/src` unless
noted):

- `protocol/src/arena.ts` (additive): `EFFORTS` widened to `none | minimal | low | medium | high |
  xhigh | max`; `PROVIDERS` (`anthropic | openai | google | openrouter | compat | fake`),
  `PromptVariant`, `ReminderCadence`; on `llm_call` the optional `endpoint`, `priceCard`,
  `feeNanoUsd`, `reportedCostNanoUsd`, `reasoningKind` and `usage[].reasoning`; on `preflight` the
  optional `feeNanoUsd`; in `seats.json` the optional `priceDate` and, per LLM seat, `intended`,
  `endpoint`, `quantization`, `promptVariant`, `reminders`, `sharedHash`, `toolsHash`,
  `operatorHash`, `reasoningContext`; lineup seats of every provider; `TokenProfileSchema`
  (`perfidia-profile/1`, for Pass 2's calibration). `protocol/src/spectator.ts`:
  `SeatModel.endpoint?`, `AnnotationRound.reasoningKind?`.
- `model/adapter.ts`: `ModelCapabilities` per adapter, the label grammar (§18), `ModelSpec.endpoint`.
  `model/catalog.ts` (new): every model's capabilities, efforts, limits, endpoints, notes and
  sources. `model/prices/` (new): the cards (§17). `model/http.ts` (new): the transport (§16).
  `model/tools.ts`: the neutral list and the transform hook (§19). `model/fake.ts`: the mirroring.
- `seat/prompt.ts` and `seat/agent.ts`: the channel variants and the cadence (§19).
- `budget/ledger.ts`: a pricer per seat (its provider, endpoint and the attempt's wall-clock start).
- `arena/providers.ts` (new): the registry. `arena/plan.ts`: the environment, the seat grammar, the
  seat checks and the endpoint-metadata hook. `arena/estimate.ts`, `arena/cost.ts`: bounds over
  every card valid from the start, the implicit-cache hit rate, `estimate --cards`.
  `arena/run.ts`, `report.ts`, `preflight.ts`: the intended cards, fees and the new fields.
- `packages/orchestrator/lineups/`: `budget-mix`, `mid-tier`, `mid-tier-flash`, `frontier`.
- `server/src/service/seats.ts`: `parseLlmLabel` reads the new grammar; `SeatModel.endpoint`.
  `spectator/src/fold/feed.ts`: the label regex (unchanged, now tested on the new labels);
  `spectator/src/annotations/`: a round's `reasoningKind`.

## 16. Providers, keys and the transport

**The registry** (`arena/providers.ts`): per provider, the key and base-URL variables, the default
base URL, the auth header, whether this build has its adapter (Anthropic only), its price-card file,
whether a seat must pin an endpoint (OpenRouter) and its tool transform (`none` for all until
Gemini's adapter).

| Provider     | Key                           | Base URL (default)                                                       | Auth header      |
| ------------ | ----------------------------- | ------------------------------------------------------------------------ | ---------------- |
| `anthropic`  | `PERFIDIA_ANTHROPIC_API_KEY`  | `PERFIDIA_ANTHROPIC_BASE_URL` (`https://api.anthropic.com`)              | `x-api-key`      |
| `openai`     | `PERFIDIA_OPENAI_API_KEY`     | `PERFIDIA_OPENAI_BASE_URL` (`https://api.openai.com/v1`)                 | `authorization`  |
| `google`     | `PERFIDIA_GOOGLE_API_KEY`     | `PERFIDIA_GOOGLE_BASE_URL` (`https://generativelanguage.googleapis.com`) | `x-goog-api-key` |
| `openrouter` | `PERFIDIA_OPENROUTER_API_KEY` | `PERFIDIA_OPENROUTER_BASE_URL` (`https://openrouter.ai/api/v1`)          | `authorization`  |
| `compat`     | `PERFIDIA_COMPAT_API_KEY`     | `PERFIDIA_COMPAT_BASE_URL` (required; a key only off loopback)           | `authorization`  |

`arenaEnv` reads these and `PERFIDIA_LIVE`, nothing else, once, in `arena/`; `ENV_VARS` lists them.
A real run needs the key of each provider some seat plays on, and names the seats:
`PERFIDIA_ANTHROPIC_API_KEY is not set: the LLM seats (p1, p2, p3, p4) need it. Export it, or pass --fake …`.
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` and the like are never
read; the architecture test rejects any such name in the orchestrator's sources (its checker is
itself tested on a list of them).

**The transport** (`model/http.ts`, the only module that calls `fetch`; the architecture test
enforces it, and the Anthropic SDK client goes through it):

- `guardedFetch` sends only to the configured origin, over `https:` (`http:` on loopback only),
  with the caller's headers filtered by an allowlist, the provider's auth header and fixed headers,
  and `redirect: "error"` (Bun 1.4.3 forwards `x-api-key` and `x-goog-api-key` across a
  cross-origin 307). A URL carrying the key is refused.
- `readSse` reads server-sent events (`\r\n`, comments, multi-line `data:`); a body that ends
  before the provider's terminal event is a retryable `connection` error that carries the spend so
  far.
- `classifyHttpError` reads the provider's code before the HTTP status: OpenAI spend and quota
  limits (429 with `insufficient_quota`, `*_spend_limit_exceeded`, …) pause for the operator
  (`billing`), other 429s retry, a 403 `misalignment_policy_violation` closes the turn as a refusal;
  Gemini 402 is `billing`, a 429 whose details name a billing or monthly cap too, other 429s retry;
  OpenRouter's 402 `openrouter_in_flight_budget` retries, other 402s and key or guardrail 403s are
  `billing`, a moderation 403 is a refusal, a 503 is `overloaded` in a match and a plan error at
  plan time. Errors are one line with no body or header.

Tests (loopback stubs only, `model/http.test.ts`): origin pinning, header allowlist, no key in a
URL, a redirect to a second server that receives nothing, SSE framing and truncation, and the
classification table.

## 17. Price cards

**Units.** Cards are integers in pico-dollars per token (1 pUSD = 10⁻¹² USD; $1/MTok = 1,000,000
pUSD per token). An attempt's cost is rounded up to whole nano-dollars per usage entry; the platform
fee (permille, OpenRouter's 5.5% = 55) is added, also rounded up, and logged apart (`feeNanoUsd`).

**A card** (`model/prices/card.ts`): an id (`<provider>:<model>[(<endpoint>)]@<check date>[#suffix]`),
provider, model, endpoint, service tier, region, a UTC validity window, input, output, cache read,
5-minute and 1-hour write, a long-context tier (`aboveTokens` and its own card), time-of-day
overrides (charged at their highest price per kind, an upper bound), the platform fee, the cache
kind (`explicit` or `implicit`: no write premium, writes billed as input, hits not guaranteed), its
source URL and its check date. Every card was read on 2026-10-20 from its source (the files name
each URL): the Claude pricing page, OpenAI's model pages, the Gemini pricing page, and OpenRouter's
public `/models/{id}/endpoints` JSON.

**Choice.** An attempt is billed at the card valid for its provider, model and endpoint at its
wall-clock start (`--fake` and `--price-date`: one pinned instant). A served model without a card
is charged at `MAX_CARD`, the highest price per kind over all cards (`unpriced`).

**Dated windows.** Gemini 4 Argon is $2/$10 through 2026-11-30 and $4/$20 after; Gemini 3.8 Flash
$0.75/$3.75 through 2026-12-31 and $1.50/$7.50 after. The page gives no timezone, so the dearer
card applies from 00:00 UTC of the last listed day (2026-11-30 and 2026-12-31), the conservative
side. Haiku 5.5 (prompts over 100,000 tokens) and OpenAI's models over 272,000 have long-context
tiers.

**Bounds.** A seat's attempt bound (§5) is taken over **every** card valid from the run's start on,
later windows and long tiers included, with the model's own output limit for the retry and the fee
on top: Argon's is $1.95 whenever the run starts (its December card), GLM-5.3's $0.54 with the fee.
`model/bound.test.ts` checks, for every seat model and three start dates, that the worst attempt
(the whole prompt cap at the dearest prompt kind, the retry's output) costs exactly the bound to a
nano-dollar; dropping the fee or a later window from the bound fails it.

**The design's §5.4 table**, generated by `bun run arena -- estimate --cards` and pinned in
`arena/providers.test.ts` (scenario: medium, 7 lockstep days, 5-minute TTL; implicit caches hit
100% / 70% / 0% of would-be reads in the low / central / high scenarios; fees apart):

| Card                                                                | In / out / read / write  | Fee  | 1-day central | 7-day low / central / high |
| ------------------------------------------------------------------- | ------------------------ | ---- | ------------- | -------------------------- |
| `anthropic:claude-fable-5-1@2026-10-20`                             | 10 / 50 / 0.25 / 12.5    |      | $7.24         | $14.39 / $50.71 / $188.13  |
| `anthropic:claude-opus-5-5@2026-10-20`                              | 4 / 20 / 0.2 / 5         |      | $2.97         | $5.98 / $20.82 / $76.65    |
| `anthropic:claude-sonnet-5-5@2026-10-20`                            | 2 / 10 / 0.1 / 2.5       |      | $1.49         | $2.99 / $10.41 / $38.33    |
| `anthropic:claude-haiku-5-5@2026-10-20`                             | 0.1 / 0.5 / 0.01 / 0.125 |      | $0.08         | $0.16 / $0.55 / $1.99      |
| `openai:gpt-6.1-sol@2026-10-20`                                     | 2 / 10 / 0.1 / 2.5       |      | $1.49         | $2.99 / $10.41 / $38.33    |
| `openai:gpt-6-sol@2026-10-20`                                       | 2 / 10 / 0.2 / 2.5       |      | $1.56         | $3.21 / $10.95 / $39.73    |
| `openai:gpt-6-luna@2026-10-20`                                      | 0.1 / 0.5 / 0.01 / 0.125 |      | $0.08         | $0.16 / $0.55 / $1.99      |
| `openai:gpt-6-astra@2026-10-20`                                     | 10 / 50 / 1 / 12.5       |      | $7.82         | $16.06 / $54.75 / $198.63  |
| `google:gemini-4-argon@2026-10-20` (to 2026-11-30)                  | 2 / 10 / 0.1 / –         |      | $1.83         | $2.78 / $12.81 / $62.58    |
| `google:gemini-4-argon@2026-10-20#from2026-11-30`                   | 4 / 20 / 0.2 / –         |      | $3.66         | $5.57 / $25.61 / $125.16   |
| `google:gemini-3.8-flash@2026-10-20` (to 2026-12-31)                | 0.75 / 3.75 / 0.075 / –  |      | $0.71         | $1.13 / $4.94 / $23.47     |
| `google:gemini-3.8-flash@2026-10-20#from2026-12-31`                 | 1.5 / 7.5 / 0.15 / –     |      | $1.41         | $2.25 / $9.89 / $46.94     |
| `openrouter:z-ai/glm-5.3(z-ai/fp8)@2026-10-20`                      | 1.4 / 4.4 / 0.26 / –     | 5.5% | $1.14         | $1.92 / $7.99 / $37.25     |
| `openrouter:z-ai/glm-5.3-flash(z-ai/fp8)@2026-10-20`                | 0.15 / 0.5 / 0.03 / –    | 5.5% | $0.13         | $0.22 / $0.88 / $4.06      |
| `openrouter:moonshotai/kimi-k3(moonshotai/mxfp4)@2026-10-20`        | 3 / 15 / 0.3 / –         | 5.5% | $2.82         | $4.51 / $19.77 / $93.87    |
| `openrouter:deepseek/deepseek-v4.1-flash-1017(together)@2026-10-20` | 0.3 / 1.2 / 0.006 / –    | 5.5% | $0.24         | $0.35 / $1.69 / $8.63      |

Every row equals the design's but Sonnet 5.5 (cache reads $0.10, §12; the design's row is GPT-6
Sol's). Effort factors: none and minimal count as low (0.6), an assumption printed with the table.
Predictions (`arena estimate`, `estimate.json`) include the fee; this table leaves it apart.

## 18. Seats of every provider

**`--seat`:** `pN=claude:<model>:<effort>:<profile>` (phase 2's, unchanged) or
`pN=<provider>:<model>[@<endpoint>]:<effort>:<profile>` with provider `openai`, `google`,
`openrouter` or `compat`, e.g. `p4=openrouter:z-ai/glm-5.3@z-ai/fp8:medium:agamemnon`. Lineup files
take `provider`, `model`, `endpoint` and `effort` per seat.

**Controller labels:** `llm:<provider>/<model>[@<endpoint>]/<effort>:<profile>@<v>:p<N>[-dev|-env]`.
Model and endpoint ids escape `%`, `/` and `@` (`%25`, `%2F`, `%40`); ids holding `:` or spaces are
refused (an OpenRouter `:free` id cannot be a seat). Anthropic labels are phase 2's bytes
(`llm:anthropic/claude-sonnet-5-5/medium:odysseus@1:p2`); an OpenRouter seat reads
`llm:openrouter/z-ai%2Fglm-5.3@z-ai%2Ffp8/medium:agamemnon@1:p2-env`. `parseControllerLabel`
inverts the format (a fast-check property over arbitrary ids and every catalogued model), and the
server's `parseLlmLabel` reads every label the orchestrator writes (the same property, against the
orchestrator's parser).

**Plan checks** (design §2.5, §4.2; exit 3, nothing written, the message names the seat and the
fix):

- an unknown model of the provider (`gpt-7 is not a seat model; a seat runs on gpt-6.1-sol, …`);
  an effort the model does not take (`effort must be one of low, medium, high, got "max"` for
  Gemini);
- OpenRouter: a seat without an endpoint (`openrouter seats need a full endpoint slug (e.g. "z-ai/fp8") so routing cannot change the model`),
  an endpoint not in the model's list, a slug that matches several endpoints, an endpoint that does
  not list `tools`, `tool_choice`, `max_tokens` and `reasoning`, an endpoint outside the
  zero-data-retention list while the lineup asks `zdr`; an endpoint on another provider;
- no price card valid at the start; a context under the minimum; a model whose output limit is
  under twice `maxTokens` (the retry); an attempt timeout under the model's minimum;
- a real run on a provider without an adapter, a missing key (§16), `--price-date` on a real run.

Warnings (printed, and `ALERT:` lines on stderr): an OpenRouter endpoint without
`parallel_tool_calls`; OpenRouter's models list advertising other efforts than the one sent (GLM-5.3
lists max, high, low: medium is sent as is and its effect stays unverified until a smoke); a price
change within two days of the start; Fable 5.1's 30-day retention; GPT-6 Astra's misalignment
monitoring.

**The endpoint-metadata hook** (`EndpointSource`): what OpenRouter's `/endpoints` says of a pinned
endpoint (parameters, quantization, ZDR). This build reads the snapshot checked on 2026-10-20 in
`model/catalog.ts`; Pass 2's adapter fetches it live at plan time.

## 19. Fairness: the operator channel, the cadence, the tools

**Operator channel** (design §3.2). The harness's mid-conversation notes (turn header, reminders)
go where each provider takes instructions: Anthropic `system` messages, OpenAI `developer`
messages, and for Gemini, OpenRouter and compat seats a text part beginning `[harness] ` appended to
the user turn (`envelope`). The shared block differs by one sentence of WHO SPEAKS per variant; the
`system` variant is phase 2's bytes (its hash is still ec8e2ad's), and the label carries the
variant (`-dev`, `-env`). Player text only ever sits inside JSON strings, so it cannot start a
`[harness]` part.

**Reminder cadence** (one per lineup): `every-round` (phase 2: a reminder after each round's
results) or `last-round` (the turn header, then only the last-round and wake-end notes), the
default of the Pass 1b presets.

**Tools.** Every provider gets the same neutral list (phase 2's Anthropic list, hash
`214b14ba…`); a provider with a narrower schema dialect gets it through a named `ToolTransform`,
whose output is frozen and may not rename or reorder the tools. `seats.json` records per seat the
sha256 of its shared block (`sharedHash`), its tools (`toolsHash`) and its operator templates
(`operatorHash`), so any per-provider difference shows.

## 20. The fake path

`--fake` replaces each LLM seat's model by a bot-backed fake that mirrors the **intended** model:
its capabilities (output limit, efforts, reasoning kind), the channel its provider receives harness
text on (the fake's `build()` renders `system`, `developer` or `[harness]` parts as the intended
provider would), and its price cards: the ledger prices every attempt at the intended provider's
card and endpoint, with the fee. The label says `fake` (`llm:fake/gpt-6.1-sol/medium:achilles@1:p2-dev`);
`seats.json` names the intended model (`intended: {provider, model, endpoint}`). `--price-date
YYYY-MM-DD` pins the cards to that UTC day's start (default: the day the run starts), so a fake run
is byte-identical on any day; a real run refuses the flag and prices each attempt at its start.

## 21. The new presets

All four are comparison lineups (`comparison: true`): `last-round` reminders, 32,768 output tokens
(65,536 on the `max_tokens` retry), a 15-minute attempt timeout, the 160,000-token prompt cap,
medium effort, fallbacks off, `zdr: true`, profiles odysseus / achilles / penelope / agamemnon on
p1–p4, `opportunist@3` and `conqueror@3` on p5–p6. Estimates printed by `arena estimate` on
2026-10-20 (7-day lockstep, fees included):

| Preset           | Seats                                                               | Low / central / high       | Reserve | Budget | K       |
| ---------------- | ------------------------------------------------------------------- | -------------------------- | ------- | ------ | ------- |
| `budget-mix`     | Haiku 5.5, GPT-6 Luna, Gemini 3.8 Flash, GLM-5.3 Flash @`z-ai/fp8`  | $1.68 / $6.97 / $31.73     | $1.35   | $40    | $38.65  |
| `mid-tier`       | Sonnet 5.5, GPT-6.1 Sol, Gemini 4 Argon, GLM-5.3 @`z-ai/fp8`        | $10.79 / $42.06 / $178.53  | $5.76   | $200   | $194.24 |
| `mid-tier-flash` | `mid-tier` with Gemini 3.8 Flash for Argon                          | $9.13 / $34.19 / $139.42   | $4.38   | $150   | $145.62 |
| `frontier`       | Fable 5.1, GPT-6 Astra, Gemini 4 Argon, Kimi K3 @`moonshotai/mxfp4` | $37.99 / $139.13 / $548.36 | $18.54  | $570   | $551.46 |

`budget-mix` ($8 calibration day, $40 match) is the cross-provider form of the exit and `mid-tier`
($40 / $200) the first comparison, both owner defaults; they run for real once Pass 2's adapters
exist. `mid-tier` is price-matched only until Argon's December card (design §4.3); its reserve
already counts that card.

## 22. The run directory and the spectator (Pass 1b)

- **`seats.json`:** `priceDate` (the pinned day of a fake run); per LLM seat `intended`, `endpoint`
  and `quantization` (OpenRouter), `promptVariant`, `reminders`, `sharedHash`, `toolsHash`,
  `operatorHash`, `reasoningContext` (OpenAI's `all_turns`).
- **`llm_calls.jsonl`:** `llm_call` lines gain `endpoint`, `priceCard` (the card charged),
  `feeNanoUsd`, `reportedCostNanoUsd` (when a provider reports its own cost; Pass 2), `reasoningKind`
  (`summary`, `raw` or `none`) and `usage[].reasoning`; `preflight` lines `feeNanoUsd`.
  `arena.json`'s `budget.feesNanoUsd` sums the fees.
- **Server:** an LLM seat's model carries its `endpoint`, from `seats.json` or, without it, from the
  label; an OpenRouter seat is an LLM seat, never a bot, with or without `seats.json`
  (`packages/server/src/seats.test.ts` serves a fake `mid-tier` run both ways).
- **Spectator:** a round's annotation carries `reasoningKind` when its lines say (not under
  `reasoning: false`); the feed names a seat by the profile of any label of the grammar.
- **Compatibility:** every new field and value is optional and additive. `perfidia-arena/1` run
  directories are still served (`compat.test.ts` now strips Pass 1b's fields too); goldens,
  fingerprints and fixtures are unchanged; engine, gateway, bots and sim are untouched; no
  dependency was added.

## 23. Tests and measurements (Pass 1b)

No test touches the network. New or extended:

- `arena/providers.test.ts`: the §5.4 table pinned; `arena run --fake --lineup mid-tier --days 2
  --price-date 2026-10-19` twice (byte-identical file by file but `summary.json`; Level E; the four
  intended providers with `system` / `developer` / `envelope` / `envelope` and `last-round` in
  `seats.json`; every `llm_call` recomputed from its usage at its intended card on the pinned date,
  fee included, and its card named; fees only on the OpenRouter seat; reasoning kinds;
  `budget.actualNanoUsd` and `feesNanoUsd` sums of the lines; `budget.under`); the four presets
  plan; the seat grammar on every provider; the refusals of §18.
- `budget/scheduler.test.ts`: the Pass 1a property (unchanged figures: 148 of 200 killed, 83 with
  attempts in flight, 2,717 attempts, 1,596 probes) and the same property on the `mid-tier` seats
  (150 scenarios, seed 2626): each seat priced by its own provider's pricer at the attempt's
  wall-clock start, the clock crossing Argon's change mid-run, 32,768 output tokens and 65,536 on
  the retry, OpenRouter's fee. Measured: 132 of 150 killed, 73 with attempts in flight, 1,406
  attempts, 183 retries at 65,536 tokens; both Argon cards charged (208 and 150 attempts); total ≤
  budget and every charge ≤ its bound in every run. Taking only the first card into the bound fails
  it.
- `model/bound.test.ts` (§17), `model/cards.test.ts` (card ids, sources, rates, windows, fees,
  rounding, long tiers, overrides, monotonicity; the catalog), `model/labels.test.ts`,
  `model/http.test.ts` (§16), `seat/variants.test.ts` (the variants differ in one sentence, the
  `system` one is ec8e2ad's hash; the cadence; the label suffix; the fake's rendering per provider;
  the tool transform), `architecture.test.ts` (environment names, `fetch` only in `model/http.ts`),
  `arena/pins.test.ts` (Anthropic request bodies and labels still ec8e2ad's).
- `packages/server/src/seats.test.ts`, `packages/spectator/src/fold/feed.test.ts`, and the
  annotation and compatibility tests above.

Measured on the shared 4-vCPU container: `arena estimate --lineup mid-tier` 0.4 s; a 2-day fake
`mid-tier` run 2.7 s ($2.59 ledger, $0.03 of it fees; under the 2-day low, as fake runs are); a
7-day one 12.8 s ($14.42, inside the predicted [$10.79, $178.53], fees $0.14); a 7-day fake
`budget-mix` 11.3 s ($1.86, inside [$1.68, $31.73]). The orchestrator suite takes about 35 s.

## 24. Deviations and open items (Pass 1b)

**Deviations** (the code wins where the design and the code disagree):

- **Bounds over future windows.** The design bounds an attempt at the cards valid at the start
  (Argon $0.98); the code takes every card valid from the start on, so a run that crosses a price
  change stays under its budget: Argon's bound is $1.95, `mid-tier`'s reserve $5.76.
- **Argon's and 3.8 Flash's change at 00:00 UTC of the last listed day** (the page has no
  timezone), one day earlier than the design's "from 2026-12-01".
- **`frontier`'s budget is $570**, not $560: with the fee in the prediction its high is $548.36 and
  its reserve $18.54, and the design's own rule (high + reserve, rounded up) gives $570.
- **Fees in predictions.** `arena estimate` and `estimate.json` include OpenRouter's fee in each
  seat's figures; the §5.4 table shows it apart.
- **OpenRouter efforts.** OpenRouter's models list advertises max, high and low for GLM-5.3 and
  GLM-5.3 Flash (max, high, low, none for Kimi K3 and DeepSeek). The owner default (medium) is kept
  and sent as is, with a plan warning; whether it maps to a reasoning level is unverified until a
  smoke.
- **The probe bound** keeps every long-context tier, as in Pass 1a, so `claude-duo`'s reserve stays
  $2.00.
- **The tool transform** is a hook only: Gemini's schema transform comes with its adapter (Pass 2),
  so every seat's `toolsHash` is the neutral list's today.
- **`byProvider`** in a fake run's report groups by `fake` and endpoint; the intended provider of
  each line is in `seats.json` and its `priceCard`.

**Open items:**

- Unverifiable without the network: every non-Anthropic request shape, error code and usage field;
  OpenRouter's live endpoint metadata (the snapshot is 2026-10-20's); how each provider counts
  reasoning tokens; whether medium reaches GLM-5.3.
- Pass 2: the OpenAI, Gemini, OpenRouter and compat adapters on `model/http.ts`, Gemini's tool
  transform, calibration profiles (`perfidia-profile/1`) and `arena calibrate`, smokes per model,
  then `budget-mix` (the cross-provider exit) and `mid-tier`.
