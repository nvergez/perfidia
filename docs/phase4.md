# Phase 4: the multi-model arena (Pass 1a, Pass 1b, Pass 2 and Pass 3 as built)

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
>   and run on `--fake` (Pass 1b ran only `anthropic` seats for real; Pass 2 runs them all).
> - **The review's fixes** (§25): a fail-safe kill switch, US-only inference in every Claude bound,
>   the in-flight reserve of a crashed run's carry, key redaction, and the other findings of the
>   Pass 1 review, each with its regression test. The figures of §1–§24 are this build's.
> - **Pass 2 is built** (§26–§39): the OpenAI Responses, Gemini `generateContent` and
>   OpenRouter/OpenAI-compatible adapters on `model/http.ts` (every provider now runs for real),
>   Gemini's `gemini@1` tool transform, `arena smoke --provider … [--record <dir>]`, calibration
>   profiles (`arena calibrate`), profile-based predictions and rotated series (`arena series`);
>   the integration's cross-adapter conformance suite and four-provider wire-stub match. Nothing in
>   Pass 2 has called a real API: provider behaviour is documented and pinned by synthetic
>   fixtures until the owner's recorded smokes (§32, §36).
> - **Pass 3's statistics are built** (§41–§48, agent F): the per seat per match fold
>   (`@perfidia/spectator/stats`, `perfidia-stats/1`), the aggregation across matches with MAP
>   Plackett–Luce ratings and block-bootstrap intervals (`perfidia-model-stats/1`), the claim
>   threshold of design §6.4 (no ranking below it), the power simulation, `bun run stats` and three
>   GET routes of the spectator server (`/api/matches/:id/stats`, `/api/models`, `/api/models/:id`).
> - **Pass 3's web is built** (§49–§54, agent G): display names for every catalog model and
>   provider ("GPT-6.1 Sol", "Gemini 4 Argon", "GLM-5.3 (Z.AI via OpenRouter)"), efforts in each
>   vendor's terms, reasoning-kind labels wherever reasoning shows (a provider's summary or a raw
>   chain of thought), the dossier's model block, and the lazy `/models` page (ratings only above
>   the claim threshold, otherwise "too few matches: N more needed").
> - **Not built yet:** the optional red team (agent H).
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
25. The review's fixes
26. What Pass 2 delivers
27. The adapter contract in Pass 2
28. OpenAI: the Responses API
29. Gemini: `generateContent`
30. OpenRouter and OpenAI-compatible endpoints
31. The wire mapping at a glance
32. Synthetic, unverified, and the owner's recordings
33. Calibration and series
34. The integration
35. Commands (Pass 2)
36. Owner steps: M2 and M3
37. Tests and measurements (Pass 2)
38. Deviations (Pass 2)
39. Open items (Pass 2)
40. The Pass 2 review's fixes
41. What Pass 3's statistics deliver
42. Per seat per match: `perfidia-stats/1`
43. Across matches: `perfidia-model-stats/1`
44. How many matches before a claim: the power simulation
45. The routes (the web's contract)
46. `bun run stats`
47. Tests and measurements (Pass 3 statistics)
48. Deviations and open items (Pass 3 statistics)
49. What Pass 3's web delivers
50. Names, efforts and reasoning kinds (`lib/models.ts`)
51. The dossier's model block
52. The `/models` page
53. Tests and measurements (Pass 3 web)
54. Deviations and open items (Pass 3 web)

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
5. **Inside the prediction** (`withinPrediction`, `under`): the run's attempt spend (from the
   logged line costs) lies in [low, high] of the stored estimate, which predicts attempts only;
   the start preflight and probes are reported apart (`preflightNanoUsd`, `probeNanoUsd`). The
   total (attempts, preflight and probes) + carry ≤ budget.
6. **Reconciled** (`reconciled`): `null` until `arena reconcile` runs at least 48 hours after the
   run (or with `--force`), then its verdict.

`met` is the conjunction, `reconciled` included, and needs a real run: a run is never "met" before
reconciliation, and a `--fake` run never is (no model served it and nothing was spent). The
**Claude form** of the exit is met by `claude-duo` (M1, §10); the **cross-provider form** by
`budget-mix` after Pass 2.

On fake models the whole path runs at $0 of real money: a 7-day
`arena run --fake --lineup claude-duo --seed 1 --id-key seed` spends a ledger $5.15
($5.150819930; fake brains are bots priced as Claude), inside the predicted [$3.47, $44.28], and
after `arena reconcile <dir> --usd fake=5.150819930` every part of `exit4` holds, `reconciled`
included, while `met` stays `false` (a rehearsal). A 2-day fake run spends less than the 2-day low
($0.85 < $0.99), so its `withinPrediction` is `false`: fake wake counts and tokens are bot-shaped,
never a prediction source.

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
| `claude-duo`    | p1 Sonnet 5.5 (fallbacks off), p2–p4 Haiku 5.5; p5 `opportunist@3`, p6 `conqueror@3` | 16,000      | $3.47 / $12.05 / $44.28   | $2.20   | $55    | $52.80  |
| `claude-family` | Opus 5.5, Sonnet 5.5 (off), Haiku 5.5, Opus 5.5 at `low`; the same bots              | 16,000      | $13.54 / $46.38 / $168.92 | $20.33  | $190   | $169.67 |

Both keep phase 2's request shape: `every-round` reminders, 16,000 output tokens, a 10-minute
attempt timeout (§12). One calibration day of `claude-duo` (`--stop-after 1`) is
$0.50 / $1.72 / $6.33.

**Defaults** for lineup seats without their own values (design §3.9): seat cap = 2 × the seat's
predicted high, at least $5 (the sum of caps may exceed the budget: the match budget is the
guarantee); wake cap = 20 × the model's central wake cost, at least $0.10 (Sonnet 5.5 $1.92, Haiku
5.5 $0.10); fallbacks `off` for Sonnet 5.5 (its fallback, Sonnet 5, rejects the operator entries),
`default` for Opus 5.5, `off` for models without server-side fallbacks. A `--seat` override of a
lineup seat takes the lineup's `defaults` too (its fallbacks included); only the lineup seat's own
values are dropped. Without a lineup, phase 2's defaults stay ($100 cap, $2 wake cap, no budget).

**Validation** (exit 3, nothing written, the message names the seat or field and the fix): an
unparseable file (`not a perfidia-lineup/1 file: budgetUsd …`), a missing seat, `fallbacks:
"default"` on a model without them, a seat with server-side fallbacks on in a `comparison: true`
lineup (another model could serve its turns, design §3.5), a repeated model in a comparison lineup
(a warning), the budget checks of §5, and from Pass 1b the seat checks of §18 (endpoint slugs, ZDR, efforts, output
limits, price cards). Pass 1a refused other providers and `last-round` reminders; Pass 1b plans both
(§18, §19); Pass 1b refused a real run of a provider without an adapter (`p2: openai has no
adapter in this build …`), and since Pass 2 every provider has one, so a real run needs that
provider's key instead (§27).

## 4. The prediction: `arena estimate`

`bun run arena -- estimate --lineup claude-duo` takes the same flags as `arena run` (without
`--out`) and prints the table without running anything:

```
estimate for claude-duo: perfidia-1@1.1.0 · 6 players · 7 game day(s) · lockstep · cache 5m · max_tokens 16000 · prompt cap 160000
seat  model              effort  fallbacks  cap        wake cap   low        central    high       attempt bound  source
p1    claude-sonnet-5-5  medium  off        $76.65     $1.92      $2.99      $10.41     $38.33     $1.06          scenario
p2    claude-haiku-5-5   medium  off        $5.00      $0.10      $0.16      $0.55      $1.99      $0.26          scenario
p3    claude-haiku-5-5   medium  off        $5.00      $0.10      $0.16      $0.55      $1.99      $0.26          scenario
p4    claude-haiku-5-5   medium  off        $5.00      $0.10      $0.16      $0.55      $1.99      $0.26          scenario
match (scenario, the sum of the seat bounds): $3.47 low · $12.05 central · $44.28 high
reserve $2.20 = attempt bounds $1.85 + one probe $0.17 + start preflight $0.17
budget $55.00 · kill threshold K = $52.80 (budget − reserve) · on budget: handoff
price cards: anthropic:claude-sonnet-5-5@2026-10-20, anthropic:claude-sonnet-5-5@2026-10-20+us, anthropic:claude-haiku-5-5@2026-10-20, anthropic:claude-haiku-5-5@2026-10-20+us, anthropic:claude-haiku-5-5@2026-10-20#over100k, anthropic:claude-haiku-5-5@2026-10-20#over100k+us
assumption: …
```

- **Source.** Pass 1a has the `scenario` source only: phase 2's scenario (`docs/phase2.md` §8.1)
  with today's cards and an effort factor on output per call (low 0.6, medium 1.0, high 1.5, xhigh
  2.0, max 3.0; an assumption, printed). Per-model wake and round counts are Opus-medium's until
  calibration profiles (Pass 2) replace them. The match interval is the sum of the seat bounds
  (conservative).
- **Days.** The game days the run plays: `--stop-after N` predicts N days of the full-length match.
- **Price cards.** `model/prices.ts`: every Claude card has an id
  (`anthropic:<model>@2026-10-20`, Haiku 5.5's long-prompt tier `#over100k`, and `+us` for the
  same card at US-only inference prices, 1.1× every kind, §25), its source
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
  included, the 1-hour write too; Haiku 5.5's long-prompt tier; each Claude card also at its
  US-only inference price, 1.1×), plus the retry limit's output (2 × `maxTokens`, the
  `max_tokens` retry) at the highest output price; plus one iteration per fallback target at that
  target's cards when fallbacks are on. `claude-duo`: Sonnet 5.5 $1.06, Haiku 5.5 $0.26; Opus 5.5
  with fallbacks on: $7.39 (the design's $0.96, $0.24 and $6.72 at global prices, × 1.1).
- **Probe and start-preflight bounds:** one check of every preflight group, cold: the group's
  sample prompt (one token per UTF-8 byte, an upper bound) at the highest input-side price plus the
  check's output, on the model and on each fallback target when fallbacks are on. `claude-duo`:
  $0.17 each.

**Refusal and warning** (design §4.2, exit 3, nothing written): a K below the predicted low (the
carry counted) is refused:

```
budget $5.00 leaves K = $2.80 after the reserve ($2.20 = attempt bounds $1.85 + one probe $0.17 + start preflight $0.17), below the predicted low $3.47: raise --budget-usd
```

(`raise the lineup's budgetUsd` when the budget came from the lineup). A K below the predicted
high is a warning: the kill switch might fire, and the exit criterion would then fail
(`claude-family` at $180; its preset is $190, the design's rule of high + reserve rounded up).

**What counts.** Every charge: seat attempts (retries, failed and estimated ones), thought calls,
the start preflight and every probe (failed groups too, with their partial spend), and the carry of
a crashed run (`--budget-carry <dir>` sums that run's logged cost lines, its own carry included,
plus, when its `arena.json` does not say `ended`, `stopped` or `degraded`, its `estimate.json`
reserve: what it may have had in flight when it died, billed without a line). A usage the ledger
cannot price (a non-finite or absurd count) is charged the seat's attempt bound, flagged
`estimated`, on a valid line.

**The kill.** The charge that brings spend to K or above fires the switch once: the kill flag and
every LLM seat's halt first, its hand-off queued with reason `match_budget` (taken at its next
turn: the match plays on with bots to its end, so it ends and verifies), then the alert and a
`kill_switch` line. The accounting never depends on a hook: a line that cannot be written (a full
disk) is reported on stderr, and the halt, the charge and the hand-offs stand (`over()` reads the
kill flag itself). From then on:

- `ledger.over(seat)` is true for every seat. It is checked right before every attempt and every
  thought call, **after** the pause gate and the model's rate-gate slot: an attempt that was
  queued for a slot when the switch fired never starts. Each seat's attempt in flight at the kill
  is therefore its last.
- Probes stop: the pause gate's probe returns without calling the API once the seats are halted
  (or the kill flag is up), and both the probe and the start preflight stop between groups.
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
  its prompt and the full `max_tokens` of output (`estimated: true`), plus, for every server-side
  fallback switch seen before the break, the target's cold iteration (the whole prompt written to
  the cache and the full `max_tokens`); a stream that never started is charged nothing.
- **Geography** (`usage.inference_geo`): a request runs where the workspace's default inference
  geo says (ours send none). US-only inference bills 1.1× every kind: every attempt is priced at
  the geography its usage reports, the bounds take the 1.1× prices, the start preflight refuses a
  workspace that is not global (exit 3, the Console setting named) and a mid-run `us` attempt is an
  alert.

**Operator signals.** SIGINT, SIGTERM or SIGHUP (a closed terminal or session), taken from before
the start preflight. Once: an `operator` line, every LLM seat handed to its bot (reason
`operator`), no attempt after it, the match plays to its end; during the start preflight it stops
the checks between groups and the run writes nothing (exit 3, the preflight's spend printed).
Twice: the run aborts (exit 2). A third time: an `operator` line (`exit`), then the CLI exits at
once (130).

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
  - `operator`: `{signal, action, t, wall?}` (`action`: `handoff`, `abort`, or `exit` before the
    CLI exits at a third signal);
  - `carry` (first line, with `--budget-carry`): `{from, lines, costNanoUsd, inFlightNanoUsd?}`
    (the carried run's reserve when it did not end);
  - usage entries: `geo` when the provider reports an inference geography other than global;
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
  separate here), an output count down to `ledger − estimated − 2%` accepted, `estimated` being
  the output of broken-stream entries that may never have run; then dollars: the reported figure
  must lie in `[ledger − estimatedExcess − tol, ledger + tol]`, `tol = max(3%, $0.25)`, where
  `estimatedExcess` is the conservative part of the ledger: the output of estimated
  (broken-stream) lines, and what lines priced at a dated card inside its uncertain change window
  (Gemini's "through November 30" has no timezone, §17) cost over the card before it.
- **Output:** `reconcile.json`, `arena.json`'s `exit4.reconciled` (and `met`) rewritten, exit 0
  within tolerance, **4** outside it. Under 48 hours after the run, `exit4.reconciled` stays `null`
  (the usage page may still lag, and the lower tolerance would accept its shortfall) unless
  `--force`.

```
fake: ledger $0.85 (estimated excess $0.00), reported $2.00, accepted $0.60–$1.10: OUTSIDE
reconciled: OUTSIDE tolerance (exit 4)
```

## 8. Security

- **Redirects.** Bun 1.4.3's `fetch` follows a cross-origin 307 and forwards `x-api-key` (a test
  shows it on two loopback servers). The Anthropic client's guarded fetch sends
  `redirect: "error"`: a redirecting base URL fails as a connection error, the second origin gets
  nothing, and no error message carries the key (`model/redirect.test.ts`, and the whole CLI in
  `arena/phase4.test.ts`).
- **Error bodies.** The SDK's messages embed the error body: the client redacts its key (raw and
  URL-encoded) from every error message before it reaches a log line, a transcript, an alert or
  stderr, so a proxy or an upstream that echoes the key leaks nothing (`arena/review.test.ts`, a
  loopback stub that answers 401 with the key, through the whole CLI). `arena smoke` checks the
  base URL as `arena run` does (http:// on loopback only, exit 3).
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
| `bun run arena -- reconcile <dir> --usd anthropic=<usd>` | Reconciles the ledger with the provider's usage page (§7); `--force` fills `exit4` under 48 h.      |
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
$0.011 + $1.54 + $0.22 + $10 + $55 (the three smokes' bounds, §25, then the two budgets).

1. **Key and backstop.** On the owner's machine (the cloud container's egress proxy may block
   `api.anthropic.com`): `export PERFIDIA_ANTHROPIC_API_KEY=…`, a dedicated Anthropic workspace
   with a Console spend limit (e.g. $100) and its default inference geo set to global (Console,
   the workspace's data residency settings: US-only bills 1.1×, and the preflight refuses it).
2. **M0, the phase-2 smokes** (≤ $0.011 and ≤ $1.54, printed before sending: the bound of the
   real requests, Opus 5.5's two fallback targets included; a smoke costs a fraction of it):
   ```
   bun run arena -- smoke
   bun run arena -- smoke --model opus-5-5 --effort low
   ```
   Recommended before M1, since `claude-duo`'s p1 is Sonnet 5.5 without fallbacks (≤ $0.22):
   ```
   bun run arena -- smoke --model sonnet-5-5 --effort medium
   ```
3. **Rehearse for free:**
   ```
   bun run arena -- run --fake --lineup claude-duo --stop-after 1 --budget-usd 10 --out runs/rehearsal
   ```
4. **M1, the calibration day** (central $1.72, high $6.33, budget $10, K $7.81):
   ```
   bun run arena -- estimate --lineup claude-duo --stop-after 1 --budget-usd 10
   bun run arena -- run --lineup claude-duo --stop-after 1 --budget-usd 10 --out runs/claude-duo-cal --watch
   ```
   Read `arena.json`: `budget.actualNanoUsd` against the estimate, per-seat cost, cache reads,
   `promptCaps`, hand-offs (there should be none), refusals.
5. **M1, the 7-day match** (central $12.05, high $44.28, budget $55, K $52.80):
   ```
   bun run arena -- estimate --lineup claude-duo --budget-usd 55
   bun run arena -- run --lineup claude-duo --budget-usd 55 --out runs/claude-duo-1 --watch
   ```
   Lockstep takes about 10–15 hours of wall time. If it crashes, rerun with
   `--budget-carry runs/claude-duo-1` into a new directory: the crashed run's spend counts toward
   the same $55, its reserve ($2.20) too, for what it may have had in flight.
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
2.4 s ($0.846 ledger); a 7-day one 12.5 s ($5.150819930, inside the prediction, every `exit4` part
true after reconcile, `met` false because it is fake); the orchestrator suite in §25.

## 12. Deviations

- **Sonnet 5.5's cache-read price.** The pricing page read on 2026-10-20 bills Sonnet 5.5 cache
  reads at $0.10 per MTok (0.05 × input); the design priced them at $0.20. `claude-duo` therefore
  predicts $3.47 / $12.05 / $44.28 instead of $3.69 / $12.59 / $45.68 (and `claude-family`
  $13.54 / $46.38 / $168.92 instead of $13.77 / $46.92 / $170.32). A test reproduces the design's
  figures at its card, so the cost model itself is unchanged. `docs/phase2.md` §8.1's Sonnet row
  moves from $43.80 to $41.65 for the same reason.
- **Reserve.** The design's formula is Σ attempt bounds + one probe; the code adds the start
  preflight (design §4.2's message already does) and bounds a probe from above with one token per
  byte of the sample prompt at the 1-hour cache-write price, and (§25) every Claude price at its
  US-only 1.1×: $0.17 per probe for `claude-duo` instead of about $0.05, a reserve of $2.20 instead
  of about $1.8, K $52.80 instead of about $53.2.
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
  the new lines. The protocol exports a reader for the old reports too (§25):
  `ArenaReportV1Schema` (`perfidia-arena/1`, ec8e2ad's schema) and `ArenaReportAnySchema` (either);
  the writer still writes `perfidia-arena/2`.
- Goldens, fingerprints and fixtures are unchanged; engine, gateway, bots and sim are untouched.

## 14. Open items

- **Unverifiable without the network:** Sonnet 5.5's request without `fallbacks` (the Sonnet smoke
  checks it); that a stream broken after `message_start` is billed no more than its prompt and
  `max_tokens`; the usage page's token breakdown (reconciliation falls back to dollars).
- **Pass 2 and later:** `calibrated` and `measured-point` prediction sources; the other adapters;
  `arena calibrate`, `arena series`, per-model stats (Pass 1b's open items are in §24).
- **Crash resume** is still not built (phase 2): a crashed match is rerun with `--budget-carry`,
  which carries the crashed run's reserve when it did not end (§5).

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
- `readSse` reads server-sent events (`\r\n`, comments, multi-line `data:`); an event the body
  ends inside (no blank line after it) is discarded, so a body that ends before (or inside) the
  provider's terminal event is a retryable `connection` error that carries the spend so far.
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
side, and records the latest instant the change can mean (`uncertainUntil`: the next day 12:00
UTC); `arena reconcile` counts what a line inside that window was charged over the earlier card as
conservative excess (§7). Haiku 5.5 (prompts over 100,000 tokens) and OpenAI's models over 272,000
have long-context tiers.

**Geographies** (§25): every Claude card lists US-only inference at 1.1× every kind
(`geo: { us: 1100 }`, Anthropic's pricing page, data residency, checked 2026-10-20); an entry
whose usage reports `us` is charged at those prices under the card's id plus `+us`; a geography no
card lists is charged at `MAX_CARD`.

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
  a `compat` seat until its card is in `model/prices/compat.ts` (no compat card ships: what a
  compatible endpoint bills is the owner's to state);
  an effort the model does not take (`effort must be one of low, medium, high, got "max"` for
  Gemini);
- OpenRouter: a seat without an endpoint (`openrouter seats need a full endpoint slug (e.g. "z-ai/fp8") so routing cannot change the model`),
  an endpoint not in the model's list, a slug that matches several endpoints (a provider slug such
  as `z-ai` names the endpoints it matches: `z-ai is not a full endpoint slug: it matches z-ai/fp8`), an endpoint that does
  not list `tools`, `tool_choice`, `max_tokens` and `reasoning`, an endpoint outside the
  zero-data-retention list while the lineup asks `zdr`; an endpoint on another provider;
- no price card valid at the start; a context under the minimum; a model whose output limit is
  under twice `maxTokens` (the retry); an attempt timeout under the model's minimum;
- a real run on a provider without an adapter, a missing key (§16), `--price-date` on a real run.

Warnings (printed, and `ALERT:` lines on stderr): an OpenRouter endpoint without
`parallel_tool_calls`; OpenRouter's models list advertising other efforts than the one sent (GLM-5.3
lists max, high, low, default max: medium is sent as is, and if OpenRouter drops it the seat
reasons at max, three times the output the prediction assumes, while the others run at medium; the
warning says so, and the mapping is decided with Pass 2's adapter before the first comparison); a
price
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
sha256 of its shared block (`sharedHash`), its own tools (`toolsHash`: the neutral list through its
provider's transform, `arena/providers.ts` `toolsFor`; the identity for every provider of this
build) and its operator templates as its channel renders them (`operatorHash`: `system` keeps
phase 2's hash, `developer` and `envelope` hash their channel and rendering, `[harness] ` prefix
included), so any per-provider difference shows. The turn header names where the briefing is per
channel: "The user turn above" (`system`, `developer`), "The text part above" (`envelope`, where
the header is a part of that same user turn).

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
| `budget-mix`     | Haiku 5.5, GPT-6 Luna, Gemini 3.8 Flash, GLM-5.3 Flash @`z-ai/fp8`  | $1.68 / $6.97 / $31.73     | $1.39   | $40    | $38.61  |
| `mid-tier`       | Sonnet 5.5, GPT-6.1 Sol, Gemini 4 Argon, GLM-5.3 @`z-ai/fp8`        | $10.79 / $42.06 / $178.53  | $5.91   | $200   | $194.09 |
| `mid-tier-flash` | `mid-tier` with Gemini 3.8 Flash for Argon                          | $9.13 / $34.19 / $139.42   | $4.53   | $150   | $145.47 |
| `frontier`       | Fable 5.1, GPT-6 Astra, Gemini 4 Argon, Kimi K3 @`moonshotai/mxfp4` | $37.99 / $139.13 / $548.36 | $19.31  | $570   | $550.69 |

`budget-mix` ($8 calibration day, $40 match) is the cross-provider form of the exit and `mid-tier`
($40 / $200) the first comparison, both owner defaults; they run for real with Pass 2's adapters
(§36). `mid-tier` is price-matched only until Argon's December card (design §4.3); its reserve
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
  change stays under its budget: Argon's bound is $1.95, `mid-tier`'s reserve $5.91.
- **Argon's and 3.8 Flash's change at 00:00 UTC of the last listed day** (the page has no
  timezone), one day earlier than the design's "from 2026-12-01".
- **`frontier`'s budget is $570**, not $560: with the fee in the prediction its high is $548.36 and
  its reserve $19.31, and the design's own rule (high + reserve, rounded up) gives $570.
  `claude-family`'s is $190 by the same rule (§25).
- **Fees in predictions.** `arena estimate` and `estimate.json` include OpenRouter's fee in each
  seat's figures; the §5.4 table shows it apart.
- **OpenRouter efforts.** OpenRouter's models list advertises max, high and low for GLM-5.3 and
  GLM-5.3 Flash (max, high, low, none for Kimi K3 and DeepSeek). The owner default (medium) is kept
  and sent as is, with a plan warning; whether it maps to a reasoning level is unverified until a
  smoke.
- **The probe bound** keeps every long-context tier, as in Pass 1a (`claude-duo`'s reserve is
  $2.20 with the US-only prices of §25).
- **The tool transform** is wired per seat (§19, §25), but only the identity exists: Gemini's
  schema transform comes with its adapter (Pass 2), so every seat's `toolsHash` is the neutral
  list's today.
- **`byProvider`** in a fake run's report groups by `fake` and endpoint; the intended provider of
  each line is in `seats.json` and its `priceCard`.

**Open items:**

- Unverifiable without the network: every non-Anthropic request shape, error code and usage field;
  OpenRouter's live endpoint metadata (the snapshot is 2026-10-20's); how each provider counts
  reasoning tokens; whether medium reaches GLM-5.3.
- Pass 2: the OpenAI, Gemini, OpenRouter and compat adapters on `model/http.ts`, Gemini's tool
  transform, calibration profiles (`perfidia-profile/1`) and `arena calibrate`, smokes per model,
  then `budget-mix` (the cross-provider exit) and `mid-tier`.

## 25. The review's fixes

The Pass 1 review (money and correctness lenses, 25 findings) was checked finding by finding
against this code; every one held. Each fix has a regression test (most in
`arena/review.test.ts`; the file names otherwise), and the money ones were checked against a
mutant of the old code where the test is new. Verdicts: **fixed** unless stated.

| #   | Finding (severity)                                                                          | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Test                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | The kill switch was not fail-safe: a throwing `onKill` left every seat running (major)      | `MatchBudget.add` sets the flag, runs the ledger's halt, then `onKill`, each hook guarded (`onError` reports, nothing is skipped); `over()`/`halted` read the kill flag itself; a charge counts toward the match before the cap's hand-off hook; preflight checks are counted before their line is written; the arena's `onKill` aborts and alerts before writing                                                                                                                                                     | `budget/ledger.test.ts` (fail-safe); the ENOSPC run; the scheduler property with failing hooks (100 runs, seed 1919; the old order fails it) |
| M2  | US-only inference (1.1×) was not modelled (major)                                           | `usage.inference_geo` is read on every response (`UsageEntry.geo`, logged as `usage[].geo`); Claude cards list `geo: { us: 1100 }` (pricing page, data residency, checked 2026-10-20); attempts are priced at the reported geography (`+us` card ids); every bound takes the 1.1× prices; the start preflight refuses a non-global workspace (exit 3, the Console setting named); a mid-run `us` attempt is an alert. The request bytes are unchanged (no `inference_geo` sent: a Pass 2 decision)                    | `model/prices.test.ts`, `model/bound.test.ts` (the worst US attempt is the bound), the geo preflight refusal                                 |
| M3  | `--budget-carry` lost a crashed run's in-flight attempts (major)                            | The carry adds the carried run's `estimate.json` reserve unless its `arena.json` says `ended`, `stopped` or `degraded` (`carry.inFlightNanoUsd`; refused without a readable estimate; no "attempt started" line was added: the reserve bounds what a dead run had in flight, with or without transcripts); signals are subscribed before the start preflight (a signal there stops it between groups, nothing written, exit 3); SIGHUP counts; a third signal writes an `operator` line (`exit`) before the CLI exits | carry of a run left `running`; the start-preflight signal; three signals; the process source with SIGHUP                                     |
| M4  | A key echoed by the upstream reached logs (minor)                                           | The Anthropic client redacts its key (raw and URL-encoded) from every `ModelError` message; `http.ts`'s `transportError` and `httpModelError` take the same secrets                                                                                                                                                                                                                                                                                                                                                   | adapter errors (401, 500) and the whole CLI against a loopback stub echoing the key (mutant without redaction: both fail)                    |
| M5  | The token check ignored estimated output (minor)                                            | An output count down to `ledger − estimated − 2%` is accepted; `reconcile.json` token rows carry `estimated`                                                                                                                                                                                                                                                                                                                                                                                                          | the reviewer's 651K + broken 16K case; `tokensWithin` boundaries                                                                             |
| M6  | A stream broken after a fallback switch missed the target's iteration (minor, plausible)    | The adapter records each `fallback` block's `to.model`; a broken stream adds one estimated cold iteration per switch (whole prompt written at the request's TTL, full `max_tokens`), and charges the refused iteration on the requested model (the SDK's snapshot takes the target's id)                                                                                                                                                                                                                              | an SSE stub that switches to Claude Opus 5 then ends: +$1.35, within Opus 5.5's bound                                                        |
| M7  | A served id without a card bills at `MAX_CARD`, ~27× the bound (minor)                      | The preflight refuses a check served under an unpriced id; a mid-run unpriced attempt is an alert                                                                                                                                                                                                                                                                                                                                                                                                                     | a shape check served as `claude-haiku-5-5-20261101`                                                                                          |
| M8  | The smoke's "at most" was not a bound for Opus 5.5 (minor)                                  | `smokeBoundNano` is the bound of the real requests (one token per byte of the shape check and the call, cold, 4,000 output tokens, no retry, both fallback targets of Opus 5.5, US prices, 5-minute writes): Haiku 5.5 $0.010969, Sonnet 5.5 $0.219392, Opus 5.5 $1.535745 (was $0.0054 and $0.2175)                                                                                                                                                                                                                  | `arena/smoke.test.ts`: the worst Opus requests cost the bound to 10 nUSD                                                                     |
| M9  | `withinPrediction` compared preflight and probes with an attempts-only prediction (nit)     | It compares the attempt spend; the preflight and probes are reported apart and still count in `under`                                                                                                                                                                                                                                                                                                                                                                                                                 | `arena/phase4.test.ts` (the 2-day run)                                                                                                       |
| M10 | An early reconcile filled `exit4.reconciled` (nit)                                          | Under 48 hours, `reconciled` stays `null` unless `--force` (the CLI says so)                                                                                                                                                                                                                                                                                                                                                                                                                                          | a run 24 hours old, with and without `force`                                                                                                 |
| M11 | A charge that threw lost a billed attempt (nit)                                             | A usage the pricer cannot price is charged the seat's attempt bound (`Charge.invalidUsage`); its line logs the unusable counts as 0, `estimated: true`                                                                                                                                                                                                                                                                                                                                                                | `budget/ledger.test.ts`; a fake run whose p2 reports NaN and 1e300 tokens                                                                    |
| C1  | A `--seat` override ignored `defaults.fallbacks` (major)                                    | Overrides take the lineup's defaults; a `comparison: true` lineup with any seat's fallbacks on is refused                                                                                                                                                                                                                                                                                                                                                                                                             | `mid-tier` with `--seat p1=claude:opus-5-5:…`; the refusal                                                                                   |
| C2  | `exit4.met` could be true on a `--fake` run (minor)                                         | `met` needs a real run; the docs say a fake run rehearses the path                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `exit4Met` part by part                                                                                                                      |
| C3  | OpenRouter refusals untested; a provider-only slug got the wrong message (minor)            | Tests through the `endpoints` hook (ZDR, `tool_choice`, `x` with sibling `x/y`); an unresolved pin that prefixes known endpoints names them                                                                                                                                                                                                                                                                                                                                                                           | the four cases                                                                                                                               |
| C4  | Reconcile's excess band, `exit4Met`'s parts and the SSE lone-CR guard were unpinned (minor) | Tests: a report between `ledger − excess − tol` and `ledger − tol`; every part of `exit4Met` flipped alone; a CRLF split inside a multi-line `data:` event                                                                                                                                                                                                                                                                                                                                                            | `arena/review.test.ts`, `model/http.test.ts`                                                                                                 |
| C5  | `readSse` dispatched an event cut at the end of the body (minor)                            | An event the body ends inside is discarded (the SSE rule): a body cut inside its terminal event is a broken stream                                                                                                                                                                                                                                                                                                                                                                                                    | `model/http.test.ts` (the reviewer's probe)                                                                                                  |
| C6  | Per-seat `toolsHash`/`operatorHash` were constants (minor)                                  | Each seat's tools go through its provider's transform (`toolsFor`, the `TOOL_TRANSFORMS` registry: the identity only) to the agent, the preflight and the hash; `operatorHash` hashes the channel's rendering (`system` keeps phase 2's)                                                                                                                                                                                                                                                                              | a fake `mid-tier` run's `seats.json`                                                                                                         |
| C7  | Gemini's dearer card on the whole last listed day failed reconciliation (minor)             | Kept conservative in the ledger (the money side); cards carry `uncertainUntil` (the next day 12:00 UTC) and reconcile counts the difference with the earlier card as excess                                                                                                                                                                                                                                                                                                                                           | an Argon line inside the window, reported at $2                                                                                              |
| C8  | `ArenaReportSchema` rejected `perfidia-arena/1` (minor)                                     | `ArenaReportV1Schema` (ec8e2ad's) and `ArenaReportAnySchema` (the reader's union); ec8e2ad's invalid case (`/2` under the `/1` schema) restored there; `arena reconcile` names an old report's version                                                                                                                                                                                                                                                                                                                | `protocol` fixtures                                                                                                                          |
| C9  | GLM-5.3's default effort is max while presets send medium (minor)                           | **Deferred** (the mapping is chosen with Pass 2's OpenRouter adapter and its smoke, before the first comparison: no OpenRouter request exists in this build). The warning now says the default is max and what it does to parity and the prediction; the catalog records each routed model's `default_effort` (DeepSeek's is high)                                                                                                                                                                                    | the warning's text                                                                                                                           |
| C10 | `compat` seats pointed at a missing card file (minor)                                       | `model/prices/compat.ts` exists (no card: the owner states an endpoint's prices) and is part of `ALL_CARDS`; §18 says a compat seat needs its card                                                                                                                                                                                                                                                                                                                                                                    | the refusal names the file, which exists                                                                                                     |
| C11 | `claude-family`'s $180 broke the design's rule (nit)                                        | $190 (high $168.92 + reserve $20.33, rounded up): K $169.67, no warning; $180 still plans with the warning                                                                                                                                                                                                                                                                                                                                                                                                            | `arena/phase4.test.ts`                                                                                                                       |
| C12 | Stale figures; the start preflight did not stop (nit)                                       | Figures refreshed (§2, §4, §7, §10, §11); the start preflight stops between groups on a signal or a kill (a carry at K)                                                                                                                                                                                                                                                                                                                                                                                               | the start-preflight signal test                                                                                                              |
| C13 | The turn header's "user turn above" for envelope seats (nit)                                | "The text part above" for `envelope`; `system` bytes (and ec8e2ad's hash) unchanged; no envelope seat has run for real, so `PROMPT_VERSION` stays 2                                                                                                                                                                                                                                                                                                                                                                   | the per-seat hash test                                                                                                                       |
| C14 | `arena smoke` crashed on a non-loopback `http:` base URL (nit)                              | The plan's check (`checkedBaseUrl`) runs first: exit 3, no stack                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `arena/smoke.test.ts`                                                                                                                        |

**Measured** on the shared 4-vCPU container: the orchestrator suite (290 tests in 37 files, 6 of
them skipped without the live key) in 44 s; `arena/review.test.ts` (22 tests) takes 12 s alone. The fake runs
of §2, §11 and §23 spend what they spent before the review ($5.150819930 for the 7-day
`claude-duo`, $14.42 for `mid-tier`, $1.86 for `budget-mix`): fake usage reports no geography, and
the predictions moved only by their reserves.

**What did not change.** The engine, gateway, bots and sim; goldens, fingerprints and fixtures
(the protocol fixtures only gained cases); the Anthropic request bytes and labels (ec8e2ad's,
`arena/pins.test.ts`); no dependency. Every new field (`usage[].geo`, `carry.inFlightNanoUsd`,
`operator.action: exit`, reconcile token `estimated`) is optional or a new enum value, so the
spectator and the server read old and new run directories alike.

---

# Part III: Pass 2, adapters and calibration

## 26. What Pass 2 delivers

Four agents built Pass 2 in parallel (design §10); an integration step merged them, added the
cross-adapter conformance suite and the four-provider wire-stub match (§34), and filled the gaps
listed in §34.4. Every provider of the registry now runs for real:

| Provider     | Adapter (raw `fetch` through `model/http.ts`)                               | Wire schemas           | Registry `create`                     | Smoke                                         |
| ------------ | --------------------------------------------------------------------------- | ---------------------- | ------------------------------------- | --------------------------------------------- |
| `anthropic`  | `model/anthropic.ts` (the SDK on the guarded fetch, unchanged since Pass 1) | the SDK's types        | built by `arena/run.ts` on its client | `arena smoke` (phase 2's, `--record` added)   |
| `openai`     | `model/openai.ts`: the Responses API, streamed                              | `model/wire/openai.ts` | `arena/providers/openai.ts`           | `arena smoke --provider openai`               |
| `google`     | `model/gemini.ts`: `generateContent`, `streamGenerateContent?alt=sse`       | `model/wire/gemini.ts` | `arena/providers/gemini.ts`           | `arena smoke --provider google` (or `gemini`) |
| `openrouter` | `model/compat.ts` (mode `openrouter`): Chat Completions, pinned endpoint    | `model/wire/compat.ts` | `arena/providers/compat.ts`           | `arena smoke --provider openrouter`           |
| `compat`     | `model/compat.ts` (mode `compat`): any OpenAI-compatible base URL           | `model/wire/compat.ts` | `arena/providers/compat.ts`           | none (no card ships: §30.6)                   |

And, from agent E: calibration profiles (`arena calibrate`, `packages/orchestrator/profiles/`),
profile-based predictions (`measured-point` and `calibrated` sources) and rotated series
(`arena series`, seeded Latin and Graeco-Latin squares), §33.

What did not change: the engine, gateway, bots and sim; goldens, fingerprints and the existing
fixtures (new fixture files only); the Anthropic request bytes and labels (`arena/pins.test.ts`
passes unchanged); `package.json` and `bun.lock` (no dependency, no `bun install`). Protocol
changes are additive: the seats file's `effortSent` (OpenRouter), the profile round's
`cacheWriteTokens`, and `SeriesManifestSchema` (`perfidia-series/1`).

No real API was called while building Pass 2: no key exists in the build container. Everything
below that concerns a provider's behaviour comes from its documentation, read on 2026-10-20 and
cited per adapter, and is pinned by fixtures marked `synthetic: true` until the owner's recorded
smokes replace them (§32). One stray request happened while the OpenAI adapter was built (a Pass
1b test whose "no adapter" refusal stopped holding reached `api.anthropic.com` with the dummy key
`k`: one models request, HTTP 401, nothing billed); that test now uses loopback base URLs only.

## 27. The adapter contract in Pass 2

- **The registry builds every seat** (`arena/providers.ts`): `ProviderInfo.create(spec, env)` with
  `AdapterEnv {apiKey, baseURL, time, timeoutMs, fetch?}`. The key is the plan's
  (`PERFIDIA_<PROVIDER>_API_KEY`, null only for `compat` on loopback), the base URL the plan's
  checked one (`PERFIDIA_<PROVIDER>_BASE_URL` or the default), `timeoutMs` the plan's attempt
  timeout, `fetch` a test stub (the guard still applies). `arena/run.ts` builds Anthropic seats on
  its SDK client and every other real seat through `create`; `arena smoke --provider openai` uses
  the same factory. `baseUrlProblem` (OpenAI: the regional hosts) and `smoke` (default model and
  effort) are optional registry fields.
- **The plan checks every base URL** (`arena/plan.ts`): `https:`, or `http:` on loopback, for every
  provider (exit 3), then the provider's own `baseUrlProblem`.
- **`ChatRequest.promptTokensUpper`** (additive): the seat's prompt-cap estimate of the request,
  at most the cap. An adapter whose provider reports usage only at the end of a stream (OpenAI)
  charges a broken stream this prompt at its dearest prompt-side price plus the full output limit,
  which stays inside the attempt bound.
- **Money rules, the same for every adapter** (MONEY SAFETY first: the ledger's charge is never
  below what the provider bills):

| Case                                        | Anthropic                                 | OpenAI                                              | Gemini                                                                                                                                                                                                     | OpenRouter / compat                                                                                                             |
| ------------------------------------------- | ----------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Final usage                                 | mapped (Pass 1)                           | mapped (§28.3)                                      | mapped (§29.4)                                                                                                                                                                                             | mapped (§30.3); `usage.cost` recorded, output topped up if it exceeds the card                                                  |
| Usage missing, unparseable or contradictory | attempt bound (`invalidUsage`)            | attempt bound (`unknown`, `invalidUsage`)           | estimate: prompt count, else `promptTokensUpper` (at most the request bytes), + full output limit; a final usage without `totalTokenCount`, or with no output for a reply that has some, counts as missing | attempt bound (non-finite marker → `invalidUsage`), also for a usage too large to price exactly                                 |
| Stream accepted, broken before its usage    | `message_start` usage + full `max_tokens` | `promptTokensUpper` at the write price + full limit | estimate as above; broken after the finish: the larger of the last usage and the estimate, kind by kind                                                                                                    | the turn's last measured prompt + appended entries, else the attempt bound; + full `max_tokens` + OpenRouter's completion slack |
| HTTP error before a body                    | nothing (phase 2)                         | nothing                                             | nothing; a 504 is charged the estimate                                                                                                                                                                     | nothing; a timeout or abort before the headers is charged                                                                       |
| Error event before any output               | n/a                                       | charged (`spent` of the event)                      | charged (the estimate)                                                                                                                                                                                     | OpenRouter: nothing (zero completion insurance), but a length-type error is charged; compat: the estimate                       |
| Served model or tier other than the card's  | refused at preflight (Pass 1 review M7)   | refused at preflight (unpriced id)                  | billed at the dearest card (unpriced id), refused at preflight                                                                                                                                             | dated `-YYYYMMDD` id accepted; another endpoint refused (`bad_request`)                                                         |

The conformance suite (§34.1) checks the broken-stream row on all four adapters. And whatever the
adapter: a rejection that is not a `ModelError` (a bug, a pricing error after the request ran) is
charged one unpriceable entry, the seat's attempt bound, by `LlmSeatAgent` (§40).

## 28. OpenAI: the Responses API (`model/openai.ts`)

### 28.1 Request

`POST {PERFIDIA_OPENAI_BASE_URL or https://api.openai.com/v1}/responses`, streamed, `authorization:
Bearer <key>`:

- `store: false`; `include: ["reasoning.encrypted_content"]`; `service_tier: "default"`;
  `truncation: "disabled"`; `max_output_tokens`; no sampling parameter.
- `reasoning: {effort, summary: "auto"}`, plus `context: "all_turns"` only where the catalog pins it
  (GPT-6.1 Sol). An effort the model does not take is refused by the plan (exit 3) and by the
  adapter, naming the accepted levels.
- Tools with an explicit `strict: false` (else Responses normalises the schema to strict mode);
  `tool_choice: "auto"`; `parallel_tool_calls: true`.
- `prompt_cache_options: {mode: "implicit", ttl: "30m"}` (a deviation from design §2.3, §38). The
  request-level `ttl` applies to the implicit breakpoint and to the seat block's explicit one (it
  has no `ttl` of its own), so the adapter never asks for the 12-hour lifetime.
- `input`: a `developer` message with the shared block, a `developer` message with the seat block
  (with an explicit `prompt_cache_breakpoint`), then the turn: the briefing as a `user`
  `input_text`, results as `function_call_output` items (string output), operator entries as
  `developer` messages, replies echoed as their output items verbatim (encrypted reasoning and
  `phase` kept).

### 28.2 Stops and errors

- `completed` → `tool_use` or `end_turn` (`refusal` when the output has a refusal part).
  `incomplete` with `max_output_tokens` → `max_tokens` (the seat retries once at 65,536);
  `content_filter` → refusal; other incomplete reasons → `other`. A cut reply keeps what it got
  (§34.4).
- `failed` and in-stream `error` events, by code: `misalignment_policy_violation` (category
  `misalignment`), `bio_policy` and `invalid_prompt` → refusal; `rate_limit_exceeded`/`slow_down` →
  `rate_limit`; `server_error`, `vector_store_timeout` → `server`; `server_is_overloaded` →
  `overloaded`; quota and spend codes → `billing`; `data_residency_mismatch` → `auth`; image codes →
  `bad_request`; else `unknown`.
- HTTP errors (`classifyHttpError`, code before status): 429 with `credit_balance_exhausted`,
  `project_spend_limit_exceeded`, `organization_spend_limit_exceeded`,
  `organization_usage_limit_exceeded` or type `insufficient_quota` → `billing` (operator pause);
  other 429s → `rate_limit` with `Retry-After`; 403 `misalignment_policy_violation` → refusal, no
  charge, not retried; 503 `server_is_overloaded` → `overloaded`; 401/403 → `auth`; 404 →
  `not_found`. An error naming `reasoning.summary` (or a 400/403 about organisation verification)
  → `auth` with the help URL (its shape is unverified).
- Arguments that are not JSON are passed raw, so the gateway answers `INVALID_ARGS`.

### 28.3 Usage

`input = input_tokens − cached_tokens − cache_write_tokens` (the prompt-caching guide's own cost
formula: `input_tokens` includes cached and written tokens, which settles the design's
"unverified"); writes split by `input_tokens_details.cache_write_tokens_details`: `ttl_30m_tokens`
in the short bucket (`cacheWrite5m`, 1.25× input), `ttl_12h_tokens` in the long one
(`cacheWrite1h`, 2.5× input: the cards' long write price is the pricing page's "12h write"
column, §40); without the split, every write is a 30-minute one (the lifetime the request asks
for); a split that does not sum to `cache_write_tokens` is invalid; `cacheRead = cached_tokens`;
`output = output_tokens` (reasoning included); `reasoning = reasoning_tokens`. A usage that is missing, fails the schema, contradicts itself (cached + written

> input, reasoning > output) or comes from a non-default tier fails `unknown` and is charged the
> attempt bound.

### 28.4 Preflight, count, plan

`GET /models/{id}`, then the production shape at `max_output_tokens: 16`, streamed and charged (a
refusal fails it). `countTokens`: `POST /responses/input_tokens` with `{model, input, tools,
tool_choice, parallel_tool_calls, reasoning, truncation}`. The plan refuses `us.` and
`eu.api.openai.com` (regional processing bills +10% and no card exists for it).

Sources (read 2026-10-20, fetched as `.md`): `developers.openai.com/api/reference/resources/responses/methods/create`,
`…/responses/streaming-events`, `…/responses` ("Get input token counts"), `…/models/methods/retrieve`,
`api/reference/overview`, `docs/guides/{prompt-caching, reasoning, function-calling, error-codes,
rate-limits, spend-limits, safety-checks/misalignment-monitoring, conversation-state, your-data,
streaming-responses}`, `docs/pricing`, `docs/models/*`. Price cards re-checked against the four
model pages and the pricing page's Standard table (long-context columns included): no difference.

## 29. Gemini: `generateContent` (`model/gemini.ts`)

### 29.1 Request

`POST {PERFIDIA_GOOGLE_BASE_URL or https://generativelanguage.googleapis.com}/v1beta/models/{model}:streamGenerateContent?alt=sse`,
key in `x-goog-api-key` only (never in a URL; redacted raw and URL-encoded from every error):

- `systemInstruction.parts`: the shared block, then the seat block.
- `tools[0].functionDeclarations` with `parametersJsonSchema` through the `gemini@1` transform
  (§29.2); `toolConfig.functionCallingConfig.mode: "AUTO"`.
- `generationConfig: {maxOutputTokens (≤ 65,536), thinkingConfig: {thinkingLevel: LOW|MEDIUM|HIGH
  from the seat's effort, includeThoughts: true}}`; `store: false`.
- Not sent: sampling parameters, `cachedContent`, `serviceTier` (omitted means standard; Flex and
  Priority are off).
- Model turns are replayed exactly as received (parts never merged or reordered, thought
  signatures kept); results are `functionResponse` parts `{id (when the model gave one), name,
  response}` (the gateway's JSON object, else `{result: …}`); operator text is a `[harness] ` text
  part appended to the same user content; an empty model reply is not replayed.

### 29.2 The `gemini@1` tool transform (`model/gemini-tools.ts`)

`const` → `enum: [v]`; an integer `exclusiveMinimum n` → `minimum n+1` (on other types it moves
into the description); `pattern` and `propertyNames.pattern` move into the description; any keyword
outside Gemini's documented subset fails the build naming `gemini@1`; `anyOf`/`oneOf` pass (they
are in the subset). Idempotent. `toolsHash` of perfidia-1@1.1.0 and @1.0.0 for Google seats, real
and fake: `39f0993453961cc79f3e9824a302377c5117f66e236e7cc90ead46f488428dc3`; every other
provider keeps the neutral list's.

### 29.3 Finish reasons and errors

`STOP` → `end_turn`/`tool_use`; `MAX_TOKENS` → `max_tokens` (one retry at the model's maximum);
`SAFETY`, `RECITATION`, `PROHIBITED_CONTENT`, `SPII`, `BLOCKLIST`, `IMAGE_SAFETY` and a
`promptFeedback.blockReason` → refusal with an empty reply; `MALFORMED_FUNCTION_CALL` and other
reasons → `other` (outside the breaker since the integration, §34.4); `MISSING_THOUGHT_SIGNATURE` →
`bad_request` (usage kept); `PUP_LIMITED_DISABLED` → `auth`. `classifyGeminiError` adds to
`classifyHttpError("google")`: `ErrorInfo.reason` `API_KEY_*` → `auth`; `FAILED_PRECONDITION` →
`billing`; `RetryInfo.retryDelay` when there is no `Retry-After`; 402 (Prepay at $0) → `billing`;
429 → `rate_limit`.

### 29.4 Usage

`input = promptTokenCount − cachedContentTokenCount + toolUsePromptTokenCount`; `cacheRead =
cachedContentTokenCount` (the implicit-cache price); `output = candidatesTokenCount +
thoughtsTokenCount + whatever part of totalTokenCount the known counts do not explain`; `reasoning
= thoughtsTokenCount`. Usage counts as final only with or after the finish reason, and the stream
is read to the end of its body: `usageMetadata` is cumulative and the last one counts ("Keep only
the last value of each stream", `gemini-api/docs/generate-content/long-decode.md.txt`, read
2026-10-20). A final usage without `totalTokenCount`, or with no output for a reply that has text
or a call, is charged the estimate (§40). A served model
(`modelVersion`) other than the one requested, or a tier other than standard/unspecified, is billed
under an unpriced id (the dearest card) and refused at preflight.

### 29.5 Preflight and count

`models.get` must list `generateContent` and an `outputTokenLimit` at least the seat's caps; then
one non-streaming `generateContent` at 16 output tokens, charged. `countTokens` is implemented (the
billing page says it is not billed; the smoke's bound counts it as input anyway).

Sources (read 2026-10-20, `.md.txt`): `ai.google.dev/api/generate-content`, `…/api/models`,
`…/api/tokens`, `gemini-api/docs/generate-content/{thinking, thought-signatures, api-errors}`,
`…/docs/{billing, rate-limits, text-generation, structured-output, pricing}`,
`…/docs/models/gemini-4-argon`, the caching page, and `googleapis/google/rpc/error_details.proto`.
Cards re-checked: Gemini 4 Argon $2 / $10 / $0.10 per MTok through Nov 30 ($4 / $20 / $0.20 from
the change), Gemini 3.8 Flash $0.75 / $3.75 / $0.075 through Dec 31 ($1.50 / $7.50 / $0.15 after);
no long-context tier. On the free tier, 3.8 Flash data is used for training: use a paid key.

## 30. OpenRouter and OpenAI-compatible endpoints (`model/compat.ts`)

### 30.1 Request (mode `openrouter`)

`POST {PERFIDIA_OPENROUTER_BASE_URL or https://openrouter.ai/api/v1}/chat/completions`, streamed,
`authorization: Bearer <key>`, `X-OpenRouter-Metadata: enabled`:

- `model`, `messages`, `tools`, `tool_choice: "auto"`, `max_tokens`, `reasoning: {effort}` (the
  level sent, §30.4), `stream: true`, and `provider: {only: [full slug], allow_fallbacks: false,
  require_parameters: true, data_collection: "deny", zdr: true when the pin is ZDR-listed}`.
- `parallel_tool_calls` only when the pinned endpoint lists it (`z-ai/fp8` does not). No
  `max_price`: the ledger and the plan-time price check bound spend.
- Messages: `system` (shared), `system` (seat), the briefing as a `user` message, the turn header
  as a separate `user` message `[harness] …`, results as `{role: "tool", tool_call_id, content}`,
  operator entries as `user` messages `[harness] …`, assistant replies echoed verbatim
  (`reasoning_details` unmodified; plain `reasoning` only when there are no details).
- Mode `compat`: `PERFIDIA_COMPAT_BASE_URL` required, no key on loopback,
  `stream_options.include_usage`, no `provider` object, no reasoning echo.

### 30.2 The served-endpoint check

The routing metadata on the final chunk must show exactly one selected endpoint whose provider is
the pin's (`ENDPOINT_PROVIDERS` in `arena/providers/compat.ts`: `z-ai/fp8` → Z.AI,
`moonshotai/mxfp4` → Moonshot AI, `together` → Together; read 2026-10-20) and whose model is the
seat's (a dated `-YYYYMMDD` suffix is accepted). A mismatch or missing metadata is charged its usage
and fails `bad_request`, not retried.

### 30.3 Usage and the reported cost

`input = prompt_tokens − cached_tokens − cache_write_tokens` (inconsistent fields: `input =
max(prompt, cached + written)`, nothing counted as a read); `cacheRead = cached_tokens`;
`cacheWrite5m = cache_write_tokens`; `output = completion_tokens`, raised to `reasoning_tokens` when
a provider reports more reasoning than completion. `usage.cost` (credits = USD) →
`reportedCostNanoUsd = ceil(cost × 10⁹)`; when it exceeds the card cost (fee excluded) by more than
1 nano, output tokens are added (at the output price, rounded up) and the entry is `estimated`.
The 5.5% fee is charged by the card and logged apart (`feeNanoUsd`).

### 30.4 Efforts (C9 settled as built; the Pass 2 review made it explicit)

`effortSent(provider, model, effort)`: the nearest level the model lists on the `EFFORTS` ladder; a
tie goes to the lower level (the harness's rule: OpenRouter documents only "the nearest supported
level"); never `none` unless asked. GLM-5.3 and GLM-5.3 Flash list max, high and low: `medium` is
sent as `low` (`xhigh` as `high`, `minimal` as `low`). Recorded as `seats.json` `effortSent` (fake
runs too, since the review), in the plan warning and in the smoke line; unverified until a smoke
records the reasoning tokens.

**In a comparison lineup the label is the level sent** (review): the plan refuses (exit 3) an
effort the model does not list, naming its levels, and the four comparison presets set their
OpenRouter seat's effort explicitly to `low` (what the requests already carried), so the label,
the spectator's `SeatModel`, the profile key and the prediction (low's output factor 0.6) all say
`low`. Whether GLM runs at `low` or `high` next to the others' `medium` is an owner decision (§36).
Outside a comparison lineup the nearest-level mapping and its warning stay.

### 30.5 Plan time: `planLive`

A real `arena run` (and, since the integration, a real `arena series`) with OpenRouter seats fetches
`GET {base}/endpoints/zdr` and `GET {base}/models/{id}/endpoints` (public, no key) and re-plans on
them. Refused (exit 3, nothing written, nothing sent to a model): a live price above the card in
any kind (prompt, completion, cache read, cache write, 1-hour write, overrides included), an
`internal_reasoning` price above the card's output price (reasoning is charged as output), any
per-request price, or a price under a key the plan does not know (the documented image, audio and
web-search prices are ignored: a seat never sends any); another provider name; a sent or required parameter no longer listed;
`tool_choice` auto not supported; context under 200K; `max_completion_tokens` under twice
`maxTokens`; a pin missing from the ZDR list while `zdr` is set; a metadata request that fails.
Warnings: a cheaper live price (the ledger over-charges; `arena reconcile` shows by how much), a
negative status, another quantization. `arena estimate`, `--fake` and the tests use the 2026-10-20
snapshot.

### 30.6 Errors, preflight, cards

Errors: `limit_source`, 402, 503 or moderation → `classifyHttpError`; then the typed
`metadata.error_type`; then the status (400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503, 524,
529 all mapped). Mid-stream `error` events are classified the same way; on OpenRouter an error event before any
output is not charged (zero-completion insurance), unless it is a length-type error (a generation
that ran to `max_tokens`: billed, charged the estimate); in compat mode it is charged the estimate;
a 200 JSON body holding only an error is not billed (OpenRouter, length-type errors aside). A
broken stream's output charge, and the attempt bound, add OpenRouter's completion slack (1% + 16
tokens: `max_tokens` bounds reasoning plus output only "on most providers", and the docs' own
example bills `completion_tokens: 302` for `max_tokens: 300`). `finish_reason` `length` (or a `max_tokens_exceeded` error) → `max_tokens`;
`content_filter` → refusal; anything else → `other`. Preflight: `GET /models/{id}/endpoints` must
list the pin, then one shape check at `max_tokens` 16. Cards (`model/prices/openrouter.ts`)
re-verified against the live endpoints JSON of 2026-10-20: GLM-5.3 1.40/4.40/0.26, GLM-5.3 Flash
0.15/0.50/0.03, Kimi K3 3/15/0.30, DeepSeek V4.1 Flash 1017 on `together` 0.30/1.20/0.006 USD per
MTok; no difference. `model/prices/compat.ts` ships no card: a `compat` seat stays refused at plan
time until the owner adds one.

Sources (OpenRouter docs, read 2026-10-20): API reference overview, streaming,
errors-and-debugging, router-metadata, reasoning-tokens, provider-selection, zdr, usage accounting,
zero-completion insurance, FAQ (5.5% fee), the chat completions OpenAPI; the endpoints JSON.

## 31. The wire mapping at a glance

| Need             | Anthropic (SDK)                          | OpenAI Responses                                 | Gemini                                          | OpenRouter / compat                                   |
| ---------------- | ---------------------------------------- | ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------- |
| Endpoint         | `/v1/messages?beta=true`, streamed       | `/responses`, streamed                           | `:streamGenerateContent?alt=sse`                | `/chat/completions`, streamed                         |
| Key              | `x-api-key`                              | `authorization: Bearer`                          | `x-goog-api-key`                                | `authorization: Bearer` (none for compat on loopback) |
| Stable blocks    | two `system` blocks with `cache_control` | two `developer` messages (seat: breakpoint)      | two `systemInstruction` parts                   | two `system` messages                                 |
| Operator channel | mid-conversation `system` message        | mid-input `developer` message (`-dev`)           | `[harness]` text part (`-env`)                  | `[harness]` user message (`-env`)                     |
| Results          | `tool_result` blocks                     | `function_call_output` items                     | `functionResponse` parts (id, name)             | `tool` messages                                       |
| Rejected result  | `is_error: true` and the gateway's JSON  | the gateway's `ok:false` JSON only               | the gateway's `ok:false` JSON only              | the gateway's `ok:false` JSON only                    |
| Reply echo       | content blocks (thinking signed)         | output items (encrypted reasoning)               | parts verbatim (thought signatures)             | assistant message verbatim (`reasoning_details`)      |
| Cache            | explicit, 5 min / 1 h                    | implicit, 30 min, plus the seat-block breakpoint | implicit only (no writes)                       | the endpoint's                                        |
| Prompt in usage  | `input + cache_creation + cache_read`    | `input_tokens` (includes read and written)       | `promptTokenCount` (includes cached) + tool-use | `prompt_tokens` (includes read and written)           |
| Reasoning tokens | not split (null)                         | `reasoning_tokens`                               | `thoughtsTokenCount` (billed as output)         | `reasoning_tokens`                                    |
| Max-output stop  | `max_tokens`                             | `incomplete: max_output_tokens`                  | `MAX_TOKENS`                                    | `length`                                              |
| Reasoning shown  | summary                                  | summary                                          | summary (`thought: true` parts)                 | raw text, or a summary when the provider sends one    |

`reasoningKind` is `none` on every provider when a reply carries no reasoning text (the review: one
coverage statistic). The `is_error` flag is a known interface difference, phase 2's and pinned for
Anthropic (`arena/pins.test.ts`): the other three providers have no such field on a tool result,
and every provider reads the same `ok:false` JSON with its code and hint (design §2.3).

## 32. Synthetic, unverified, and the owner's recordings

**Fixtures.** `model/fixtures/openai/*.json`, `model/fixtures/gemini/*.json` and the OpenRouter
`stream-*.json`, `errors.json`, `json-200-error.json` and `compat/stream-openai-style.json` are
written from the documentation and marked `synthetic: true`, each with its sources and read date.
OpenRouter's `endpoints-*.json` and `zdr.json` are real responses (`synthetic: false`, fetched
2026-10-20, trimmed).

**Unverified until a real call** (each pinned only by synthetic fixtures; the first recorded smoke
settles most of them):

- OpenAI: acceptance and turn semantics of mid-input `developer` messages; `max_output_tokens: 16`
  in the preflight; whether `prompt_cache_options` implicit mode plus the seat breakpoint caches as
  the guide says on GPT-6 models; the organisation-verification error's shape; whether a broken
  stream or a 403 misalignment block is billed (we charge the estimate for the first, nothing for
  the second); whether `response.model` is the alias or a dated id (a dated id has no card: the
  preflight would refuse the run); whether `reasoning.context` is echoed. The usage policies page
  was not readable (403).
- Gemini: implicit cached tokens inside `promptTokenCount`; upper-case `thinkingLevel` over REST and
  MINIMAL refused by Argon and 3.8 Flash; text parts next to `functionResponse` parts; replaying
  many small streamed parts unmerged; `modelVersion` equal to the requested id (else every attempt
  is priced at the dearest card and the preflight refuses); the tier spend-cap error's shape; the
  shape of an error inside the SSE body; billing of aborted or timed-out requests; `countTokens`
  being free; every keyword `gemini@1` sends being accepted; the 16-token preflight when thinking
  takes the whole budget; the cost of replayed signatures.
- OpenRouter: `openrouter_metadata` on streamed responses with the opt-in header (the adapter
  refuses a reply without it: if absent, every call fails at once and the smoke shows it); two
  `system` then two `user` messages in round 0; `reasoning_details` versus plain `reasoning` from
  GLM; what `low` does on GLM-5.3 (C9); `require_parameters` at run time; 404 or 503 for a pinned
  endpoint that is down; `pricing.discount`; whether `usage.cost` includes the fee (assumed not, per
  the FAQ); dated model ids; `cache_write_tokens` on `z-ai/fp8`; whether `completion_tokens` stays
  within `max_tokens` on `z-ai/fp8` (the docs say "on most providers"; the adapter and the bound
  add a 1% + 16-token slack, §40).
- Added by the Pass 2 review: OpenAI's `cache_write_tokens_details` on the GPT-6 models (the guide
  says both lifetimes are always returned; without the split the adapter prices every write as a
  30-minute one, the lifetime it asks for); Gemini's usage after the finish chunk (the adapter now
  reads to the end of the body and keeps the last cumulative usage); OpenRouter's
  `internal_reasoning` price on `z-ai/fp8` (absent on 2026-10-20).

**`arena smoke --record <dir>`** (built by the integration, §34.4) writes every exchange of a smoke
as one `perfidia-recording/1` file (`arena/record.ts`), numbered in arrival order: the request
(method, URL, body) and the response (status, content type, body or, for a stream, its events),
with every key (raw and URL-encoded) replaced by `<key>`, every id field (response, message, call,
generation, request, organisation, project and user ids) replaced by `<id-N>` consistently across
the recording (a call and its result still match; the provider's model ids are kept), and no
header kept but the content type. `recordedResponse(file)` serves a recorded response again, so a
contract test can replay it through the real adapter (`arena/record.test.ts` does, for each
provider). Account identifiers inside free text (OpenAI `org-…`, `proj_…`, `req_…`; Google
`projects/<n>`, `project <n>`, `project=<n>`; OpenRouter `gen-…`) and the `consumer` field are
replaced too (the review), and the directory is created with the first exchange, so a smoke
refused before it sends anything leaves none. How the recordings replace the synthetic fixtures: the owner commits the directory under
`packages/orchestrator/src/model/fixtures/<provider>/recorded/` and sends it back; the next step
points each contract test that pins an unverified item at the recorded exchange, and fixes the
adapter where the recording disagrees with its synthetic twin.

## 33. Calibration and series (agent E)

### 33.1 `arena calibrate`

`bun run arena -- calibrate <run-dir>... [--profiles <dir>]` writes one `perfidia-profile/1` file
per key (provider, model, endpoint, effort, prompt variant, cadence, `maxTokens`, `PROMPT_VERSION`,
ruleset major) into `packages/orchestrator/profiles/` (default):

- Seat-days come only from real lockstep runs, `ended` or `stopped` at a day boundary
  (`--stop-after`), Level E ok; only complete game days count, each seat until its hand-off day. A
  wake keeps every attempt of its turn (rounds, retries, thought calls) with its prompt, output,
  cache-read and cache-write tokens; a line charged without usable tokens counts 0, with a warning.
- Fake runs never give seat-days. A `--fake` run of 7 days or more gives only the briefing growth:
  the mean round-0 briefing bytes per day (`--transcripts full`, the default), at 3 bytes per token
  (an assumption). A growth-only call with no profile yet of that ruleset major keeps nothing (pass
  the 7-day fake run together with the real runs).
- Profiles accumulate; a run calibrated again replaces its own seat-days; two files with the same
  key are refused; nothing measurable: exit 3 with each skip reason.

### 33.2 Prediction sources (lockstep plans only; a real-time plan keeps the scenario)

Seat-days are counted by distinct (run, game day) since the review: the seats of one match day share
its map, opponents and events, so three Haiku seats of a 1-day `claude-duo` calibration are one
independent seat-day (`independentSeatDays`), not three.

- **`measured-point`** (1–2 independent seat-days): central = `projectSpend` (+15%) of one seat's measured
  spend, re-priced at the plan's cards (per card group when several are valid in the window);
  low/high = central × the scenario's low/central and high/central ratios. No percentiles.
- **`calibrated`** (3 or more independent seat-days): a seeded bootstrap (2,000 replicates, seed 20261019). Per
  game day, a wake count from that day's seat-days, then whole wakes; a day not measured scales the
  count by `BOT_DAY_PROFILE` and grows each prompt by the measured briefing growth. Each day is
  priced at the dearer card of its planned wall window (15/7 wall hours per game day in lockstep,
  an assumption; since the review the window's end is stretched ×2, `WALL_SLACK`, so a slower run
  that slips past a price change stays inside its prediction). Output p10/p50/p90 (nearest rank).
  The plan warns when a seat is `calibrated` (its band missed real spend in the review's
  replication, §39).
- The match interval is the bootstrap of the sum only when every seat is calibrated; otherwise the
  sum of the seat bounds, labelled with the weakest seat source. The source appears per seat and
  for the match in `estimate.json`, in `arena.json` `budget.estimate.source` and in the printed
  table. `--profiles <dir>|off` on `run`, `estimate` and `series`; `off` keeps the scenario.
- Default seat caps are 2 × max(the scenario's high, a calibrated p90), at least $5 (the review:
  the p90 alone could hand a seat off for `cap`, against design §3.9); wake caps keep the
  scenario's central wake cost. `arena.json` `seats[].estimate` and the report's "estimate for
  N days" line stay scenario figures.

### 33.3 `arena series`

`bun run arena -- series --lineup <x> --out <dir> [--blocks N] [--seed S] [--fake] [run flags]`:
seeded random Latin squares rotate the lineup's LLM seat entries over its positions and an
orthogonal square rotates the profiles (Graeco-Latin for odd orders and 4, 8, 16: cyclic `(i + j,
2i + j)` or GF(2^m) `(i⊕j, 2·i⊕j)`, then random rows, columns and symbols; every other even order
(2 and 6, which have no orthogonal pair, and 10, 12, 14, … which do but are not built here) falls
back to an independent square with a warning and `orthogonal: false`). Game seed = series seed + block.
Every match is planned before anything is written (a refusal exits 3, nothing written; real matches
plan with `planLive`), then `series.json` (`perfidia-series/1`), `lineups/mNN.json` and one run
directory per match; matches run one at a time, the manifest rewritten after each, and the series
stops at the first non-zero exit or operator signal. It prints Σ predicted low/central/high and Σ
budgets, and warns when the series' Google high exceeds $250 (Gemini Tier 1). Each real match is
planned again on the live metadata at its start (`planLive`), so a price that rose since the
series was planned refuses that match (exit 3; tested since the review).

## 34. The integration

### 34.1 The cross-adapter conformance suite (`model/conformance.test.ts`)

One loopback stub per provider (`model/wire-stubs.test.ts`) decodes each request back to the seat's
conversation and encodes a provider-neutral reply (text, calls, reasoning, a natural or
`max_tokens` stop, a neutral usage) in the provider's wire format. One scripted turn goes through
each real adapter as the seat agent sends it: round 0 (briefing and header; two calls), round 1
(their results) cut at `max_tokens`, its retry at 65,536 (an `end_turn` call), then the
out-of-band thought call (the queued result and the ask; a text). Checked for all four:

- the same calls (names and arguments), text, reasoning text and stops on every attempt;
- per attempt, the same prompt total, cache reads and output (and reasoning where the provider
  splits it out; Anthropic reports none); Gemini's writes appear as plain input, the others' as
  `cacheWrite5m`; the sums over the turn: prompt 22,963, cache reads 16,646, output 35,556 tokens;
- every attempt priced at its provider's card; OpenRouter's served endpoint and reported cost;
- prefix stability: the tools and both stable blocks byte-identical in all four requests; each
  request's conversation extends the previous one item by item (the retry resends it unchanged);
- one request per attempt and nothing else; each key in its own header only, never in a URL;
- a stream cut after two events is charged, estimated, on all four: the prompt and the full output
  limit (Anthropic, OpenAI, Gemini), or the attempt-bound marker that the pricer refuses and the
  ledger charges at the attempt bound (OpenRouter in round 0, nothing measured yet).

### 34.2 The four-provider wire-stub match (`arena/wire-match.test.ts`)

`budget-mix` for 2 game days in lockstep, every LLM seat on its real adapter against its stub,
driven by the bot-backed brain (the seats' own bots), planned by `planLive` (OpenRouter's metadata
from its stub) and run by `runArena`; keys and base URLs come from the plan's environment only.
Checked: status `ended`, Level E, the gateway rebuild equal to the run's gateway state; every
`llm_call` line re-priced from its usage at its wall start equals its logged cost, each seat at its
own provider's card; OpenRouter lines with the pin, the fee and a reported cost; four preflight
lines; the budget block (total = Σ logged lines, under the $40 budget, no kill); `exit4` computed
with every part (`models` 4, `met` false: a stub run is never reconciled); no key in any run file
or in what the run printed, each key only in its own stub's header. A second run against fresh
stubs is identical apart from the wall fields (`wallStart`, `latencyMs`, `ttftMs`, `wallMs`, the
price instant `priceAt`, think times, the recommended speed, the wall window, the estimate's sha,
`summary.json`) and the order of lines between seats in `llm_calls.jsonl` and `replies.jsonl` (two
seats' attempts at one game time finish in the order the network answers; each seat's own sequence
is identical). Then the kill switch: a budget one cent above the plan's refusal threshold ($1.89)
and replies that spend 20,000 more output tokens: the kill fires (game time 600), all four LLM
seats are handed off `match_budget`, no attempt starts after the kill, spend $0.599 ≤ $1.89, the
match ends with the bots, Level E holds.

Measured (4-vCPU container): one 2-day run 2.4–3.2 s, 377 attempts (requests: Anthropic 95, OpenAI
107, Gemini 76, OpenRouter 103, preflight included), $0.281304 at the cards (the stub's usage is a
model, a token per 4 bytes; these dollars are illustrative); the kill run 1.3 s.

### 34.3 What the merge resolved

- **One factory mechanism.** OpenAI's agent put `create` on the registry; Gemini's agent an
  `ADAPTER_FACTORIES` map; OpenRouter's agent a dispatch in `run.ts`. The registry's `create` is
  kept for all three (`AdapterEnv.apiKey` widened to `string | null`); the OpenRouter pin
  (`openrouterPin`, `ENDPOINT_PROVIDERS`) moved to `arena/providers/compat.ts` so the registry
  imports no plan code (re-exported from `providers/openrouter.ts`).
- **`arena smoke --provider`** takes anthropic, openai, google (alias gemini) and openrouter, and
  `--endpoint` for openrouter only; the CLI usage says every provider runs for real.
- **Tests.** The Pass 1b "no adapter" refusals became "a real run of that provider needs its key",
  with loopback base URLs so a failing refusal never leaves the machine; the three live tests are
  kept side by side.

### 34.4 What the integration added or changed

- **`arena smoke --record`**, `model/http.ts` `recordingFetch` and `arena/record.ts` (§32); the
  design's §8.2 had them, no agent built them.
- **The bare Bearer key is refused in a URL** (`guardedFetch`): the URL check compared the whole
  header value (`Bearer <key>`), so a URL holding the bare key passed (the OpenAI agent's finding);
  tested raw and URL-encoded.
- **A cut OpenAI reply keeps its content** (`incomplete` with `max_output_tokens`): it was an empty
  reply, while the other three keep what they got; the conformance suite found the difference. The
  seat still never runs a cut reply's calls; its reasoning summaries now reach `replies.jsonl`.
- **`stop: "other"` is outside the breaker** (`seat/agent.ts`): design §3.5 says a malformed call
  or unknown finish closes the turn, non-systemic, for every provider (Gemini's
  `MALFORMED_FUNCTION_CALL`, unmapped OpenRouter and OpenAI reasons); it counted toward the breaker
  (the Gemini agent's finding). `pause` stays systemic. Anthropic's request bytes are unchanged.
- **`arena series` plans with `planLive`** (as `arena run`), so a real series with OpenRouter seats
  is checked against the live metadata; fake series keep the snapshot.

## 35. Commands (Pass 2)

| Command                                                                                                | What it does                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `bun run arena -- smoke --provider openai\|google\|openrouter [--model …] [--effort …] [--endpoint …]` | One live check per provider: preflight, a count, one streamed call ≤ 4,000 output tokens; the bound printed first |
| `bun run arena -- smoke … --record <dir>`                                                              | The same, every exchange written sanitised as `perfidia-recording/1` files                                        |
| `bun run arena -- calibrate <run-dir>... [--profiles <dir>]`                                           | Profiles from real lockstep runs (and briefing growth from 7-day fake runs)                                       |
| `bun run arena -- series --lineup <x> --out <dir> [--blocks N] [--seed S] [--fake] [run flags]`        | A rotated series of matches (Latin / Graeco-Latin squares), `series.json`                                         |
| `--profiles <dir>\|off` on `run`, `estimate`, `series`                                                 | The profiles the prediction draws on (default `packages/orchestrator/profiles/`)                                  |

Smoke bounds printed before anything is sent (2026-10-20 cards; each is the most the smoke can
cost, the expected cost is a fraction): Claude Haiku 5.5 $0.010969, GPT-6 Luna low $0.017938
(the 12-hour write price counts since the review), Gemini 3.8 Flash low $0.189510 (every price kind
of every card valid from now, the January card included, and the count charged as input), GLM-5.3
Flash on `z-ai/fp8` $0.012305 (fee and completion slack included); for M3: Claude Sonnet 5.5
medium $0.219392, GPT-6.1 Sol medium $0.358765, Gemini 4 Argon medium $0.505396, GLM-5.3 low
$0.113699. Without the key each exits 3 with its bound and "Nothing was sent."

Environment (read in `src/arena/` only): `PERFIDIA_ANTHROPIC_API_KEY`, `PERFIDIA_OPENAI_API_KEY`,
`PERFIDIA_GOOGLE_API_KEY`, `PERFIDIA_OPENROUTER_API_KEY`, `PERFIDIA_COMPAT_API_KEY` (optional on
loopback), each with its `_BASE_URL`, and `PERFIDIA_LIVE`.

## 36. Owner steps: M2 and M3

Defaults (the owner said "go" with every default of the design's decisions): OpenRouter pinned to
`z-ai/fp8` with `data_collection: "deny"` and `zdr: true`; medium effort; Anthropic fallbacks off;
`last-round` reminders; 32,768 output tokens; a 15-minute timeout; the native operator channel;
Flex off. Every step below is bounded by the printed bound or the run's budget; M2 spends at most
$0.23 (the four smokes' bounds) + $0.35 (step 2's live tests: three under $0.05 each, the Claude
test under $0.20) + $8 + $40 = $48.58.

**A decision the review adds** (§30.4): in the comparison presets the GLM seat now says `low`, the
level its requests already carried (GLM-5.3 lists max, high and low; no `medium`). The alternative
is `high` for that seat: set `"effort": "high"` on p4 in `lineups/budget-mix.json` and
`lineups/mid-tier.json` (its output factor is 1.5 against low's 0.6, so the prediction and budget
rise). The figures below are for `low`.

**M2, the cross-provider exit with `budget-mix`** (Claude Haiku 5.5, GPT-6 Luna, Gemini 3.8 Flash,
GLM-5.3 Flash on Z.AI):

1. **Accounts, keys and spend limits** (one dedicated account per provider, used for nothing else):
   - Anthropic: the M1 workspace (Console spend limit, global inference geo).
   - OpenAI: a dedicated project with a **hard** spend limit (e.g. $50; enforcement is not
     instantaneous, a 429 `project_spend_limit_exceeded` pauses the run), and organisation
     verification for reasoning summaries (else the preflight fails `auth`).
   - Google AI Studio: a project on a **paid** tier (Prepay with a small balance, e.g. $50; Tier 1
     caps at $250 a month; the free tier trains on 3.8 Flash data).
   - OpenRouter: a key with a key limit (e.g. $20; credits carry the 5.5% fee).
   ```
   export PERFIDIA_ANTHROPIC_API_KEY=…  PERFIDIA_OPENAI_API_KEY=…
   export PERFIDIA_GOOGLE_API_KEY=…     PERFIDIA_OPENROUTER_API_KEY=…
   ```
2. **Smokes with recordings** (≤ $0.011, $0.018, $0.19, $0.013; each prints its bound first):
   ```
   bun run arena -- smoke --record recordings/anthropic-haiku
   bun run arena -- smoke --provider openai --record recordings/openai-luna
   bun run arena -- smoke --provider google --record recordings/gemini-3.8-flash
   bun run arena -- smoke --provider openrouter --record recordings/openrouter-glm-5.3-flash
   ```
   Read each output: the stop, the served model (a dated id would have no card), usage and cost,
   the cache read after the preflight, OpenRouter's served endpoint, reported cost and reasoning
   tokens (C9: what `low` does). Send the four `recordings/` directories back (§32). Then
   `PERFIDIA_LIVE=1 bun run test:live` runs one live test per provider whose key is set (each under
   $0.05; the Claude test of phase 2 too, under $0.20).
3. **Rehearse for free**, then **the 1-day calibration** (central $0.97, high $4.40, budget $8, K
   $6.57):
   ```
   bun run arena -- run --fake --lineup budget-mix --stop-after 1 --budget-usd 8 --out runs/budget-mix-rehearsal
   bun run arena -- estimate --lineup budget-mix --stop-after 1 --budget-usd 8
   bun run arena -- run --lineup budget-mix --stop-after 1 --budget-usd 8 --out runs/budget-mix-cal --watch
   ```
   Read `arena.json`: per-seat cost and cache reads, `promptCaps`, refusals, errors by kind, no
   hand-off; p4's label and `seats.json` effort say `low` (no `effortSent`: the level sent is the
   seat's).
4. **Calibrate** (one seat-day per model: `measured-point` profiles, a wide interval):
   ```
   bun run arena -- calibrate runs/budget-mix-cal
   bun run arena -- estimate --lineup budget-mix --budget-usd 40
   ```
5. **The 7-day match** (scenario before calibration: central $6.79, high $30.80, budget $40, K
   $38.57; the estimate after step 4 is what `estimate.json` stores; one seat-day per model stays
   `measured-point`):
   ```
   bun run arena -- run --lineup budget-mix --budget-usd 40 --out runs/budget-mix-1 --watch
   ```
   About 10–15 wall hours in lockstep. After a crash: `--budget-carry runs/budget-mix-1` into a new
   directory.
6. **After 48 hours, reconcile** with each provider's usage page for the run's wall window
   (`arena.json` `budget.wall`), pre-tax, OpenRouter without its fee:
   ```
   bun run arena -- reconcile runs/budget-mix-1 --usd anthropic=<usd> --usd openai=<usd> --usd google=<usd> --usd openrouter=<usd>
   ```
   Exit 0 and `exit4.met: true` in `arena.json` is the cross-provider form of the exit.

**M3, the first comparison with `mid-tier`** (Claude Sonnet 5.5, GPT-6.1 Sol, Gemini 4 Argon,
GLM-5.3 on Z.AI), **starting at least two days before 2026-11-30** (Argon's card doubles at the
change; the plan bounds every card valid from the start, and a run slower than its planned 15 wall
hours can slip past the change: the prediction stretches each day's window ×2, so start the 7-day
match no later than 2026-11-28):

1. Smokes with recordings (≤ $0.22, $0.36, $0.51, $0.12):
   ```
   bun run arena -- smoke --model sonnet-5-5 --effort medium --record recordings/anthropic-sonnet
   bun run arena -- smoke --provider openai --model gpt-6.1-sol --effort medium --record recordings/openai-sol
   bun run arena -- smoke --provider google --model gemini-4-argon --effort medium --record recordings/gemini-argon
   bun run arena -- smoke --provider openrouter --model z-ai/glm-5.3 --effort low --record recordings/openrouter-glm-5.3
   ```
2. The 1-day calibration (central $5.78, high $24.30, budget $40, K $33.36), then calibrate:
   ```
   bun run arena -- run --lineup mid-tier --stop-after 1 --budget-usd 40 --out runs/mid-tier-cal --watch
   bun run arena -- calibrate runs/mid-tier-cal
   ```
3. The first comparison match (scenario: central $40.44, high $170.13, budget $200, K $193.36), and
   its reconciliation 48 hours later:
   ```
   bun run arena -- estimate --lineup mid-tier --budget-usd 200
   bun run arena -- run --lineup mid-tier --budget-usd 200 --out runs/mid-tier-1 --watch
   bun run arena -- reconcile runs/mid-tier-1 --usd anthropic=<usd> --usd openai=<usd> --usd google=<usd> --usd openrouter=<usd>
   ```

## 37. Tests and measurements (Pass 2)

No test touches the network: stub fetches and `Bun.serve` stubs on 127.0.0.1 only; the live tests
are skipped with a printed reason unless `PERFIDIA_LIVE=1` and that provider's key are set.

| File                                                                                                    | Tests | What                                                                                               |
| ------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `model/openai.test.ts`                                                                                  | 47    | The OpenAI contract suite (request bytes, stops, errors by code, usage, broken streams, preflight) |
| `arena/providers/openai.test.ts`                                                                        | 8     | A 1-day wire-stub match through `arena run`, the smoke, the plan's base-URL refusals               |
| `model/gemini.test.ts`, `gemini-tools.test.ts`, `gemini-stub.test.ts`, `arena/providers/gemini.test.ts` | 40    | The Gemini contract suite, the transform hash, the wire stub, a 1-day match, the smoke             |
| `model/compat.test.ts`                                                                                  | 61    | The OpenRouter and compat contract suite                                                           |
| `arena/providers/openrouter.test.ts`                                                                    | 20    | `planLive` refusals, a 1-day match on the stub, the smoke                                          |
| `arena/calibrate.test.ts`, `arena/series.test.ts`                                                       | 14    | Profiles, sources, bootstrap determinism, squares (fast-check, 300 runs), a 4-match fake series    |
| `model/conformance.test.ts`                                                                             | 8     | §34.1 (plus the stub's own test)                                                                   |
| `arena/wire-match.test.ts`                                                                              | 2     | §34.2                                                                                              |
| `arena/record.test.ts`                                                                                  | 6     | The sanitiser; `--record` against each provider's stub, replayed through the adapter               |

Mutation checks by the agents: OpenAI 7 of 7 money mutants killed, Gemini 10 of 10, calibration 15
of 15.

Measured on the shared 4-vCPU container after the integration: `bun run check` green (typecheck,
lint, format, then 3,695 tests pass, 34 skipped, 0 fail, in 295 files: 495 s of tests, 8 min 29 s
in all); the orchestrator suite alone 482 pass, 9 skipped, 0 fail in 51 files,
60 s (the skips: 5 opt-in live tests and 4 exit tests that run under `test:exit`); `bun run test:exit` green (14 tests, 267 s); the four-provider 2-day match 2.4–2.6 s per run.

After the Pass 2 review's fixes (§40): `bun run check` green (typecheck, lint, format, then 3,715
tests pass, 34 skipped, 0 fail, in 295 files: 526 s of tests, 8 min 58 s in all); `bun run
test:exit` green (14 tests, 276 s, 4 min 36 s); 26 mutants of the fixes, 26 killed by the new
tests.

## 38. Deviations (Pass 2)

The code wins where the design and the code disagree:

- **OpenAI caching** is implicit mode plus one explicit breakpoint after the seat block, not
  explicit-only with a tail breakpoint (design §2.3): in explicit-only mode the lookup boundaries
  are only the explicit breakpoints present in the request, so a tail marker moved to the new tail
  would never be read on the next round. Implicit mode writes at the latest eligible message and
  looks up to 20 earlier message endings; each request of a turn extends the previous one.
- **OpenAI broken streams** are charged the seat's prompt estimate at the write price plus the full
  limit (Anthropic charges nothing before `message_start`): OpenAI reports no usage until the end.
- **Gemini error additions** live in `model/gemini.ts` `classifyGeminiError`, not in `http.ts`
  (design §2.2 placed the classification there).
- **Gemini `anyOf`/`oneOf`** pass through `gemini@1`: they are in the documented subset.
- **Gemini served-model or tier mismatches** are priced at the dearest card under an unpriced id
  (and refused at preflight) rather than refused at run time.
- **OpenRouter efforts**: outside a comparison lineup, `medium` is sent as `low` on GLM-5.3 (the
  nearest listed level; a tie goes down), recorded as `effortSent`, the prediction keeping medium's
  factor; a comparison lineup refuses an unlisted effort and the presets name `low` (§30.4, §40).
- **OpenRouter plan time** refuses a run when the live metadata cannot be fetched (no fallback to
  the snapshot), and replies without routing metadata are refused (strict pin).
- **Calibration**: profile rounds gained an optional `cacheWriteTokens`; calibration reads lockstep
  runs only and profiles apply to lockstep plans only; `measured-point` re-prices per planned
  card group; briefing growth assumes 3 bytes per token; seat-days count by (run, day); default
  seat caps are 2 × max(scenario high, calibrated p90).

## 39. Open items (Pass 2)

- **The calibrated prediction is biased low and narrow** (agent E's finding, measured on bot-shaped
  fake data only): from 3 seat-days of day 1, a 7-day fake `budget-mix` was predicted $1.51 / $1.56
  / $1.61 (p10/p50/p90) and spent $1.81–$1.96 (16–26% over central, above p90): prompts per attempt
  grow 10.3K → 13.8K tokens and attempts per wake 3.45 → 3.95 over a week, which briefing growth
  alone does not explain, and the bootstrap has no between-seat or between-match correlation (±3%).
  `exit4.withinPrediction` needs the total inside [low, high], so an exit match predicted
  `calibrated` from a 1-day calibration could fail it. M2 is safe as planned (each of its four
  models has one seat-day after the 1-day calibration: `measured-point`, a wide interval); a lineup
  with 3 seats of one model (`claude-duo`'s Haiku) would turn `calibrated`. Options for the owner,
  each a departure from the reviewed design: calibrate from multi-day runs, grow whole prompts per
  attempt, keep the +15% margin in calibrated mode, or widen the band (block bootstrap by seat-day,
  p5/p95). Until one is chosen, run exit matches with `--profiles off` when the estimate says
  `calibrated` (the plan now warns). The Pass 2 review replicated it on the real adapters (wire
  stubs, bot brains): a `claude-duo` day-1 calibration (3 Haiku seat-days of one match day, then
  `calibrated`) predicted each Haiku seat at $0.11 / $0.12 / $0.12 and two full 7-day runs spent
  $0.2129, $0.1149, $0.1524, $0.1880, $0.1011 and $0.1858 per Haiku seat: five of six above p90
  (up to 1.77×), one below p10, none inside; Sonnet's `measured-point` central $2.54 against $3.52
  and $3.85. The bootstrap resamples single wakes pooled across seats of one match, so averaging
  leaves a ±4% band while seats differ by −16% to +77%. What the review changed until the owner
  chooses a method: seat-days count once per (run, game day), so one match day can no longer make
  a profile `calibrated` (that `claude-duo` calibration is now `measured-point`); the default seat
  cap is 2 × max(scenario high, calibrated p90), so a calibrated p90 cannot lower a cap below the
  scenario's (with actual spend up to 1.77× p90, a cap from p90 alone could hand a mid-tier seat
  off for `cap`, against design §3.9 and the exit's no-hand-off rule); the plan warns on every
  calibrated seat. The band itself is unchanged.
- **Everything of §32's "unverified" list**, settled by the recorded smokes; a dated served model id
  (OpenAI or Gemini) would be refused at preflight until a card or an alias rule is added with
  evidence.
- **Contract tests on recorded fixtures**: the recordings exist only after the owner's smokes; the
  switch of each contract test from its synthetic fixture to the recorded exchange is the next step.
- **The cadence A/B** of design §3.2 (both reminder cadences on the cheap models) is not automated:
  a 1-day `--fake` rehearsal costs nothing, a real one about the calibration day's cost.
- **`compat` seats** stay refused at plan time until the owner adds a card to
  `model/prices/compat.ts`; compat mode is exercised by its contract suite only.
- **Raw chain-of-thought is shown unlabelled**: `llm_calls.jsonl` and the server's annotations carry
  `reasoningKind` (summary for Anthropic, OpenAI and Gemini; raw for GLM; none without reasoning
  text), but the web app does not label it yet (Pass 3 agent G), so GLM's raw reasoning reaches the
  Thoughts column looking like the others' summaries. Until then, do not publish a match with an
  OpenRouter seat, or accept that difference.
- **The parallel-call share per seat** (the plan's warning for endpoints without
  `parallel_tool_calls`) is Pass 3's statistics; nothing reports it yet.
- **The `[harness]` turn header on OpenRouter** says "The text part above is your briefing" while
  the briefing is a separate user message there: wording only, kept (a prompt-text change moves the
  envelope variants' hashes and profile keys; the next prompt version can fix it).
- **`arena.json` `seats[].estimate`** and the report's "estimate for N days" stay scenario figures;
  `report.ts` and the server do not read `series.json` yet (Pass 3's stats).
- Pass 3: per-model stats (`@perfidia/spectator/stats`), ratings and the spectator's model pages.

## 40. The Pass 2 review's fixes

Sixteen findings (two lenses: wire and money, fairness and calibration), each verified against the
code and, for provider facts, against the provider's documentation (WebFetch, 2026-10-20: OpenAI's
`docs/guides/prompt-caching.md` and `docs/pricing.md`; OpenRouter's
`docs/api/api-reference/endpoints/list-all-endpoints-for-a-model.md` and
`docs/guides/best-practices/reasoning-tokens.md`). Every money fix has a regression test that fails
on the code before it (26 mutants of the fixes, 26 killed).

| Finding                                                                                           | Verdict                 | What changed                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1: an absurd OpenRouter usage with `cost` charged $0 (major)                                     | fixed                   | `compat.ts`: a usage the cards cannot price exactly (`costOf` throws) is the attempt-bound marker; the reply fails `unknown` with it. `LlmSeatAgent`: an adapter rejection that is not a `ModelError` is charged one unpriceable entry, the seat's attempt bound (when the ledger has one; a thought call only for the adapter's own rejection). C1 itself: $0.540538 charged, `invalidUsage`.          |
| C4: Gemini stopped at the first final usage (major)                                               | fixed                   | `gemini.ts` reads to the end of the body (`readSse` `endOk`; a body that ends inside an event is still a break) and keeps the last cumulative `usageMetadata`; finished then broken: the larger of that usage and the estimate. C4: 70,020,000 nUSD charged, what the last usage bills.                                                                                                                 |
| C2: OpenAI 12-hour writes priced as 30-minute ones                                                | fixed                   | `cache_write_tokens_details` parsed (`ttl_12h_tokens` → `cacheWrite1h`; a split that does not sum is invalid); the OpenAI cards' long write is the 12-hour price ($5 / $5 / $0.25 / $25, long context ×2), so attempt bounds and OpenAI smoke bounds cover it (Luna's smoke $0.009973 → $0.017938, Sol's $0.199462 → $0.358765; reserves up by the OpenAI seats' bounds). C2: 550,000,000 nUSD charged. |
| C6: a Gemini final usage without its output counts charged 0                                      | fixed                   | `geminiUsage` requires `totalTokenCount`, and a reply with text or a call needs some output; otherwise the estimate.                                                                                                                                                                                                                                                                                    |
| C3: Gemini's estimate from request bytes could pass the attempt bound                             | fixed                   | The estimate's prompt is the usage's count, else `promptTokensUpper` capped by the bytes (as OpenAI). C3: input 100,000 instead of 400,515.                                                                                                                                                                                                                                                             |
| C5: an error event before output was free in compat mode, and for length errors                   | fixed                   | Zero-completion insurance applies on OpenRouter only and not to `max_tokens_exceeded` (a billed generation): those are charged the estimate (the bound in round 0), stream or 200 JSON.                                                                                                                                                                                                                 |
| C7: `--record` kept account ids in free text                                                      | fixed                   | `ID_PATTERNS` (`org-…`, `proj_…`, `req_…`, `gen-…`, `projects/<n>`, `project <n>`, `project=<n>`) and the `consumer` field are renumbered; the record directory is created with the first exchange.                                                                                                                                                                                                     |
| OpenRouter's `internal_reasoning` price ignored at plan time                                      | fixed                   | Refused (exit 3) above the card's output price; any priced key the plan does not know refuses too; documented image, audio and web-search prices are ignored (never sent).                                                                                                                                                                                                                              |
| OpenRouter's `max_tokens` is not a hard bound                                                     | fixed (and unverified)  | `completionUpper`: 1% + 16 tokens of slack on OpenRouter's broken-stream output and in its attempt and check bounds (GLM-5.3 Flash smoke $0.012266 → $0.012305). Whether `z-ai/fp8` stays within `max_tokens` is listed for the recorded smoke (§32).                                                                                                                                                   |
| GLM seats sent `low` under a `medium` label (major)                                               | fixed                   | A comparison lineup refuses an effort the model does not list (exit 3, naming the levels); the four comparison presets set their OpenRouter seat to `low` (unchanged on the wire), so label, `SeatModel`, profile key and prediction say `low`; `effortSent` is recorded on fake runs too. `low` or `high` for GLM is now an explicit owner decision (§36).                                             |
| Calibrated p10–p90 missed every seat; default caps followed p90 (major)                           | fixed (method deferred) | Seat-days count once per (run, game day); default seat caps are 2 × max(scenario high, calibrated p90); the plan warns on every calibrated seat; the replication numbers are in §39. The bootstrap method itself (block bootstrap, wider band) stays an owner choice (§39).                                                                                                                             |
| The CLI's default profiles dir broke four tests once claude-duo profiles exist                    | fixed                   | `MainOptions.profilesDir` (default `packages/orchestrator/profiles/`); every test that calls the CLI runs with `off` unless it passes `--profiles`, so an owner's calibration can no longer turn `bun run check` red.                                                                                                                                                                                   |
| Test gaps: bootstrap percentiles, the measured-point margin, series `planLive`, fake `effortSent` | fixed                   | Pinned on a profile with a known spread (n uniform on 1..20 wakes: p10 / p50 / p90 = 3 / 10 / 18 wakes, match 10 / 21 / 32); a two-card-group measured-point pins the +15% per group; a series whose live price rises after it was planned is refused at its match's start (exit 3); a fake run records `effortSent`. Mutants M4, M5, S2, M9, S1, M17 now killed.                                       |
| Per-day card choice assumed 15 wall hours a week                                                  | fixed                   | Each planned day is priced at the dearer card of its window with its end stretched ×2 (`WALL_SLACK`); §36 says to start M3 no later than 2026-11-28.                                                                                                                                                                                                                                                    |
| `reasoningKind` "summary" without reasoning; raw CoT unlabelled                                   | fixed / deferred        | `none` when a reply has no reasoning text, in OpenAI, Gemini and the agent's line (Anthropic and fake included). Labelling raw chain-of-thought in the web app is Pass 3 agent G's: listed in §39.                                                                                                                                                                                                      |
| Docs inaccuracies (M2 total, §33.3 orders, `--record` dir, OpenRouter header)                     | fixed / deferred        | M2's total includes the live tests ($48.58); §33.3 names every even order that falls back; the record dir is lazy. The OpenRouter header wording is deferred (a prompt-text change moves the envelope hashes and profile keys; next prompt version), §39.                                                                                                                                               |
| Only Anthropic seats get an `is_error` flag                                                       | documented              | A known interface difference (§31), phase 2's and pinned; the parallel-call warning now says the share is Pass 3's, not reported yet.                                                                                                                                                                                                                                                                   |

New estimates after the fixes (2026-10-20 cards, 7-day lockstep, fees included; `arena estimate
--lineup <preset> --price-date 2026-10-20`), replacing §21's: `budget-mix` $1.63 / $6.79 / $30.80,
reserve $1.43, K $38.57; `mid-tier` $10.41 / $40.44 / $170.13, reserve $6.64, K $193.36;
`mid-tier-flash` $8.76 / $32.57 / $131.02, reserve $5.25, K $144.75; `frontier` $36.78 / $134.16 /
$524.44, reserve $22.90, K $547.10. The GLM and Kimi seats now predict at `low`; the reserves grew
with the OpenAI 12-hour write price and OpenRouter's completion slack.

# Part IV: Pass 3, statistics (agent F)

## 41. What Pass 3's statistics deliver

Design §6 asks for per-model statistics: what each seat did, cost and went through in a match,
and, across matches, how the models compare, with intervals and an honest "too few matches" state.
Pass 3 agent F built the numbers and their routes; agent G builds the web pages on them (§45 is
their contract).

- **Per seat per match** (`perfidia-stats/1`, §42): a pure fold in `@perfidia/spectator/stats`
  (`matchStats`, `statsOfLog`) over `match.jsonl` (through the spectator fold, so ruleset names stay
  in `fold/rulesets.ts`), `llm_calls.jsonl`, `seats.json` and `arena.json`'s cost by kind. No I/O, no
  `Math.random`, integers for money.
- **Across matches** (`perfidia-model-stats/1`, §43): `packages/server/src/stats/` aggregates run
  directories per model (or profile, prompt variant, model × profile), groups a rotation series'
  matches into blocks from the root's `series.json`, fits MAP Plackett–Luce ratings with seeded
  block-bootstrap (or Laplace) intervals, and reports the claim state of design §6.4. Below the
  threshold no outcome, rank or rating is shown: the file says how many more matches a claim needs.
- **The power simulation** (§44): `bun run stats -- power` reproduces the design's exact table and
  measures the pipeline's own power on synthetic series of known strengths; a 48-seed bot batch ran
  through the same pipeline.
- **Routes** (§45): `GET /api/matches/:id/stats`, `GET /api/models`, `GET /api/models/:id` on both
  HTTP adapters, Zod-validated, in the OpenAPI document, under `publish.json` visibility and
  `--no-costs`.
- **CLI** (§46): `bun run stats -- match|aggregate|power`, a table or `--json`.
- **Protocol** (`packages/protocol/src/stats.ts`): every schema above, exported from the root barrel
  and from `@perfidia/protocol/spectator` (the web's import). Additive: no existing format changed.
- Engine, gateway, bots, sim, the orchestrator and every golden are untouched; no dependency was
  added.

## 42. Per seat per match: `perfidia-stats/1`

`MatchStatsSchema`: `{format, match, ruleset, status, verified, rated, clock, lastT, endedAt,
result, fake, lineup, series, published, seats[], collusion, cost}`.

- **`rated`** = the log verifies (level E) and has an end line, and the status is `ended` or
  `degraded`. Only rated matches enter ratings, outcomes and the claim count.
- **`series`** = `{lineup, block, index}` from the runs root's `series.json` (`perfidia-series/1`):
  the series' base lineup, the block (from 0) and the match's index (from 1). The series seed is
  never copied (each block's game seed derives from it; seeds are never served).
- **`published.costs`**: false under `--no-costs`; then `cost` of the match and of every seat, and
  `operations.latencyMs` / `ttftMs`, are null.

Each seat (`SeatStatsSchema`):

| Block        | Fields and definitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| who          | `kind` as it started (`llm`, or `bot`; a handed-off seat stays `llm`: intention to treat), `label`, `key` (`provider/model[@endpoint]/effort`, or the bot label `bot:conqueror@3`), `id` (the key as a URL-safe model id: `anthropic.claude-haiku-5-5.medium`, `openrouter.z-ai-glm-5-3.z-ai-fp8.low`, `bot.conqueror.3`; two keys that slug alike get `-2`, `-3` in the aggregate), `name` (profile first name, `Conqueror (bot)`), `model` `{provider, model, endpoint, effort, intended, quantization, effortSent}`, `profile`, `promptVariant`, `reminders`, `toolsHash`, `fake` (a bot behind the LLM pipe: provider `fake`, never a model's play)                                                                                                                   |
| `outcome`    | the end line's `result.standings` (the ruleset's standings at the last line of a match that did not end): `rank` (1-based, no shared ranks), `score`, `cities`, `alive`, `eliminatedAt`, `winner` (among the end line's winners)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `play`       | `turns` (every turn the seat ended, equal to the dossier's `counts.turns`), `wakes` (turns ended while an LLM controlled it), `rounds`, `calls`, `accepted`, `rejections` by code, `thoughts` (wakes with a public thought), `endings` by kind                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `diplomacy`  | `messagesSent`, `messagesReceived` (to the seat or to everyone, from another seat), `publicSent`, `proposalsSent/Received`, `accepted`, `refused`, `alliancesFounded/Joined/Left`, `pactsSigned`; **`pactsKept`** = pacts that expired or were active at the end with no betrayal by the seat of that partner meanwhile; **`pactsBroken`** = `betrayal {by: seat, relation: "pact"}`; `pactEnds` = early ends by `pact_ended.cause` as is; `betrayalsCommitted` / `Suffered` from `betrayal {by, against}`; `sameModel` / `crossModel` `{messages, pacts, alliances}` with LLM seats that started on the same model / another one (design §3.8; null for a bot); `selfIdentification` = sent messages naming a model, a vendor or "language model" (counted, never shown) |
| `military`   | `battlesAttacked`, `battlesDefended`, `battlesWon`, `citiesConquered`, `citiesLost`, `citiesFounded`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `incidents`  | `handoff {t, reason, label}` (reason from `seats.json`, null when absent), `wakeCaps`, `promptCaps`, `fallbackPermille` (attempts a fallback served), `errorWakes`, `refusals` by category, **`parallelPermille`** = round attempts that called ≥ 2 tools ÷ round attempts that called ≥ 1, ‰ (null without one)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `operations` | null for a bot or without `llm_calls.jsonl`: `attempts`, `thoughtCalls`, `stops`, `errors` by kind, `toolErrors {malformed (stop "other"), invalidArgs (gateway INVALID_ARGS)}`, `fallbacks`, `toolRounds`, `parallelRounds`, `textChars`, `reasoningChars`, `reasoningKinds`, `latencyMs` / `ttftMs` `{n, p50, p95}` (nearest rank; null under `--no-costs`)                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cost`       | null for a bot, without `llm_calls.jsonl` and under `--no-costs`: `nanoUsd` (every attempt and thought call, fees included), `perWakeNanoUsd` (floor), `preflightNanoUsd` (the start preflight and probes split equally among seats of the same provider, model and endpoint; the remainder to the first), `feesNanoUsd`, `reportedNanoUsd` (OpenRouter, when every line has one), `estimatedNanoUsd`, `byKind` (from `arena.json`), `tokens {input, cacheWrite5m, cacheWrite1h, cacheRead, output, reasoning}`, `cacheReadPermille` = cacheRead ÷ (input + writes + cacheRead), `priceCards`, `capNanoUsd`                                                                                                                                                               |

`collusion` sums the same-model and cross-model pairs (`samePairs`, `crossPairs`, `same`, `cross`);
`cost` of the match is `{nanoUsd (attempts, preflight, probes), preflightNanoUsd, probeNanoUsd,
budgetNanoUsd}`. Derived ratios the design lists (cost per turn, dollars per wake, output characters
per wake, calls per round, rounds per wake, thought coverage) are quotients of these fields; the web
computes them.

Old run directories fold without error: a bots-only run (the war golden) has `operations` and
`cost` null on every seat; a `perfidia-arena/1` run has no prompt variant, no price card and no
preflight (`reminders`, `toolsHash` null, `priceCards` empty, `preflightNanoUsd` 0).

## 43. Across matches: `perfidia-model-stats/1`

`bun run stats -- aggregate --runs <dir>` discovers run directories as the server does, keeps the
public ones with `--publish <file>` (an `after_end` match only once it has ended), folds each
(`statsOfRunDir`; a directory that cannot be folded is left out with a warning), and aggregates
(`aggregate.ts`):

- **Items.** By `--group model` (default: `provider/model[@endpoint]/effort`; bots by label), or
  `profile`, `variant`, `model-profile`. Sorted by id, never by outcome.
- **Per item** (`ModelAggregateSchema`): `matches`, `seats`, `rated`, `handoffs` by reason, sums of
  `play`, `diplomacy`, `military` and `incidents`, the item's `parallelPermille`, `operations`
  (`latencyMs` = the seats' p50 and p95 averaged, weighted by their attempts), `cost` (`nanoUsd`,
  `perMatchNanoUsd`, `perWakeNanoUsd`, `cacheReadPermille`, `tokens`, **`byLineup`**: mean cost per
  match in each lineup with a block-bootstrap interval from 5 blocks, since social and urgent
  wakes depend on the opponents), and `outcome` (`rated`, `meanRank`, `ranks[]` = seats per final
  rank, `wins`, `dominationWins`, `citiesMean`) — **null until the claim threshold is met**.
- **Blocks.** A series match's block is `series:<lineup>#<block>` (four matches of a rotation
  square); any other match is its own block (`match:<id>`). `blocks` counts the rated ones.
- **Ratings: MAP Plackett–Luce** (`pl.ts`). Each item i has a log-strength θᵢ; a match's full
  ranking r (best first, every seat an entry, two seats of one model are two entries of one item)
  has probability Πₖ exp(θ_{rₖ}) / Σ_{j≥k} exp(θ_{rⱼ}). The prior is N(0, 1.5²) on every θᵢ, which
  keeps the fit finite on a weakly connected comparison graph (a bot always last). The
  log-posterior is strictly concave: Newton's method from θ = 0 (Cholesky solve, step halving,
  step below 1e-10 or 100 iterations) gives the mode deterministically; its Laplace covariance is
  the inverse negative Hessian. Strengths are centred on the LLM items' mean (sum to zero over
  LLM items; over all items in a bots-only root) and also shown on an Elo-like scale, 1500 + 400 ·
  θ / ln 10. Under Plackett–Luce, P(i ahead of j) = exp(θᵢ) / (exp(θᵢ) + exp(θⱼ)).
- **Intervals** (`rate.ts`). From 5 blocks: a block bootstrap (blocks drawn with replacement,
  `--replicates` refits from the mode, default 1000; percentile intervals, linear between order
  statistics, 95%) for strengths, Elo, mean rank, every LLM pair's difference and the cost per
  lineup. Below 5 blocks: Laplace intervals for strengths and differences (mean rank has none).
  `bootstrapSeed` (default 20261019, `--seed`) feeds the engine's `streamRng` with the streams
  `headline`, `clean` and `cost:<id>:<lineup>`: the same seed gives byte-identical output.
- **Headline and sensitivity.** `headline` ranks every seat as it started (intention to treat,
  handed-off seats included); `clean` leaves handed-off seats out of each ranking.
- **Pairs.** For each pair of LLM items: matches they met in, `aAhead` (a's best seat ahead of b's
  best seat), the strength difference a − b and its interval.
- **The claim state** (`ClaimsSchema`, `power.ts`): `pairs` = LLM item pairs that met in a rated
  match, `matches` = rated matches of the pair that met least, `alpha` = 0.05 / pairs (Bonferroni),
  `needed` = the smallest n at which the exact two-sided binomial test of p = 0.5 at `alpha` has
  80% power against a 70/30 head-to-head, `more` = needed − matches, `power` = the test's achieved
  power at `matches`, and `table` the same at 80/20, 70/30 and 60/40. `state`: `ok` when matches ≥
  needed; `too_few_matches` otherwise; `no_comparison` when no two LLM items met. A root of bots
  only compares its bots (the power check). Below `ok`, `outcome`, `ratings` and the seats' `rank`
  are null; `--exploratory` fills them for the operator (`exploratory: true`), and the server never
  serves such a file.
- **Seats** (`ModelSeatRowSchema`): `{id, match, seat, rated, lineup, profile, promptVariant,
  handedOff, wakes, costNanoUsd, rank}` per seat, for `/api/models/:id`.
- **Series** (`series[]`): `{lineup, fake, order, blocks, orthogonal, planned, found}` per manifest
  (planned matches against those found and aggregated).

Thresholds in one place: prior σ 1.5; bootstrap from 5 blocks; 95% intervals; 1000 replicates;
claim gap 70/30 at 80% power, α 0.05 Bonferroni over the compared pairs (one pair 49 matches; six
pairs, four models, 74; ten pairs 80).

## 44. How many matches before a claim: the power simulation

**Exact table** (`power.ts`, pinned by `power.test.ts`; design §6.4 reproduced): one pair 20 / 49 /
199 and six pairs 32 / 74 / 303 matches for 80/20, 70/30, 60/40; the draft's power 0.38 at 10, 0.42
at 20, 0.46 at 90. The exact test's power is a sawtooth in n (70/30, one pair: 0.810 at 49 but
below 0.80 at 50–53), so the achieved power is reported as it is.

**Pipeline simulation** (`simulate.ts`, method): six items with one seat each, as in a comparison
lineup (four LLM models A–D, two bots); θ_A = δ/2, θ_B = −δ/2, the rest 0, δ = ln(0.7 / 0.3), so A
finishes ahead of B with probability 0.7. For each series length, 400 series are drawn from
Plackett–Luce (the engine's seeded PRNG), grouped in blocks of 4 matches, and rated by the same code
as real matches (`rateMatches`); power is the share of series where the claim is made: the exact
binomial test on A's head-to-head record rejects (α 0.05 one pair, 0.05/6 six pairs), or A − B's
interval excludes 0 (Laplace at 95% or 1 − 0.05/6; block bootstrap at 95% with 200 replicates).

`bun run stats -- power --matches 12,20,32,49,52,74,76,100 --reps 400 --replicates 200` (3 min 16 s
on the 4-vCPU box):

| matches | exact, 1 pair | binomial sim, 1 | Laplace, 1 | bootstrap, 1 | exact, 6 pairs | binomial sim, 6 | Laplace, 6 |
| ------: | ------------: | --------------: | ---------: | -----------: | -------------: | --------------: | ---------: |
|      12 |         0.253 |           0.248 |      0.418 |        0.418 |          0.085 |           0.070 |      0.180 |
|      20 |         0.416 |           0.398 |      0.580 |        0.695 |          0.107 |           0.083 |      0.295 |
|      32 |         0.495 |           0.493 |      0.815 |        0.868 |          0.344 |           0.343 |      0.563 |
|      49 |         0.810 |           0.798 |      0.913 |        0.925 |          0.484 |           0.493 |      0.808 |
|      52 |         0.811 |           0.763 |      0.940 |        0.940 |          0.614 |           0.598 |      0.798 |
|      74 |         0.943 |           0.920 |      0.993 |        0.988 |          0.800 |           0.788 |      0.945 |
|      76 |         0.921 |           0.933 |      0.995 |        0.993 |          0.823 |           0.830 |      0.948 |
|     100 |         0.979 |           0.985 |      1.000 |        0.998 |          0.920 |           0.925 |      0.988 |

Reading: the simulated binomial column matches the exact one (the simulation is sound); the rating
pipeline, which uses every match's full ranking and not only the A–B result, reaches 80% earlier
(one pair at about 32 matches, six pairs at about 49). The threshold stays the design's exact
binomial count (74 for four models): conservative, simple to explain, and the simulated advantage
holds only when the models really follow Plackett–Luce. Wider lineups need more (ten pairs: 80).

**The bot batch** (design §6.4: bots of known strength through the same pipeline): `bun run sim --
batch --variant "v: perfidia-1@1.1.0" --seeds 1-48 --players 6 --out <scratch>` (48 matches of
conqueror@3, two expander@2, opportunist@3, rusher@3, turtle@3; 7 days) then `bun run stats --
aggregate --runs <scratch> --exploratory` (2 min 54 s for 48 matches, 288 seats, 1000 replicates):
48 blocks, block bootstrap. Strengths (95%): expander@2 1.687 [1.428, 2.011], opportunist@3 1.677
[1.268, 2.131], conqueror@3 1.322 [0.973, 1.678], rusher@3 −2.060 [−2.518, −1.592], turtle@3 −2.626
[−3.107, −2.233]. The pipeline separates the two tiers by more than 3 log-units and, inside the
bottom tier, rusher@3 from turtle@3 (31 of 48 ahead, difference 0.565 [0.078, 1.226]); it does not
separate conqueror@3 from expander@2 (13 of 48, −0.365 [−0.842, 0.044]) or expander@2 from
opportunist@3 (28 of 48, 0.010 [−0.455, 0.492]). The claim state on that root is honest: five items,
ten pairs, α 0.005, 48 matches, a 70/30 claim needs 80 (power now 0.40): `too_few_matches`, 32 more.

## 45. The routes (the web's contract)

All three are `GET`, return JSON validated by the named schema (`@perfidia/protocol/spectator`),
appear in the OpenAPI document (`MatchStats`, `Models`, `ModelDetail`), behave identically on the
Elysia and raw adapters (contract tests on both), and return errors as `ApiError {code, message,
hint}`.

| Route                                       | Body                                                                                                             | Cache-Control                                                      | Errors                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `/api/matches/:id/stats`                    | `MatchStatsSchema`                                                                                               | `private, max-age=3600` once the match is final, else `max-age=10` | 404 `NOT_FOUND` (unknown or not public), 503 `LOADING` (`retry-after`), 422 `BAD_REQUEST` |
| `/api/models`                               | `ModelsResponseSchema` = `{format, grouping, published, matches[], series[], blocks, models[], claims, ratings}` | `private, max-age=60`                                              | 404 `NO_STATS`, 404 `STATS_NOT_PUBLIC`, 503 `LOADING`                                     |
| `/api/models/:id` (`:id` a `ModelIdSchema`) | `ModelDetailSchema` = `{format, grouping, published, model, claims, rating, seats[]}`                            | `private, max-age=60`                                              | 404 `NO_MODEL`, 404 `NO_STATS`, 404 `STATS_NOT_PUBLIC`, 503 `LOADING`, 422 `BAD_REQUEST`  |

- **Per-match statistics** are computed on the main thread from the steps the fold workers already
  made and the frame at the tail (never a fold on the request thread), with the side files read
  whole; kept per match (up to 32) while the timeline and the side files are unchanged, and
  recomputed at most every 5 s for a running match. They equal `bun run stats -- match` of the
  same directory (test on both adapters).
- **Model statistics** are the file `bun run stats -- aggregate --out <file>` wrote, served with
  `serve --stats <file>` (re-read when it changes). Served only when every match it aggregates is
  public now: an unlisted or hidden match makes it `STATS_NOT_PUBLIC` (fail closed), one still
  loading `LOADING`. No `--stats`, an unreadable or invalid file, or an `--exploratory` file:
  `NO_STATS` (the server logs a warning when it reads such a file). `/api/models` drops the file's `seats` and `exploratory`;
  `/api/models/:id` carries that model's seats and its headline rating item (null below the
  threshold).
- **`--no-costs`** (the owner's default is costs published): `published.costs: false`, and every
  cost, token and model-time figure is null in all three routes (`cost`, `operations.latencyMs`,
  `ttftMs`, `costNanoUsd`).

What the web uses:

- the claim state: `claims.state`, `claims.matches`, `claims.needed`, `claims.more`,
  `claims.power`, `claims.pairs`, `claims.table` — "too few matches: N more needed" when
  `state !== "ok"`, never a ranking; `ratings === null` and every `outcome === null` then;
- ratings when `ok`: `ratings.headline.items[] {id, strength, interval, elo, eloInterval,
  meanRank, meanRankInterval}` (sorted by id; the web chooses the display order),
  `ratings.headline.pairs[]`, `ratings.clean` for the sensitivity view, `ratings.intervals
  {method, blocks, replicates, level}` to say how intervals were made;
- per model: `id`, `key`, `kind`, `model {provider, model, endpoint, effort, intended,
  quantization, effortSent}`, `fake`, `matches`, `seats`, `handoffs`, `play`, `diplomacy`,
  `military`, `incidents.parallelPermille`, `operations.toolErrors`, `cost.perMatchNanoUsd`,
  `cost.perWakeNanoUsd`, `cost.cacheReadPermille`, `cost.byLineup[]`, `outcome`;
- per match (the dossier's model block): `seats[].model`, `profile`, `promptVariant`, `fake`,
  `incidents` (hand-off, caps, `parallelPermille`), `operations.reasoningKinds`, `cost`,
  `diplomacy.sameModel` / `crossModel`, `outcome.rank`, and `series` / `lineup`.

## 46. `bun run stats`

```sh
bun run stats -- match <run-dir> [--json] [--no-costs]
bun run stats -- aggregate --runs <dir> [--publish <publish.json>] [--group model|profile|variant|model-profile] \
  [--seed N] [--replicates N] [--no-costs] [--exploratory] [--json] [--out <file>]
bun run stats -- power [--p 0.7] [--matches 12,20,32,48,76] [--reps 200] [--replicates 200] [--seed N] [--json]
```

- `match`: one match as a seat table, or the `perfidia-stats/1` document with `--json`; a
  `series.json` next to the run directory gives its series match.
- `aggregate`: the claim line ("claims: too few matches, no ranking shown: … 70 more"), the model
  table, the series found, and, once the threshold is met (or with `--exploratory`, labelled
  EXPLORATORY), the headline and clean ratings with their pairs. `--out` writes the file atomically
  (temporary file and rename) for `serve --stats`.
- `power`: the exact table and the simulated rows of §44.
- Exit codes: 0 ok, 2 a run directory cannot be read, 3 usage. Only the run directories (and
  `series.json`, `publish.json`) are read; nothing is sent anywhere.

A rotated series is aggregated where `arena series --out <dir>` wrote it (the root holds
`series.json` and one run directory per match); the server discovers the same root with
`serve --runs <dir> --stats <file>`.

## 47. Tests and measurements (Pass 3 statistics)

Tests (50 in the new files, in `packages/protocol`, `packages/spectator` and `packages/server`;
none touches the network):

- `spectator/src/stats/stats.test.ts` (11): on the war golden, every seat's turns, messages,
  proposals and betrayals equal the dossier's `counts` and the fold's seat tally; ranks equal the
  end line's standings; event sums (42 battles, 7 proposals, 10 messages, p2 betrays p3); bots-only
  nulls; an unverifiable log is not rated; two fake runs' wakes, attempts, cost and cost by kind
  equal `arena.json` per seat; planted secrets and texts never appear; `--no-costs`; hand-made
  feeds for pacts kept and broken, alliances, same and cross model, self-identification, labels and
  ids, the preflight split (4/3), the parallel share (667‰), tool rounds and fallbacks.
- `server/src/stats/pl.test.ts` (4): the MAP fit recovers known strengths from 600 drawn rankings
  within 0.3 and orders every pair more than 0.6 apart (fast-check, 25 runs, seed 4242); it is
  deterministic, stationary (no nudge raises the log-posterior) and finite for an item always last;
  the two-item closed form; the pipeline's intervals are deterministic for a seed, cover the truth,
  and fall back to Laplace below 5 blocks.
- `power.test.ts` (5): the design's table (20/49/199, 32/74/303), the draft's powers, the sawtooth,
  a deterministic simulation.
- `aggregate.test.ts` (9): a 76-match rotated series (19 blocks of 4) reaches `ok` and recovers the
  four models' order; 8 matches stay `too_few_matches` with no outcome; `--exploratory`; clean seats
  = 76 × 6 − 8 handed-off; the output is identical for a seed, and another seed moves the intervals,
  not the fit; cost per lineup; groupings; id collisions.
- `cli.test.ts` (8): the table and `--json`; a capped run's hand-off and LLM figures equal
  `arena.json`; a 4-match `budget-mix` fake series grouped by `series.json` (one block of four,
  each model on each profile once, 70 more matches needed, no ranking); old run directories (the
  war golden, a `perfidia-arena/1` run, a hand-off) aggregate without error; `--no-costs`,
  `--publish`, `--out`, `--exploratory`; usage errors.
- `routes.test.ts` (10, both adapters): served per-match statistics equal the CLI's; cache headers;
  `/api/models` has no seat list and no ranking below the threshold; `--no-costs` withholds every
  figure; `publish.json` visibility (`NOT_FOUND`, `STATS_NOT_PUBLIC`, a fitting public file
  served); `NO_STATS` without `--stats` and for an `--exploratory` file.
- `protocol/src/stats.test.ts` (3) and `stats.fixtures.test.ts` (valid and invalid fixtures of the
  14 schemas, checked by `schemas.test.ts`); the contract (the three paths in the OpenAPI document),
  security (nothing served holds a `seed` key: the series seed is never copied), and architecture
  (only `stats/runs.ts` folds whole logs; nothing imports the CLI) suites cover the rest.

Measurements (this box, 4 vCPU shared):

- `bun run stats -- match` on the war golden (16,253 lines, bots only): 3.98 s wall, nearly all of
  it the fold (the spectator's war test folds it in 3.5 s).
- A 4-match, 7-day `budget-mix` fake series aggregated in 19.5 s (fake ledger spend $10.13 in all);
  per model per match: Haiku $0.24, GPT-6 Luna $0.27, GLM-5.3 Flash $0.36, Gemini 3.8 Flash $1.66
  (fake brains, the real cards); parallel share 800–826‰, cache reads 851–861‰.
- The 48-match bot batch aggregated with 1000 replicates in 2 min 54 s; a 1000-replicate bootstrap
  over 100 synthetic matches takes about 1.1 s.
- `@perfidia/protocol/spectator` bundle 38,212 → 39,765 bytes gzipped (the statistics schemas);
  the web's initial JS 174.7 → 176.1 KB gzipped (budget 185).
- `bun run check`: 3,781 pass, 34 skip, 0 fail (3,815 tests in 304 files, 9 min 16 s);
  `bun run test:e2e` (web sources unchanged): 11 pass in 23 s.

## 48. Deviations and open items (Pass 3 statistics)

Deviations from design §6:

- `/api/models/:id`, not `:key`: a key holds `/` and `@`; the id is its URL-safe slug, the key is in
  the body.
- Mean-rank intervals exist only with the block bootstrap (from 5 blocks); Laplace intervals cover
  strengths and differences only.
- The claim threshold is the exact binomial count, although the simulated pipeline reaches 80%
  power earlier (§44).
- Pair `aAhead` compares each item's best seat when an item holds two seats in a match.
- An item's latency is the attempt-weighted mean of its seats' p50 and p95, not a pooled
  percentile (the per-attempt latencies are not kept in the aggregate).
- Fake LLM seats are their own items (provider `fake`), counted in the claim state of a fake root:
  a fake root is a rehearsal, never a claim about models.

Open items:

- The server reads one `series.json`, at the runs root: one series per root (nested series roots
  are not discovered).
- The orchestrator's `report.ts` and `arena.json` are unchanged (owned elsewhere): the parallel-call
  share and series grouping are in `bun run stats` and the routes, and the plan's warning still
  says the share is "not reported yet".
- Web pages (agent G): built, Part V (§49–§54).
- No real-model statistics yet: every LLM figure above comes from `--fake` runs.

# Part V: Pass 3, the web (agent G)

## 49. What Pass 3's web delivers

The spectator web app (`packages/web`, docs/phase3.md) on the statistics of Part IV, through the
three routes of §45 and nothing else (every payload parsed with the `@perfidia/protocol/spectator`
schemas in `api/client.ts`: `matchStats`, `models`, `model`):

- **Names** (`lib/models.ts`, §50): every model of the arena's catalog and every provider has a
  display name; an unknown id shows as it is; a fake seat reads "Fake", never a model's name.
- **Reasoning kinds** (§50): wherever reasoning is shown (the Thoughts column's toggle, a turn's
  reasoning, the live reasoning, the turn detail's rounds, the dossier) it says what it is: a
  provider's summary or a raw chain of thought. GLM's raw reasoning is never shown unlabelled.
- **The dossier's model block** (`players/model-block.tsx`, §51): the seat's model, provider,
  endpoint, effort in the vendor's terms, reasoning kind, harness, lineup and series, calls,
  incidents, and its spend and the match's budget when costs are published.
- **The `/models` page** (`models/**`, §52): the claim state, the ratings with intervals only
  above the threshold, every model's figures by name, the matches covered, and a page per model.
- **Links**: "How the models compare" in the match list's header and "Models" in the match header.
- Everything new loads on demand: the initial JS grows by 1.3 KB gzipped (176.1 → 177.4 KB, budget
  185). No dependency was added; engine, gateway, bots, sim, orchestrator, server, spectator,
  protocol and the goldens are untouched.

## 50. Names, efforts and reasoning kinds (`lib/models.ts`)

| Function                              | What it gives                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelName(id)`                       | The short name, for badges: "Opus 5.5", "Fable 5.1", "GPT-6.1 Sol", "GPT-6 Luna", "Gemini 4 Argon", "Gemini 3.5 Flash-Lite", "GLM-5.3", "GLM-5.3 Flash", "Kimi K3", "DeepSeek V4.1 Flash"; Claude, GPT and Gemini ids by family pattern, the open models by table; an unknown id as it is |
| `fullModelName(m)`                    | "Claude Opus 5.5", "GPT-6.1 Sol", "Gemini 4 Argon"; a routed model with its route: "GLM-5.3 (Z.AI via OpenRouter)", "Kimi K3 (Moonshot AI via OpenRouter)", "x (OpenAI-compatible endpoint)"                                                                                              |
| `routeWords(m)`, `hostName(endpoint)` | The route from `model.provider` and `model.endpoint`: the endpoint slug's host (`z-ai/fp8` → "Z.AI"; 17 hosts named, an unknown one as its slug) "via OpenRouter"                                                                                                                         |
| `effortWords(provider, effort)`       | The effort in the vendor's own terms: Anthropic "effort medium", OpenAI and OpenRouter "reasoning effort low", Google "thinking level medium"                                                                                                                                             |
| `seatReasoningKind(seat)`             | What a seat's reasoning is expected to be, from its provider (a fake seat: its intended model's): `summary` for Anthropic, OpenAI and Google, `raw` for OpenRouter and compat; a logged kind wins                                                                                         |
| `modelLabel`, `playedBy`              | The badge ("GLM-5.3 · low", "Bot", "Fake") and the tooltip ("GLM-5.3 (Z.AI via OpenRouter), reasoning effort low"; "Claude Opus 5.5 (Anthropic), effort medium")                                                                                                                          |
| `rehearsalOf(seat)`                   | A fake seat in words that never call it the model: "stands in for GPT-6 Luna (OpenAI)"                                                                                                                                                                                                    |

**Reasoning-kind labels** (`common/reasoning-kind.tsx`, `ReasoningKindTag`): "Reasoning summary",
"Raw chain of thought" (in gold) or "No reasoning shown", with a tooltip saying what the kind means
("a summary the provider writes of the model's hidden reasoning, not the reasoning itself"; "the
model's own reasoning text, as it produced it: unedited"). Where they show:

- the "Reasoning" toggle under a thought (the feed, the Thoughts column, the dossier):
  "Reasoning (summary)" or "Reasoning (raw chain of thought)", from the seat's kind;
- a turn's reasoning (`thoughts/turn-reasoning.tsx`) and the turn detail's rounds
  (`turns/rounds.tsx`): one tag per round with reasoning, from the round's logged `reasoningKind`
  (`AnnotationRound.reasoningKind`, kept in `RoundRow.reasoningKind` by `turns/detail.ts`), else the
  seat's;
- the live reasoning (`thoughts/live.tsx`): the seat's kind (the socket's `annot` messages carry
  none);
- the dossier's model block and a model's page: the kind, with the attempts of each kind.

A fake seat's reasoning is the bot's ("Fake reasoning: …") and carries the kind its intended model
logs (the fake adapter mirrors it), so a rehearsal of GLM shows "Raw chain of thought" too, beside
its "Fake" badge.

## 51. The dossier's model block

In the dossier's "Who plays it", under the badge, the hand-off and the spend bar, for an LLM seat
(`players/model-block.tsx`, a chunk of its own through `LazyModelBlock`):

- **Who:** the full name and the provider line ("OpenRouter · endpoint z-ai/fp8 (fp8), served by
  Z.AI"); a fake seat reads "Rehearsal: a scripted bot stands in for GLM-5.3 (Z.AI via
  OpenRouter): its play, reasoning and costs are the bot's, priced at that model's card".
- **Effort** in the vendor's terms, with the level actually sent when it differs (`effortSent`).
- **Reasoning**: the main kind as a tag and the attempts of each kind (`operations.reasoningKinds`;
  the counts hidden when the server publishes no reasoning).
- **Lineup** and series ("budget-mix · series budget-mix, block 1, match 2").
- **Harness**: profile, the operator channel (system messages, developer messages or `[harness]`
  text in its user turns) and the reminder cadence.
- **Calls**: wakes, rounds, tool calls, attempts, the parallel-call share, tool-call errors, and
  latency (median and p95; left out when no latency was measured, as on fake runs).
- **Incidents**: hand-off (when, why, to which bot), wake caps, prompt-cap stops, error wakes,
  refusals by category, fallback share; "none" when nothing happened.
- **Spent** (costs published): the seat's total, per wake, cache reads, tokens, fees, "(simulated
  prices)" for a fake; **Match**: every seat's spend together against the match budget. Under
  `--no-costs`: "Costs not published for this match.", no figure.
- **Same model**: messages, pacts and alliances with seats on the same model against the others,
  when the lineup repeats a model (design §3.8).

The figures are the match's statistics (`GET /api/matches/:id/stats`), fetched once per match and
shared by its dossiers (`players/match-stats.ts`; a running match's are fetched again when a dossier
opens more than 10 s after the last fetch, the old ones shown meanwhile). They cover the whole match
(or the match so far), whatever the playhead, and the block says so. Before they come, or when they
cannot be had, the block shows what the seat list says (name, provider, effort, expected kind).

## 52. The `/models` page

`/models` and `/models/:id` (`lib/router.ts`; `:id` as `ModelIdSchema`, else "Nothing here"), a page
loaded on demand (`models/lazy.ts`, `models/models-page.tsx`, `models/parts.tsx`, pure formatting in
`models/format.ts`):

- **The claim state first** (`data-testid="claims"`):
  - below the threshold: "Too few matches: 70 more needed (power now 0.00)." from `claims.more` and
    `claims.power`, then "No ranking is shown until then: the models are listed by name, and no
    rank, rating or win count appears.", the threshold in words ("A ranking is shown once every
    pair of models has met in 74 rated matches: enough to see a 70/30 head-to-head edge 80% of the
    time (exact binomial test, α = 0.05 split over 6 pairs)") and the `claims.table` (needed and
    power now at 80/20, 70/30, 60/40);
  - `no_comparison`: "No comparison yet: no two models have met in a rated match";
  - `ok`: "Enough matches for a ranking: …" and the ratings below.
- **Ratings** (only when `claims.state` is `ok` and `ratings` is served): items by strength, with
  the Elo-like rating, its 95% interval in figures and as a bar on a common scale, the mean rank
  with its interval (block bootstrap only), the rated matches; the method in one sentence (MAP
  Plackett–Luce, prior σ, block bootstrap over N blocks or Laplace); the head-to-head pairs (a
  ahead of b in k of n, the difference and its interval, "not separated" when it holds 0); the
  clean-seats sensitivity table.
- **Per model** (`models-table`): every item by name, never by outcome (models, then rehearsals,
  then bots): matches, wakes, cost per match and per wake, cache reads (costs published only),
  tool-call errors, the parallel share, hand-offs, messages, pacts kept and broken, betrayals by and
  of, battles won; mean rank and wins only above the threshold. A fake item reads "Fake for GPT-6
  Luna" with "Rehearsal: a scripted bot", and a note says that rehearsal figures test the arena and
  say nothing about any model.
- **Matches** (`matches-table`): the series found (planned and found, blocks, Graeco-Latin), then
  each match (a link to it), its lineup and series place, rated or not, and its seats' models; 50
  shown, then "Show all".
- **A model's page** (`/models/:id`, `model-detail`): its name, route and effort, the reasoning it
  shows, its key; the claim state in short; its rating above the threshold; play, diplomacy,
  battles, incidents, model calls, cost (with the cost per lineup and its interval) and, above the
  threshold, the outcome (mean rank, ranks, wins, cities); its seats match by match (a link to each
  match; the rank above the threshold only).
- **Errors**: `NO_STATS` ("No model statistics are published on this server yet."),
  `STATS_NOT_PUBLIC`, `NO_MODEL`, a network failure with "Retry"; a `LOADING` answer is asked again
  after its `Retry-After` (at most 30 times).
- **Costs** under `--no-costs`: "Costs not published on this server.", and no cost column or figure.

The page never computes a ranking: it shows the server's (which is null below the threshold) and
sorts by name otherwise; the web needs no seed and is served none.

## 53. Tests and measurements (Pass 3 web)

Unit tests (pure, no DOM; `bun test packages/web/src`: 213 pass):

- `lib/models.test.ts` (7): the names; **every catalog model** (`MODELS` of the orchestrator, 17)
  has a name other than its id, a named provider and the provider its id implies; full names and
  routes; efforts in each vendor's terms; badges and tooltips; fake seats read "Fake" and never the
  model's name, while `rehearsalOf` says whose seat they stand in for (fast-check, 60 runs);
  reasoning kinds per provider and per fake, and **the catalog's `capabilities.reasoning` equals the
  web's expectation for every model**.
- `models/format.test.ts` (9): sub-cent dollars (fast-check, 300 runs: within $0.00005), shares,
  intervals, times and tokens; the claim headline and explanation in each state; the display order
  (models, rehearsals, bots, by name); ratings by strength; words for reasoning kinds, channels,
  reminders, hand-offs, series and counts.
- `lib/router.test.ts` (+1): `/models`, `/models/:id` with the `ModelIdSchema` grammar, round trips.
- `turns/detail.test.ts` (+1): a round keeps its annotation's reasoning kind; a live round adds text,
  not a kind.
- `architecture.test.ts`: links may come from `modelHref`; the models page, its formatting and the
  model block are never in the initial load (checked on the metafile); the initial budget.
- `lib/cn.test.ts`: model ids (`z-ai/glm-5.3` looks like a z-index class) are not class names.

The smoke test (`bun run test:e2e`, 13 tests, 2 new in `e2e/checks/models.ts`): the fake run now
plays `budget-mix` (Haiku 5.5, GPT-6 Luna, Gemini 3.8 Flash, GLM-5.3 Flash on OpenRouter; the
earlier checks pass unchanged on it), and the setup aggregates it with `bun run stats -- aggregate`
(a subprocess, run while the folds go on) for both servers' `--stats`:

- `/models`: the headline equals "Too few matches: {more} more needed (power now {power})." from
  `/api/models` (parsed with `ModelsResponseSchema`); no ratings, no "Mean rank" or "Wins" column;
  the six items by name ("Fake for Claude Haiku 5.5", …, "Fake for GLM-5.3 Flash (Z.AI via
  OpenRouter)", "Fake for GPT-6 Luna", the two bots); the rehearsal note; a model's link opens its
  page in place (URL, raw-reasoning tag, a seat linking to `/m/fake1`, no rating); on the
  `--no-costs` server, "Costs not published on this server." and no `$`.
- The GLM seat's turn 2 by deep link: every round's reasoning tagged raw, none summary; its dossier's
  model block ("Rehearsal", "stands in for GLM-5.3 Flash (Z.AI via OpenRouter)", "reasoning effort
  low", "Raw chain of thought", "budget-mix", a spend with "(simulated prices)"); the Thoughts
  column's toggles "Reasoning (raw chain of thought)" for GLM and "Reasoning (summary)" for Haiku.
- Added to existing tests: the list's header links to `/models`; on the `--no-costs` server the
  model block says "Costs not published for this match." with no figure.
- Every page: no console error, no CSP violation, no HTML sink.

Measurements (this box, 4 vCPU shared):

- **Smoke test:** 17.5–18.4 s in seven runs (budget 20 s), against 15.2–15.8 s before this pass
  (the default-lineup fake run; switching it to `budget-mix` alone measured 15.8 s). The models
  checks take 0.6 s, the reasoning-kind checks 1.1–1.2 s; the aggregation (about 0.7 s) overlaps
  the folds.
- **Sizes** (`bun run web:build`): initial JS 177.4 KB gzipped (176.1 KB before; budget 185 in the
  architecture test, whose own build is 182,356 of 189,440 bytes); lazy JS 65.4 KB (51.5 KB
  before). New chunks: the models page 8.3 KB gzipped (`models-page.tsx` and `parts.tsx`), its
  formatting 1.8 KB (shared with the model block), the model block with its loader 3.0 KB, the
  kind tag 0.3 KB. CSS 10.5 KB.
- **Looked at** (headless Chromium, 1440 × 900 and 390 × 844, on a scratch server with a 2-day
  `budget-mix` and a 2-day `mid-tier` fake run, copies of both relabelled as if real providers had
  served them, for the non-fake names, and a 76-match fake series for the `ok` state): `/models` too
  few and ok, a model's page (GLM-5.3, and a rehearsal with its outcome), the dossiers of GLM-5.3
  (real and fake) and Gemini 3.8 Flash, the GLM turn detail with raw reasoning, the Thoughts column,
  the `NO_STATS` page, the match list on a phone. Fixed from looking: GLM's route printed twice in
  its table row; fake rows cut to an unreadable "Rehearsal: a bot that stands in for Clau…" (now
  "Fake for Claude Haiku 5.5"); a sticky first column three quarters of a phone wide; match ids and
  lineups broken across lines; the power table's caption squeezed into the table's width; the
  ratings' item names carrying their ids; wrapped intervals; the model block's harness line saying
  "notes" twice, its cap repeated from the spend bar, and "0 ms" latencies of fake runs.
- **`bun run check`**: green, 3,796 pass, 36 skip, 0 fail (3,832 tests in 305 files, 9 min 2 s;
  the two new smoke tests are among the skipped without `PERFIDIA_E2E`). **`bun run test:e2e`**
  (`PERFIDIA_E2E_PORT=8401 PERFIDIA_E2E_PORT2=8402`): 13 pass in 17.5 and 18.4 s.

## 54. Deviations and open items (Pass 3 web)

Deviations:

- **A fake seat names the model it stands in for**, in words that say it is a rehearsal ("Fake for
  GPT-6 Luna", "stands in for GLM-5.3 Flash (Z.AI via OpenRouter)"), on the models page and in the
  dossier's model block. Badges, tooltips and the match views still read "Fake" alone (phase 3's
  rule); without the model's name, four rehearsal rows of a `budget-mix` series would all read
  "Fake".
- **Badges keep the short name and effort** ("GLM-5.3 · low"); the route and the vendor's effort
  term are in the tooltip, the dossier and the models page.
- **The live reasoning is labelled with the seat's expected kind**: the socket's `annot` message has
  no `reasoningKind` (a protocol change, not this pass's); the annotation's logged kind replaces it
  once the turn's annotation is fetched.
- **The smoke test's fake run plays `budget-mix`** instead of the default Claude lineup, so that the
  non-Claude names and the raw reasoning are checked in the browser; every earlier check passes on
  it.
- The CLAUDE.md lines for `/models` and `e2e/checks/models.ts` are left to the owner (an agent
  message cannot authorise CLAUDE.md changes).

Open items:

- **No real-model page has been seen**: every figure looked at comes from `--fake` runs (and
  relabelled copies of them). Latency, reported costs and fallbacks of real providers will show for
  the first time after the owner's M2 and M3 runs.
- **The smoke test's margin is 1.6 to 2.5 s** (17.5–18.4 s of 20 s) on a quiet container.
- **The rating table** shows rehearsal items and bots among the models when a root mixes them (as
  the statistics do: fake items are their own items, §48); a root of real matches only has none.
- **The model block shows whole-match figures** at any playhead (the statistics route has no
  playhead); the block says so.
