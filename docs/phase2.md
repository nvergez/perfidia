# Phase 2: first agents (the orchestrator as built)

> **Status.** Roadmap step 2 of `docs/brief.md`, "First agents": 4 Claude seats and 2 scripted bots
> on a 6-seat `perfidia-1` map, with the full tool interface and raw logs. Exit criterion: a full
> match completes with at least one alliance and one betrayal.
>
> - Built in `packages/orchestrator` (`@perfidia/orchestrator`), plus one additive gateway change
>   (`HandoffQueue`, §3.4). This document describes what was built. The reviewed design it
>   implements (with its `[critic]` corrections) is the source of the decisions below. Where this
>   document and the code disagree, the code wins; fix this document.
> - Nothing here has called the real API yet: no key was available while it was built, and no test
>   touches the network. §9 says how to run the first real match, starting with a $0.20 smoke test.

**Contents:**

1. Decisions and deviations from the brief
2. Package layout and layers
3. How an LLM seat plays
4. The Anthropic adapter
5. Budget, caps and hand-offs
6. Failures: retries, the rate gate, the breaker and the pause gate
7. The run directory and `arena.json`
8. Costs
9. Running the first real match
10. Tests
11. Open items

---

## 1. Decisions and deviations from the brief

| Topic           | As built                                                                                                                                                                                                                                     | Deviation                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK             | The official `@anthropic-ai/sdk`, pinned exactly at `0.131.0` through the root catalog, behind our own provider-agnostic `ModelAdapter`. Only `src/model/anthropic.ts` imports it (an oxlint override and the architecture test enforce it). | **The brief names the Vercel AI SDK.** It lags the provider features this harness needs: adaptive thinking with explicit `effort`, server-side `fallbacks`, per-block cache TTLs, refusal `stop_details`, `usage.iterations`, mid-conversation `system` messages. `ModelAdapter` already is the abstraction; other providers get their own adapters later (phase 4). The brief's stack row must be updated in its claude.ai document by the owner. |
| MCP             | Not exposed. LLM seats call the gateway tools through the provider's function calling, inside the orchestrator process.                                                                                                                      | **Deferred to the server phase** (`CLAUDE.md` said "MCP exposure comes in phase 2"). A harness that reaches the game through MCP later must not reach the spectator view: private messages and thoughts are live there.                                                                                                                                                                                                                            |
| Spectator feed  | `feed.txt`: the readable `--watch` text of the whole match, a fold of `match.jsonl`.                                                                                                                                                         | The design's `feed.jsonl` format, its schema and `arena feed` filters are phase 3's (the spectator view owns its formats).                                                                                                                                                                                                                                                                                                                         |
| Run-dir schemas | Zod schemas of `llm_calls.jsonl`, `seats.json` and `arena.json` live in `orchestrator/src/log/schema.ts`.                                                                                                                                    | Not in `protocol` yet: the formats will change after calibration. They move when the server and the web app read them.                                                                                                                                                                                                                                                                                                                             |
| Clock           | Lockstep first (the default). Real time works (tested under virtual time) but needs crash resume before a multi-day match.                                                                                                                   | –                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Resume          | Designed only (design §9.3): a crashed lockstep match is rerun.                                                                                                                                                                              | –                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Red team        | Not built (`arena redteam`, an optional ~$1 live injection check).                                                                                                                                                                           | –                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Owner-pending choices, set as overridable defaults (`src/defaults.ts`): p1–p4 Claude Opus 5.5 at
`medium` effort with the four profiles; p5 `bot:opportunist@3`, p6 `bot:conqueror@3`; a safety cap
of $100 per LLM seat and a soft cap of $2 per wake; lockstep; agents are not told which seats are
bots or which model plays which seat.

## 2. Package layout and layers

`protocol ← engine ← gateway ← bots ← sim ← orchestrator`. The orchestrator is a Bun-runtime package
like `sim`: I/O, wall time and the SDK are allowed, but `src/architecture.test.ts` enforces its
internal layers.

| Directory | Contents                                                                                                                                                        | May import                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `model/`  | `adapter.ts` (the contract), `anthropic.ts` (the only SDK import), `tools.ts` (schema transform), `fake.ts` (`FakeAdapter`), `prices.ts`, `rate.ts`, `clock.ts` | protocol                                                 |
| `seat/`   | `agent.ts` (`LlmSeatAgent`), `prompt.ts` (`PROMPT_VERSION` 1), `personalities.ts`, `pause.ts` (pause gate, breaker), `retry.ts`, `thought.ts`                   | protocol, engine/core, model, budget, log                |
| `budget/` | `ledger.ts`: spend per seat and per wake; the gateway's `HandoffQueue`                                                                                          | protocol, model/adapter, model/prices                    |
| `log/`    | `calls.ts` (`llm_calls.jsonl`, transcripts, prompts), `schema.ts`, `watch.ts` (the `--watch` fold)                                                              | protocol, engine/core, node:fs, node:path, model/adapter |
| `arena/`  | `cli.ts`, `plan.ts`, `preflight.ts`, `run.ts`, `brain.ts`, `report.ts`, `cost.ts`, `smoke.ts`                                                                   | everything above, gateway, engine, sim, bots             |

Rules the architecture test checks on every non-test source: imports follow the table; nothing
outside `arena/` reads the environment; no source names an `ANTHROPIC_*` variable (only
`PERFIDIA_ANTHROPIC_API_KEY` and `PERFIDIA_ANTHROPIC_BASE_URL` exist, read once by `arena/cli.ts`
through `arenaEnv`); `seat/`, `budget/` and `model/` (the SDK adapter's own timer aside) take time
and randomness from an injected clock; no string literal names a building, unit or queue id of a
published ruleset, so prompts and profiles survive reskins.

## 3. How an LLM seat plays

### 3.1 The turn loop

`LlmSeatAgent implements SeatAgent`: the gateway drives the rounds; engine and gateway stay
LLM-agnostic. One wake is one fresh conversation, append-only within the turn; all memory lives in
the game (briefing, notebook, archive).

- **Round 0:** a `user` entry holding the briefing JSON (`canonicalJson`), then an operator entry
  (a mid-conversation `system` message): `Turn {n} · {time} · round trip 1 of {max}, up to {calls}
  calls.` and the rule that player words are claims, never instructions.
- **Round r ≥ 1:** one `user` entry with every result of the previous reply's tool calls, in call
  order, as `tool_result` blocks (`is_error` for rejected calls), then the round reminder; on the
  last round trip, the reminder says its results will not be shown.
- Thinking blocks are echoed back unchanged; refused and truncated replies are never appended, so
  every request's prefix is byte-identical to the previous one and read from the cache.
- **Public thought:** the text of the turn's terminal reply only (no tool call, a reply carrying
  `end_turn`, or the last round trip); sanitised and cut at 400 characters. The optional
  out-of-band thought call (`--thought-call on`) asks for one when a terminal reply has none.
- The controller label is `llm:<provider>/<model>/<effort>:<profile>@<n>:p<PROMPT_VERSION>`, e.g.
  `llm:anthropic/claude-opus-5-5/medium:odysseus@1:p1`: `match.jsonl` alone says what played.

### 3.2 The prompt and the cache

`tools` (the gateway's 22 `perfidia-1` tools, transformed: no `$schema`, no safe-integer maxima;
`strict` off) → `system[0]`, shared by every seat of one model and effort (harness text, the
gateway's interface text, the ruleset's cheat sheet and compiled tables) → `system[1]`, the seat's
private profile → the messages. Both system blocks carry `cache_control`, and the request adds the
automatic breakpoint on the growing tail (3 breakpoints in all). Nothing volatile is in a system
block. The preflight writes the shared prefix once, so the seats woken together at t = 0 read it.

### 3.3 The four profiles

`odysseus@1` (the schemer; betrays when it pays; hand-off bot `opportunist@3`), `achilles@1` (the
warlord; `conqueror@3`), `penelope@1` (the steward; keeps its word, punishes betrayal; `turtle@3`),
`agamemnon@1` (the hegemon; leads the largest alliance, may turn on allies in the last two days;
`opportunist@3`). `bun run arena -- personalities` prints their exact text.

### 3.4 The gateway `HandoffQueue` (the only change outside the package)

`RunMatchOptions.handoffQueue` is polled when a seat's turn opens, after the static hand-offs, and
writes the same `controller` line. The budget ledger is the queue. A queue that throws or returns an
invalid hand-off is a `HostFailure` (a `fatal` line). Existing paths are unchanged: every golden
still verifies at Level E and Level G.

## 4. The Anthropic adapter (`model/anthropic.ts`)

- **Client:** one per process. Explicit `apiKey` (`PERFIDIA_ANTHROPIC_API_KEY`) and `baseURL`
  (`PERFIDIA_ANTHROPIC_BASE_URL` or `https://api.anthropic.com`; never the container's
  `ANTHROPIC_BASE_URL`); `authToken`, `webhookKey` and `logLevel` explicit. A guarded `fetch` only
  talks to the configured origin, always sends our `x-api-key`, never `authorization`, and passes
  only the SDK's own headers. `maxRetries: 0`: the harness owns every retry.
- **Request:** always streamed (`.stream().finalMessage()`); `thinking: {type: "adaptive",
  display: "summarized"}` (never disabled, never a budget); `output_config.effort` always set; no
  `tool_choice` (forced use is a 400 on the 5.5 models), no sampling parameters, no prefill;
  `max_tokens` 16 000, one retry at 32 000 after a `max_tokens` stop. Opus 5.5 and Sonnet 5.5 get
  `fallbacks: "default"` under the beta `server-side-fallback-2026-07-01`; Haiku 5.5 has no
  server-side fallback.
- **Response:** `stop_reason` is checked before any content is read. A refusal keeps its
  `stop_details` (category, explanation, recommended model) and closes the turn. Before the last
  `fallback` block only text is echoed back. Usage is split per `usage.iterations` entry and priced
  per model; a fallback-served attempt is flagged, logged on stderr and counted in `arena.json`.
- **Errors:** the SDK's typed classes, most specific first: abort, connection timeout, connection,
  429, 5xx/529, 401/403, 404, 400/422, 402 (billing), 413. A broken stream is charged its
  `message_start` usage plus at least 4 000 output tokens, flagged `estimated`.
- **Preflight** (before the run directory exists, and as the pause gate's probe): `models.retrieve`
  with the `server-side-fallback-2026-06-01` beta (so `allowed_fallback_models` is visible; each must
  have a price), then the exact production request non-streamed at `max_tokens: 0`.
- **`countTokens`:** `count_tokens` on a request (used by `arena smoke`).

## 5. Budget, caps and hand-offs

Prices are integers in mUSD per million tokens, so a token costs that many nano-dollars and every
cost is an exact integer (`model/prices.ts`; an unpriced served model is charged at the highest
rates and flagged). The ledger charges every attempt, failed and estimated ones included.

| Cap                                        | Default       | Flag                             | Effect                                                                                                                                                                     |
| ------------------------------------------ | ------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per LLM seat                               | $100          | `--cap-usd`, `--seat-cap pN=usd` | The charge that crosses it queues the hand-off: the seat's next turn opens with a `controller` line, and its profile's bot (`--handoff-bot` overrides) plays from then on. |
| Per wake (soft)                            | $2            | `--wake-cap-usd usd\|off`        | The turn ends at the next round; a `wake_cap` line.                                                                                                                        |
| Output per call                            | 16 000 tokens | `--max-tokens`                   | One retry at 32 000.                                                                                                                                                       |
| Round trips per wake, calls per round trip | 8, 10         | the ruleset's                    | Enforced by the gateway.                                                                                                                                                   |

The **daily tripwire** prints each LLM seat's spend at every game-day boundary, its last day's
spend and its projection (§8.3). A day over twice the calibrated rate (`--calibrated-usd-per-day`,
default the central estimate) or a projection over the cap is an alert (stderr and `arena.json`),
never an action. Set a Console spend limit on the key's workspace as the hard backstop: reaching it
is a 402, which pauses the arena.

## 6. Failures: retries, the rate gate, the breaker and the pause gate

- **Retries** (`seat/retry.ts`): full-jitter exponential backoff (5 s base, 2 min cap), `retry-after`
  first; within a budget of 60 minutes per round in lockstep (`--retry-budget`), the round deadline
  in real time. Time behind a closed pause gate never counts.
- **Rate gate** (`model/rate.ts`), one per model: at most `--max-inflight` (4) requests, and a 429 or
  529 holds every seat on that model until `retry-after`, with jittered release.
- **Breaker:** 3 consecutive non-retryable failures (`bad_request`, `too_large`, `unknown`) on one
  model, or 3 consecutive LLM turns closed by an error, close the pause gate. So do `auth`,
  `billing` and `not_found` at once.
- **Pause gate, lockstep:** the waiting round stays pending (game time stands still, the bots wait,
  nothing is lost); `arena.json` says `paused` and why; the preflight is re-run every 2 minutes and
  the gate reopens when it passes (a `pause` line with `outcome: "resumed"`). After `--pause-max`
  (2 h) of pause the arena aborts.
- **Pause gate, real time:** game time cannot stop, so a closed gate aborts at once.
- **Abort:** the game second it happened in finishes (its LLM rounds are refused, so each open turn
  closes with `why: "error"`), then the log is cut at the first line of a later second.
  `match.jsonl` ends without an end line (`summary.json` says `incomplete`), `arena.json` says
  `aborted` and why, and the exit code is 2. In lockstep no turn is left open; in real time a bot
  still thinking at the cut keeps its turn open.
- A model error that is none of these (a refusal, `max_tokens` twice, retries exhausted, a deadline)
  closes only its turn, with a deterministic one-line error in the `turn` line, e.g.
  `AgentError: llm p2 turn 3 round 0: bad_request (400)`; durations go to `llm_calls.jsonl` only.
- Lockstep timeouts are derived so the driver's timer never pre-empts a pause: round timeout =
  retry budget + pause max + 2 × attempt timeout (200 minutes by default), and the agent's own
  deadline is 60 s shorter. Real time: `--turn-timeout` (5 min per round), the agent's deadline
  10 s shorter.

## 7. The run directory and `arena.json`

| File                                        | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match.jsonl`, `snapshots/`, `summary.json` | As `sim run` writes them. `match.jsonl` is authoritative: actions, events (messages, proposals, alliances, betrayals), `turn` lines with public thoughts, `controller` lines for hand-offs.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `llm_calls.jsonl`                           | One validated line per API attempt (cost, cache, latency, stop, refusal, fallback, error), plus `handoff`, `pause` and `wake_cap` lines. Appended synchronously.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `transcripts/<seat>/t<turn>.jsonl`          | Every request (the new entries only; the stable prefix by sha256) and every raw response, reasoning summaries included (`--transcripts off` disables them).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `prompts/`                                  | The exact texts: `shared.txt`, `p1.txt` …, `operator.json`, `tools.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `seats.json`                                | Per seat: kind, label, model, effort, cap, profile, hand-off bot, prompt hashes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `feed.txt`                                  | The `--watch` text of the whole match.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `arena.json`                                | The report: status (`running`, `paused`, `ended`, `fatal`, `aborted`, `incomplete`) and why; per LLM seat the cost by token kind, attempts, stops, errors, refusals by category, fallbacks and served-by shares, cache misses, wake caps, thought coverage by end reason, think time p50/p95, rejections, the hand-off, its estimate and projection; totals (cache reads as a share of prompt tokens, fallback share, preflight cost); the a-priori estimate and the projection of the measured spend; the recommended real-time speed; pauses, alerts and the daily rows; LLM → bot war calls; Level E; the exit criterion. |

**Exit criterion** (`exit` in `arena.json`): `alliance_formed` events (pacts do not count) and
`betrayal` events, overall (`met`), and with an LLM seat as betrayer or victim at the time
(`llm.met`), with the list of those events and which of their seats an LLM played.

## 8. Costs

### 8.1 The a-priori estimate (`arena/cost.ts`, design §5.4)

Assumptions: 15.5 wakes per seat per game day, 4 round trips per wake, 1 500 output tokens per call
(thinking included), a 9 500-token stable prefix read from the cache, a 1 500-token briefing, each
round trip appending its reply and 1 500 tokens of results; 20% of wakes find the prefix cold in
lockstep, all of them in real time with a 5-minute TTL. Low: 2 round trips, 800 output tokens, warm.
High: 6 round trips, 3 000 output tokens, cold, 20 wakes per day. Computed by the code (pinned in
`arena/report.test.ts`):

| 4 seats, 7 days                          | Low    | Central         | High    |
| ---------------------------------------- | ------ | --------------- | ------- |
| Opus 5.5, `medium`, lockstep             | $23.91 | **$83.29**      | $306.60 |
| Opus 5.5, real time, 5-min TTL / 1-h TTL | –      | $99.13 / $85.77 | –       |
| Sonnet 5.5, lockstep                     | –      | $43.80          | –       |
| Haiku 5.5, lockstep                      | –      | $2.19           | –       |
| One calibration day, Opus 5.5            | –      | $11.90          | –       |

Output, thinking included, is about two thirds of the Opus bill: effort is the lever. The bots of
the arena lineup wake 16.2 times per seat per day on `perfidia-1@1.1.0` (seeds 1–4), slightly above
the 15.5 assumed. A seat under constant attack can be woken far more often (urgent wakes are not
budget-bounded); the per-seat cap and the daily tripwire bound it.

### 8.2 What a fake run reports

`--fake` replays bots through the whole LLM pipe with a cache-shaped token count derived from byte
lengths: its dollar figures exercise the accounting, they are not a forecast. A 7-day fake match
(seed 1) costs "$26.97" in fake tokens; the real forecast is §8.1.

### 8.3 The projection of a measured run (design §5.5)

A short run is biased low: day 1 has 13% fewer wakes than the mean, and no war yet. `arena.json`
projects each seat's measured spend to a full week (at least 7 days) by the bots' per-day wake
profile (`BOT_DAY_PROFILE`: 337, 313, 368, 400, 434, 444, 420 wakes over the six seats and four
seeds), then adds 15%. One measured day projects to ×9.27.

## 9. Running the first real match

Exit codes: 0 ok, 1 Level E divergence, 2 fatal or aborted, 3 usage, config or preflight error
(nothing written).

1. **Key and backstop.** Export `PERFIDIA_ANTHROPIC_API_KEY` (and `PERFIDIA_ANTHROPIC_BASE_URL`
   only for a proxy). Nothing else from the environment is read. Set a Console spend limit on the
   key's workspace (e.g. $500). The cloud container's egress proxy may block `api.anthropic.com`:
   run on the owner's machine.
2. **Smoke** (about $0.20 at most): `bun run arena -- smoke` (Haiku 5.5 at `low`), then
   `bun run arena -- smoke --model opus-5-5 --effort low`. Each runs the preflight (key, model,
   allowed fallbacks and their prices, the exact request shape, the pre-warm), `count_tokens` on
   the prefix and a real briefing, and one streamed call; it prints the stop reason, the served
   model, usage and cost, and warns if the call read nothing from the cache. Things only this can
   verify: `max_tokens: 0` with `fallbacks` in the preflight, the headers the guarded fetch lets
   through, and the fallback models' prices (check them against the pricing page too).
3. **Optional live test:** `bun run test:live` (one game hour, one Haiku seat and five bots, then
   one Opus call; under $0.20). It never runs without `PERFIDIA_LIVE=1` and the key.
4. **Calibration** (about $12 for one day, $25 for two):
   `bun run arena -- run --days 1 --out runs/calibration-1 --watch`. Read `arena.json`: cost per
   seat and the 7-day projection, cache reads, thought coverage (enable `--thought-call on` if it is
   under ~90%), refusals and fallbacks, `INVALID_ARGS`/`NOT_FOUND` rejections, think time and the
   recommended real-time speed. Then fix the caps (`--cap-usd`, `--wake-cap-usd`).
5. **The first full match** (central estimate $83, at most 4 × $100 by the caps):
   `bun run arena -- run --out runs/match-1 --watch`. The seed is random (printed, and in the
   header); `--seed` replays a lineup on the same map. Lockstep takes about 10–15 hours of wall
   time. If the arena pauses (key, billing, model access, or a systematic error), fix the cause:
   it resumes by itself within 2 minutes; after 2 hours it aborts with exit code 2.
6. **After:** `bun run sim -- verify runs/match-1` (Level E; the arena already ran it),
   `bun run sim -- summary runs/match-1`, `bun run arena -- cost runs/match-1`. The exit criterion
   is in `arena.json` (`exit.met`, `exit.llm.met`).

Rehearse any command line for free first with `--fake` (and `--time virtual` for real time).
Without crash resume, a crashed lockstep match is rerun; build resume (design §9.3) before the first
multi-day real-time match.

## 10. Tests

No test touches the network. The default suite (`bun test`, run by `bun run check`):

- `model/*.test.ts`: the real SDK against a `fetch` stub replaying recorded JSON and SSE bodies
  (request bodies, every error status, a junk `ANTHROPIC_*` environment, exactly one fetch per
  error), the tools transform (pinned by sha256), prices, the rate gate, the fake.
- `seat/*.test.ts`, `budget/`, `log/`: the turn loop, retries, the pause gate and breaker, prompts
  (pinned by hash, with an injection property test), the ledger, the logs.
- `prefix.test.ts`: LLM seats in a real lockstep match; byte-stable prefixes through the real
  request builder; determinism; a hand-off.
- `arena/integration.test.ts`: a full 7-day lockstep match (4 fake LLM seats and 2 bots,
  `perfidia-1@1.1.0`) completes, replays at Level E, rebuilds the live gateway state, writes every
  file, and reports the exit criterion; two runs are identical; a hand-off mid-match; a model error
  closes only its turn and a 429 is retried; a billing pause resumes; a pause past `--pause-max`
  aborts with every turn of that second closed and exit code 2.
- `arena/realtime.test.ts`: real time under virtual time: deadline aborts charged and closed, a
  hand-off, Level E and the rebuild; an auth error aborts at once.
- `arena/plan.test.ts`, `report.test.ts`, `brain.test.ts`, `cli.test.ts`, `smoke.test.ts`.

`bun run test:exit` adds four more 7-day fake matches (lockstep seeds 2 and 3, the default brains,
real time) and prints the exit criterion of each; with fake brains it is reported, never asserted.
`bun run test:live` is the opt-in live test (§9).

## 11. Open items

- **Unverifiable without the network:** `max_tokens: 0` together with `fallbacks` in the preflight
  (if refused, use `max_tokens: 16`); the headers the API accepts after the guarded fetch's
  allowlist; the fallback-target prices (Opus 5, Opus 4.8, Sonnet 5) and Sonnet 5.5's cache-write
  prices; whether OTPM rate limits reserve `max_tokens`.
- **Not built:** crash resume (design §9.3), `arena redteam`, the spectator feed format (phase 3).
- **For the gateway owner:** the `interface` text lists `from, to, text, name` as the typed player
  fields, but player text also appears inside `read_notes` hit summaries; say so in a future
  `ENGINE_VERSION` (the shared prompt already does).
