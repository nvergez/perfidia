# Phase 4: the multi-model arena (Pass 1a as built)

> **Status.** Roadmap step 4 of `docs/brief.md`, "Multi-model arena": seats with different models
> and personalities, budgets, per-model stats. Exit criterion: the cost per match is known and
> under the set budget.
>
> - **Pass 1a is built:** the exit path on the Claude family. A match budget with a kill switch,
>   the prediction stored before turn 1 (`estimate.json`), the `budget` and `exit4` blocks of
>   `arena.json` (`perfidia-arena/2`), `arena estimate`, `arena reconcile`, lineup files and the
>   `claude-duo` and `claude-family` presets. Only `anthropic` seats are planned.
> - **Not built yet:** Pass 1b (provider plumbing: `model/http.ts`, price cards keyed by provider,
>   endpoint, tier and region), Pass 2 (the OpenAI, Gemini and OpenAI-compatible adapters,
>   calibration profiles, `budget-mix` and `mid-tier`), Pass 3 (per-model stats and their
>   spectator pages).
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
`arena/phase4.test.ts`):

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
"default"` on a model without them, a provider this build does not plan
(`p2: provider openai is not planned by this build`), `last-round` reminders (they arrive with the
non-Anthropic seats), a repeated model in a `comparison: true` lineup (a warning), and the budget
checks of §5.

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
- **Environment.** Unchanged: only `PERFIDIA_ANTHROPIC_API_KEY` and `PERFIDIA_ANTHROPIC_BASE_URL`
  (and `PERFIDIA_LIVE` for the live test), read in `arena/` only; nothing reads `ANTHROPIC_*`.
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
  the defaults of mixed comparison lineups (Pass 2). The Pass 1a presets keep `every-round`, 16,000
  and 10 minutes so the Anthropic prompt bytes stay ec8e2ad's (the Pass 1a constraint); a
  `last-round` lineup is refused until the non-Anthropic seats arrive.
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
- **Pass 1b and later:** price cards per provider, endpoint, tier and region with validity windows;
  `calibrated` and `measured-point` prediction sources; the other adapters; `arena calibrate`,
  `arena series`, per-model stats.
- **Crash resume** is still not built (phase 2): a crashed match is rerun with `--budget-carry`.
