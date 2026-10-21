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
12. Playtesting a seat: `arena playtest`

---

## 1. Decisions and deviations from the brief

| Topic           | As built                                                                                                                                                                                                                                     | Deviation                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK             | The official `@anthropic-ai/sdk`, pinned exactly at `0.131.0` through the root catalog, behind our own provider-agnostic `ModelAdapter`. Only `src/model/anthropic.ts` imports it (an oxlint override and the architecture test enforce it). | **The brief names the Vercel AI SDK.** It lags the provider features this harness needs: adaptive thinking with explicit `effort`, server-side `fallbacks`, per-block cache TTLs, refusal `stop_details`, `usage.iterations`, mid-conversation `system` messages. `ModelAdapter` already is the abstraction; other providers get their own adapters later (phase 4). The brief's stack row must be updated in its claude.ai document by the owner. |
| MCP             | Not exposed. LLM seats call the gateway tools through the provider's function calling, inside the orchestrator process.                                                                                                                      | **Deferred to the server phase** (`CLAUDE.md` said "MCP exposure comes in phase 2"). A harness that reaches the game through MCP later must not reach the spectator view: private messages and thoughts are live there.                                                                                                                                                                                                                            |
| Spectator feed  | `feed.txt`: the readable `--watch` text of the whole match, a fold of `match.jsonl`.                                                                                                                                                         | The design's `feed.jsonl` format, its schema and `arena feed` filters are phase 3's (the spectator view owns its formats).                                                                                                                                                                                                                                                                                                                         |
| Run-dir schemas | Zod schemas of `llm_calls.jsonl`, `seats.json` and `arena.json` live in `orchestrator/src/log/schema.ts`.                                                                                                                                    | Not in `protocol` yet: the formats will change after calibration. They move when the server and the web app read them.                                                                                                                                                                                                                                                                                                                             |
| Clock           | Lockstep first (the default). Real time works (tested under virtual time) but needs crash resume before a multi-day match.                                                                                                                   | –                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Calibration     | `--stop-after N` stops a full-length match at the end of game day N (status `stopped`).                                                                                                                                                      | The design calibrated with `--days 1`, which shortens the match the agents are told about (no domination, an endgame from the first wake): a different game.                                                                                                                                                                                                                                                                                       |
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
| `seat/`   | `agent.ts` (`LlmSeatAgent`), `prompt.ts` (`PROMPT_VERSION` 3), `personalities.ts`, `pause.ts` (pause gate, breaker), `retry.ts`, `thought.ts`                   | protocol, engine/core, model, budget, log                |
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
  last round trip, the reminder says its results will not be shown. When the wake has reached its
  soft cap (§5), the reminder says this reply is the wake's last, so the model can still end with
  `end_turn` and choose its next wake.
- Thinking blocks are echoed back unchanged; refused and truncated replies are never appended, so
  every request's prefix is byte-identical to the previous one and read from the cache.
- **Public thought:** the text of the turn's terminal reply only (no tool call, a reply carrying
  `end_turn`, or the last round trip); sanitised and cut at 400 characters. The optional
  out-of-band thought call (`--thought-call on`) asks for one when a terminal reply has none.
- The controller label is `llm:<provider>/<model>/<effort>:<profile>@<n>:p<PROMPT_VERSION>`, e.g.
  `llm:anthropic/claude-opus-5-5/medium:odysseus@1:p3`: `match.jsonl` alone says what played.
  (`PROMPT_VERSION` 2 added the wake-end reminder; 3, the notes, times and presentation of §3.5.)

### 3.2 The prompt and the cache

`tools` (the gateway's 22 `perfidia-1` tools, transformed: no `$schema`, no safe-integer maxima;
`strict` off) → `system[0]`, shared by every seat of one model and effort (harness text, the
gateway's interface text, READING THE INTERFACE, the ruleset's cheat sheet and compiled tables,
TIMES; §3.5) → `system[1]`, the seat's private profile → the messages. Both system blocks carry `cache_control`, and the request adds the
automatic breakpoint on the growing tail (3 breakpoints in all). Nothing volatile is in a system
block. The preflight writes the shared prefix once, so the seats woken together at t = 0 read it.
A reply with more than about 20 positions (progress-note thinking blocks between tool calls break
the runs of `tool_use` blocks) can push the automatic breakpoint past the previous cache entry; the
turn's messages are then written again (the system blocks still hit). The per-call `cacheMiss`
flag shows it; the free 4th breakpoint is the mitigation if calibration does (§11).

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

### 3.5 Prompt version 3: what the playtests changed

Three `arena playtest` sessions (§12: an opening, a diplomacy turn, a war turn with a betrayal
nearby; 61 turns, 318 calls) found the interface hard to read in a few places that a real match
would pay for in wasted round trips and wrong decisions. `PROMPT_VERSION` 3 fixes what the harness
and the gateway's presentation can fix without changing a published ruleset, the engine, a golden
or what bots read. No real match had run, so no measured run or calibration profile is lost.

- **READING THE INTERFACE** (`seat/prompt.ts`, after the gateway's INTERFACE block; ruleset-agnostic,
  its numbers from `rules.gateway` and `rules.movement`): the roles of the TRIGGERS line (party,
  self, target, stationed, ally, public); a non-urgent wake starts `groupWindow` after its first
  trigger, an urgent one at once; budgets and daily caps reset at 00:00 of each game day; every
  queue of every city fires its own `queue_empty`, each an own wake out of `ownWakesPerDay`, so
  queues ending within `groupWindow` share one; `lastTurn.nextWake` counts only triggers that
  already happened; which events never wake; the briefing's presentation 2 (below); `cost[L]` is the
  price of level L (`cost[0]` never charged) and the other level tables; the travel times' probe
  order; the shipment cap. The interface text itself is unchanged: bots call the `rules` tool, whose
  `obs` size the goldens record.
- **TIMES** (after TABLES): the compiled build times (each level at build-speed level 1, the cheat
  sheet's `baseTime` at level 1) and recruit times (per unit, by queue building level), which the
  `rules` tool leaves out (`agentRules`, unchanged for the same reason). `arena/prompt-info.ts`'s
  `promptInfo(match)` is the shared block's input (`rulesInfo` plus `promptTimes`).
- **Tool descriptions** (the gateway's, which only model seats read, so they are versioned with
  `PROMPT_VERSION` and pinned by the tools hash): `view_player` (the leaderboard already lists
  relations; `today.day` counts from 0), `attack` and `support` (the result's `party`),
  `propose_alliance` (cannot be withdrawn; a refused acceptance leaves it open; a pact proposed to a
  partner renews it, not counting against `maxPacts`), `answer_proposal` (the answerer of a
  `proposal_answered` is its `to`), `read_notes` (`limit`; the notebook only without arguments).
- **Presentation 2** (`SeatAgent.presentation`, declared by `LlmSeatAgent`; bots keep presentation
  1, so goldens, fingerprints and every bot's view are unchanged; the host passes it to
  `buildBriefing` and to the read tools): a briefing target of 6,000 characters instead of 2,400
  (excluding the notebook); the events the wake's reasons name never give way, and routine events
  (`build_done`, `recruit_done`, `queue_empty`) give way before the others; each city lists `lvl`
  (its building levels above 0); a `found` movement in `moves` lists `isl`; each `more` search
  carries a `limit` that lists exactly the entries left out (an old briefing's entries of the same
  second no longer pad it); `read_notes` search and open results leave the notebook out. On the
  two 7-day `--fake` material runs, regenerated: briefings with a cut list fell from 66% and 69% of
  LLM wakes to 12% and 11%, events left out from 1,753 and 1,798 to 261 and 208; the briefing's
  median grew from about 2,850 to 3,800 characters; the fake runs cost +1.8% and −0.4%.
- **Cost figures:** the shared block grew by 3,682 bytes and the tools by about 900 (≈ 1,150 tokens
  at four bytes a token, a stable prefix of about 8,900 tokens; the Sonnet 5.5 request of round 0
  at turn 3 went from 36,695 to 41,099 bytes with its larger briefing), so the
  smoke bound and the estimate's probe and preflight grew ($0.17 → $0.20 each for Sonnet 5.5 in
  `claude-duo`'s reserve). The a-priori estimate's assumptions (`PREFIX_TOKENS` 9,500,
  `BRIEFING_TOKENS` 1,500) and every budget, cap and kill path are unchanged.

Not fixed, with the reason (each needs a ruleset version, an engine change or a change bots would
see): `queue_empty` grouped per seat or mutable from `end_turn` (a wake rule: a new `GatewayRules`
field in a new ruleset version); withdrawing a proposal and voiding moot ones (an engine action);
a `by` field on `proposal_answered` and a labelled `points` in battle reports (event data,
fingerprinted); the siege's 1.41:1 settler rule against a relief and the re-homing of a garrison on
conquest (cheat-sheet text of the published `perfidia-1@1.1.0`; for the next version);
`ext.holding`'s besieger and role (the ruleset's briefing hook); `details.availableAt` as a time
pair (logged in `gw` lines; the hint already words it); `view_map` travel rows labelled or sorted
(bots parse them); a per-city shipment cap in the briefing and `wake.since` (left to the notes
above); the notebook a playtest inherits from a `--fake` run's brain (playtest material only:
documented in the material's `POINTS.md`).

## 4. The Anthropic adapter (`model/anthropic.ts`)

- **Client:** one per process. Explicit `apiKey` (`PERFIDIA_ANTHROPIC_API_KEY`) and `baseURL`
  (`PERFIDIA_ANTHROPIC_BASE_URL` or `https://api.anthropic.com`; never the container's
  `ANTHROPIC_BASE_URL`; `http://` only on localhost, 127.0.0.1 or [::1], so the key never crosses
  a network in cleartext); `authToken`, `webhookKey` and `logLevel` explicit. A guarded `fetch`
  only talks to the configured origin, always sends our `x-api-key`, never `authorization`, and
  passes only the SDK's own headers. `ANTHROPIC_CUSTOM_HEADERS`, which the SDK reads itself, is
  neutralised: its other headers are dropped, `anthropic-version` is pinned to `2023-06-01`, and
  `anthropic-beta` carries only the request's own betas. `maxRetries: 0`: the harness owns every
  retry.
- **Request:** always streamed (`.stream().finalMessage()`); `thinking: {type: "adaptive",
  display: "summarized"}` (never disabled, never a budget); `output_config.effort` always set; no
  `tool_choice` (forced use is a 400 on the 5.5 models), no sampling parameters, no prefill;
  `max_tokens` 16 000; after a `max_tokens` stop, one retry at twice the limit (at least 32 000, at
  most the models' 128 000; none when the limit already is 128 000). Opus 5.5 and Sonnet 5.5 get
  `fallbacks: "default"` under the beta `server-side-fallback-2026-07-01`; Haiku 5.5 has no
  server-side fallback.
- **Response:** `stop_reason` is checked before any content is read. A refusal keeps its
  `stop_details` (category, explanation, recommended model) and closes the turn. Before the last
  `fallback` block only text is echoed back. Usage is split per `usage.iterations` entry and priced
  per model; a fallback-served attempt is flagged, logged on stderr and counted in `arena.json`.
  Cache writes reported without their TTL split are priced at the request's TTL (1 h in real time).
- **Errors:** the SDK's typed classes, most specific first: abort, connection timeout, connection,
  429, 5xx/529, 401/403, 404, 400/422, 402 (billing), 413. A body that breaks mid-stream (a reset,
  `TypeError: terminated`, an end without `message_stop`) is a retryable `connection` error, out of
  the breaker. A broken or aborted stream is charged from `chat`'s own copy of the latest snapshot
  (the SDK clears its own when a body ends early), flagged `estimated`: the final usage when
  `message_delta` arrived; otherwise the `message_start` input and cache usage plus the largest of
  the output streamed (summarized thinking undercounts it), 4 000 tokens, and 400 tokens per second
  streamed (an upper bound of any priced model's speed), capped at the request's `max_tokens`.
  Nothing is charged when the stream never started.
- **Preflight** (before the run directory exists, and as the pause gate's probe): `models.retrieve`
  with the `server-side-fallback-2026-06-01` beta (so `allowed_fallback_models` is visible; each must
  have a price), then the round-0 request shape non-streamed at `max_tokens: 0`: the tools, both
  system blocks, a placeholder user message and the turn-header template as an operator entry (a
  mid-conversation `system` message). It cannot replay a later round: an assistant reply carries
  signed thinking blocks.
- **`countTokens`:** `count_tokens` on a request (used by `arena smoke`).

## 5. Budget, caps and hand-offs

Prices are integers in mUSD per million tokens, so a token costs that many nano-dollars and every
cost is an exact integer (`model/prices.ts`; an unpriced served model is charged at the highest
rates and flagged). The ledger charges every attempt, failed and estimated ones included. A USD
flag takes at most $1 000 000. Seats run on the 5.5 family only (`opus-5-5`, `sonnet-5-5`,
`haiku-5-5`): the other priced models are fallback targets (Claude Sonnet 5 rejects the operator
entries with a 400).

| Cap                                        | Default       | Flag                             | Effect                                                                                                                                                                     |
| ------------------------------------------ | ------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per LLM seat                               | $100          | `--cap-usd`, `--seat-cap pN=usd` | The charge that crosses it queues the hand-off: the seat's next turn opens with a `controller` line, and its profile's bot (`--handoff-bot` overrides) plays from then on. |
| Per wake (soft)                            | $2            | `--wake-cap-usd usd\|off`        | Checked before every attempt (retries and the thought call included): the first attempt that finds it reached is the wake's last (a `wake_cap` line), then the turn ends.  |
| Output per call                            | 16 000 tokens | `--max-tokens`                   | One retry at twice the limit (32 000 to 128 000).                                                                                                                          |
| Round trips per wake, calls per round trip | 8, 10         | the ruleset's                    | Enforced by the gateway.                                                                                                                                                   |

A turn cut by a cap or closed by an error keeps no self-wake unless one was already pending (its
`end_turn` never ran): the seat sleeps until an event wakes it or the 12-hour safety wake, and an
over-cap seat's hand-off bot takes over at that wake. The wake-end reminder lets a capped wake end
with `end_turn` itself.

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
  model, or 3 consecutive LLM turns closed by a systemic error, trip it. A refusal, `max_tokens`
  twice or a deadline abort is about one request: it neither counts nor resets. `auth`, `billing`
  and `not_found` close the pause gate at once.
- **Pause gate, lockstep:** a trip or an operator error closes the gate. The next LLM round waits
  there: game time stands still from then on (the bots play until that round; nothing is lost).
  `arena.json` says `paused` and why; the preflight is re-run every 2 minutes and the gate reopens
  when it passes (a `pause` line with `outcome: "resumed"`). After `--pause-max` (2 h) of pause in
  total the arena aborts. The preflight cannot replay the request that tripped the breaker, so a
  breaker that trips again before any LLM turn closed cleanly since its resume aborts the arena:
  the cause persists, and LLM seats that all fail never play on to a silent "ended".
- **Pause gate, real time:** game time cannot stop, so an operator error aborts at once. A breaker
  trip is an alert (stderr, `arena.json`): the failing LLM turns close on their own. A second trip
  before any LLM turn closed cleanly since that alert aborts the arena.
- **Pause probes** re-run the preflight, so each passing probe is billed (a `max_tokens: 0` request,
  mostly cache reads); `totals.preflightNanoUsd` counts the preflight and every passing probe.
- **Refusals** are logged with the ids of the turn's inbox messages (`inbox` in the `llm_call`
  line), and two consecutive refused turns of a seat are an alert naming them: a player's message
  may be what trips the classifier (refusal-DoS, design §3.8).
- **Degraded:** a run that ends (or stops) with at least 25% of its LLM turns (and 8 or more) closed
  by an error is `degraded`, with an alert and exit code 2: its result does not show what the
  models would play.
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
  10 s shorter. A duration flag, and the derived round timeout, stay under 2^31 − 1 ms (596 h): a
  longer runtime timer fires at once. The thought call has the same attempt timeout as a round's
  attempt.

## 7. The run directory and `arena.json`

| File                                        | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match.jsonl`, `snapshots/`, `summary.json` | As `sim run` writes them, except that `match.jsonl` is flushed after every line (phase 3: the spectator server tails it). `match.jsonl` is authoritative: actions, events (messages, proposals, alliances, betrayals), `turn` lines with public thoughts, `controller` lines for hand-offs.                                                                                                                                                                                                                                                                                                                                                         |
| `llm_calls.jsonl`                           | One validated line per API attempt (cost, cache, latency, stop, refusal, fallback, error), plus `handoff`, `pause` and `wake_cap` lines. Appended synchronously.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `replies.jsonl`                             | (Phase 3.) One validated line per model reply that arrived and that the conversation keeps (`end_turn` or `tool_use`), right after the `llm_call` line of its attempt: the reasoning summaries (up to 20,000 characters, cut with "…"), the text (up to 4,000) and the tool calls, provider-agnostic, for the spectators. Refused and truncated replies get none; `--transcripts off` does not affect it. The bot-backed fake writes one deterministic "Fake reasoning: …" summary per reply.                                                                                                                                                       |
| `transcripts/<seat>/t<turn>.jsonl`          | Every request (the new entries only; the stable prefix by sha256) and every raw response, reasoning summaries included (`--transcripts off` disables them).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `prompts/`                                  | The exact texts: `shared.txt`, `p1.txt` …, `operator.json`, `tools.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `seats.json`                                | Per seat: kind, label, model, effort, cap, profile, hand-off bot, prompt hashes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `feed.txt`                                  | The `--watch` text of the whole match: thoughts (up to 400 characters), messages and proposals (whole; the live `--watch` cuts them at 120), diplomacy, battles, conquests, hand-offs. After a hand-off the seat shows as `p2 [bot:conqueror@3]`, not the profile's name.                                                                                                                                                                                                                                                                                                                                                                           |
| `arena.json`                                | The report: status (`running`, `paused`, `ended`, `stopped`, `degraded`, `fatal`, `aborted`, `incomplete`) and why; per LLM seat the cost by token kind, attempts, stops, errors, refusals by category, fallbacks and served-by shares, cache misses, wake caps, thought coverage by end reason, think time p50/p95, rejections, the hand-off, its estimate and projection; totals (cache reads as a share of prompt tokens, fallback share, preflight cost); the a-priori estimate and the projection of the measured spend; the recommended real-time speed; pauses, alerts and the daily rows; LLM → bot war calls; Level E; the exit criterion. |

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
| Sonnet 5.5, lockstep                     | –      | $41.65          | –       |
| Haiku 5.5, lockstep                      | –      | $2.19           | –       |
| One calibration day, Opus 5.5            | –      | $11.90          | –       |

Phase 4 corrected Sonnet 5.5's cache-read price to the pricing page's $0.10 per MTok (it was $0.20
here, giving $43.80); see `docs/phase4.md` §12.

Output, thinking included, is about two thirds of the Opus bill: effort is the lever. The bots of
the arena lineup wake 16.2 times per seat per day on `perfidia-1@1.1.0` (seeds 1–4), slightly above
the 15.5 assumed. A seat under constant attack can be woken far more often (urgent wakes are not
budget-bounded); the per-seat cap and the daily tripwire bound it.

### 8.2 What a fake run reports

`--fake` replays bots through the whole LLM pipe with a cache-shaped token count derived from byte
lengths: its dollar figures exercise the accounting, they are not a forecast. A 7-day fake match
(seed 1, `--id-key seed`) costs "$30.87" in fake tokens with the default fake brains (each
profile's hand-off bot) and "$26.97" with the tests' brains (`--brain p1=opportunist@3 --brain
p2=conqueror@3 --brain p3=expander@2 --brain p4=turtle@3`); the real forecast is §8.1.

### 8.3 The projection of a measured run (design §5.5)

A short run is biased low: day 1 has 13% fewer wakes than the mean, and no war yet. `arena.json`
projects each seat's measured spend to a full week (at least 7 days) by the bots' per-day wake
profile (`BOT_DAY_PROFILE`: 337, 313, 368, 400, 434, 444, 420 wakes over the six seats and four
seeds), then adds 15%. One measured day projects to ×9.27. The measured days are fractional: a run
shorter than a day counts its share of day 1 (a one-hour run projects to 24 × 9.27), and its
estimate and `days` are fractions of a day too. A `--stop-after 1` run of the full match measures
day 1 of the real game: on the fake models (seed 1) it projects $27.78 against the $30.87 the
whole week costs.

## 9. Running the first real match

Exit codes: 0 ok, 1 Level E divergence, 2 fatal or aborted, 3 usage, config or preflight error
(nothing written).

1. **Key and backstop.** Export `PERFIDIA_ANTHROPIC_API_KEY` (and `PERFIDIA_ANTHROPIC_BASE_URL`
   only for a proxy). Nothing else from the environment is read. Set a Console spend limit on the
   key's workspace (e.g. $500). The cloud container's egress proxy may block `api.anthropic.com`:
   run on the owner's machine.
2. **Smoke** (at most $0.0054 on Haiku 5.5 and $0.22 on Opus 5.5, printed before anything is
   sent: the call's output is capped at 4 000 tokens): `bun run arena -- smoke` (Haiku 5.5 at
   `low`), then `bun run arena -- smoke --model opus-5-5 --effort low`. Each runs the preflight (key, model,
   allowed fallbacks and their prices, the exact request shape, the pre-warm), `count_tokens` on
   the prefix and a real briefing, and one streamed call; it prints the stop reason, the served
   model, usage and cost, and warns if the call read nothing from the cache. Things only this can
   verify: `max_tokens: 0` with `fallbacks` in the preflight, the headers the guarded fetch lets
   through, and the fallback models' prices (check them against the pricing page too).
3. **Optional live test:** `bun run test:live` (one game hour, one Haiku seat and five bots, then
   one Opus call; under $0.20). It never runs without `PERFIDIA_LIVE=1` and the key.
4. **Calibration** (about $12 for one day, $25 for two):
   `bun run arena -- run --stop-after 1 --out runs/calibration-1 --watch`. The agents play the
   7-day match they are told about; the run stops at the end of day 1 (status `stopped`, exit 0,
   Level E checked up to the cut; `sim verify` reports only the missing end line). Do not calibrate
   with `--days 1`: that is a one-day match (no domination, an endgame from the first wake). Read
   `arena.json`: cost per seat and the 7-day projection, cache reads and cache misses, thought
   coverage (enable `--thought-call on` if it is under ~90%), refusals and fallbacks,
   `INVALID_ARGS`/`NOT_FOUND` rejections, think time and the recommended real-time speed. Then fix
   the caps (`--cap-usd`, `--wake-cap-usd`).
5. **The first full match** (central estimate $83, at most 4 × $100 by the caps):
   `bun run arena -- run --out runs/match-1 --watch`. The seed is random (printed, and in the
   header); `--seed` replays a lineup on the same map. Lockstep takes about 10–15 hours of wall
   time. If the arena pauses on a key, billing or model-access error, fix the cause: the probe
   resumes it within 2 minutes; after 2 hours of pause in total it aborts with exit code 2. A
   breaker pause (a systematic error) resumes on a passing preflight whether or not its cause is
   gone; if it trips again before an LLM turn closes cleanly, the arena aborts (exit 2): read the
   errors in `llm_calls.jsonl` and the transcripts, fix, rerun. A `degraded` run (exit 2) ended with
   too many LLM turns closed by an error.
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
- `arena/integration.test.ts`: a full 2-day lockstep match (4 fake LLM seats and 2 bots,
  `perfidia-1@1.1.0`) completes, replays at Level E, rebuilds the live gateway state, writes every
  file, and reports the exit criterion; `--stop-after 1` of a 7-day match; a one-hour match's
  fractional days; two runs are identical; a hand-off mid-match; a model error closes only its turn
  and a 429 is retried; a billing pause resumes (the probe's spend counted); a pause past
  `--pause-max` aborts with every turn of that second closed and exit code 2; a breaker the
  preflight cannot reproduce aborts on its second trip; two refused turns raise the refusal alert;
  a run whose LLM turns mostly fail is `degraded`.
- `arena/realtime.test.ts`: real time under virtual time: deadline aborts charged (by the time
  they ran, up to `max_tokens`) and closed, a hand-off, Level E and the rebuild; a slow spell past
  the deadline closes only its turns (no breaker, no abort); an auth error aborts at once.
- `arena/plan.test.ts`, `report.test.ts`, `brain.test.ts`, `cli.test.ts`, `smoke.test.ts`.

Since the suite split of architecture §13, the slow suite (`bun run test:slow`, run by
`bun run test:exit`) holds these instead of the default suite: in `arena/integration.test.ts`,
`--stop-after 1`, the two identical runs, the hand-off, the billing pause, `replies.jsonl` and the
refused-turns alert; in `arena/realtime.test.ts`, the slow spell.

`bun run test:exit` runs four 7-day fake matches to their end (lockstep seeds 2 and 3, the default
brains, real time) and prints the exit criterion of each; with fake brains it is reported, never
asserted.
`bun run test:live` is the opt-in live test (§9).

## 11. Open items

- **Unverifiable without the network:** `max_tokens: 0` together with `fallbacks` in the preflight
  (if refused, use `max_tokens: 16`); the headers the API accepts after the guarded fetch's
  allowlist; the fallback-target prices (Opus 5, Opus 4.8, Sonnet 5) and Sonnet 5.5's cache-write
  prices; whether OTPM rate limits reserve `max_tokens`.
- **Not built:** crash resume (design §9.3), `arena redteam`, the spectator feed format (phase 3).
- **Left to calibration:**
  - the 4th cache breakpoint (design §4.1: the mitigation of the 20-position lookback, if
    `cacheMiss` shows it);
  - the reminder cadence on Sonnet 5.5, which may read harness text after every tool result as
    injection (send only the last-round reminder there if its thought coverage or rejections lag);
  - a preflight shaped like round 1, which needs a real signed thinking block (the second-trip abort
    covers breakers the preflight cannot see).
- **Real time and `--stop-after`:** a model call in flight at the cut is not aborted; it finishes
  after the report and its `llm_calls.jsonl` line lands after it (the same holds for an abort).
- **For the gateway owner:** the `interface` text lists `from, to, text, name` as the typed player
  fields, but player text also appears inside `read_notes` hit summaries; say so in a future
  `ENGINE_VERSION` (the shared prompt already does).

## 12. Playtesting a seat: `arena playtest`

A dev tool, added after phase 4 (`src/arena/playtest/`): an outside player, a person or an agent
driving the command line, plays one LLM seat of a run turn by turn through the real harness, with
no model API and at no cost. It shows exactly what the seat's model receives, and answers each
reply the way a model's tool calls are answered, before a real match spends money.

```sh
bun run arena -- playtest start --from <run-dir> --seat p2 --at 14 --out <session>  # or --at "D3 08:00", t:93600
bun run arena -- playtest reply --session <session> --calls reply.json [--text "..."] [--end]
bun run arena -- playtest next --session <session>    # the bots play on to the seat's next wake
bun run arena -- playtest status --session <session>  # re-derive, rewrite the material
```

`reply.json` is an array of `{"name": "<tool>", "args": {...}}` (or `{"text": "...", "calls":
[...]}`). A reply with no call, or with `end_turn` among its calls, ends the turn, and its text is
the public thought; `--end` checks that it does (it needs text).

- **The fork.** The run's `match.jsonl` is replayed on a fresh engine (every event, checkpoint and
  act result checked against the log, as at Level E) and folded into a live `MatchHost`'s gateway
  state with the rebuild fold (`createGatewayFold`); the gateway's lockstep driver then plays on
  from the cut. The cut is the start of the turn's game second when the seat woke in that second's
  first batch, so every seat due then wakes as it did in the run; otherwise (a wake in a later
  batch, or a second turn in the same second) it is the turn's own wake line, and the turns other
  seats still had open there are closed as empty rounds. The seat's first wake in the fork must be
  byte-identical to the run's. The run directory is only read, and its `seats.json` hashes (shared
  block, seat block, tools, operator templates) must be this build's, or the session is refused:
  material made under an earlier `PROMPT_VERSION` must be made again (`arena run --fake`).
  Lockstep runs only.
- **The seat** is its own `LlmSeatAgent` (prompt cap, reminders, terminal rules, the thought from
  the terminal reply's text) on a `PlaytestAdapter`. Requests are built by the seat's provider's
  builder: the Anthropic adapter's own `build()` (an offline client that is never called) for an
  Anthropic seat; for another provider, the fake adapter's neutral layout, which mirrors its
  operator channel (same texts, not that provider's wire layout). The playtester's replies become
  Anthropic content: text blocks, then `tool_use` blocks with ids `pt-<seat>-<turn>-<round>-<i>`.
  They carry no thinking blocks, which a real model's replies would. Usage is estimated at four
  bytes a token so that the prompt cap works; nothing is billed. The thought call is off.
- **The other seats** are bots: a bot seat's own, an LLM seat's hand-off bot (a `--fake` run's
  default brain), or `--brain pN=strategy@n`. They are fresh instances: their memory is in their
  notebooks, but their per-match caches are read again (an extra `rules` call), so they do not
  replay the run move for move.
- **Calls** run through the real host: the turn gate, the round and wake call caps (`CALLS_CAP`),
  argument validation and the explanatory errors (`code`, `message`, `hint`), the round-trip cap.
  The results of a turn's last round trip are never shown to the model; `end.md` shows them to the
  playtester, with the gateway's record of the turn that the next briefing's `lastTurn` reports.
  The command line refuses what a model could not send: a tool the seat does not have, arguments
  that are not a JSON object.
- **The session directory**: `session.json` (the run and its hashes, the seat, the target turn and
  cut, the bots), `steps.jsonl` (each reply and each `next`, with the turn, the round and the
  sha256 of the request it answered), and the material: `prompt.md` (both system blocks),
  `tools.json` (the request's tools), `turn-NNN/round-R.md` (what round trip R+1 adds: the
  briefing and the turn header, or the echoed reply, the tool results after a one-line summary of
  each, and the reminder), `turn-NNN/request-R.json` (the builder's whole request,
  `JSON.stringify(build(req))`; the SDK adds `stream: true` when it sends), `turn-NNN/end.md`,
  `fork.jsonl` (the fork's own log since the cut) and `STATUS.md`. Texts are quoted byte for byte
  inside fences longer than any backtick run they hold.
- **Stateless and deterministic.** Each command re-derives the whole session from the run's log
  and the steps: the bots, the batch orders and the harness clock (virtual time, never advanced)
  are deterministic. A new step is kept only when the derivation consumed it (a reply after a
  turn's end asks for `next`; `next` while a reply is awaited is refused); a derivation that meets
  another request than a step recorded (another build, a changed run) stops with an error instead
  of drifting. A command costs one replay of the log up to the cut plus the turns played since:
  on a 7-day run, about 1 s for a cut on day 1 and 2.5 s for one on day 6.

Measured on two 7-day `--fake` runs (`--lineup claude-duo --seed 7` and the default lineup with
`--seed 18`, both `--id-key seed`): in every 13th LLM wake (33 and 38 turns) and in every turn cut
mid-second (16 and 39, 52 of which closed other seats' open turns), the fork's round-0 request held
the run's own briefing and turn header, entry for entry; each derivation took 0.8 to 1 s. Tests: `arena/playtest/playtest.test.ts` (byte equality with the Anthropic adapter's
request rebuilt from the run's transcript and prompt files; a scripted session with results, an
`--end` and a `next`; the gateway's explanatory errors and the call cap; drift refused; the run
directory unchanged).
