# Phase 3: the spectator view (Pass A as built)

> **Status.** Roadmap step 3 of `docs/brief.md`, "Spectator view": a live map, a diplomatic feed
> and a leaderboard. Exit criterion: an outsider understands the match within a few minutes.
>
> - **Pass A (data and server, no UI) is built**, in two steps: the pure data layer (the engine's
>   incremental replayer, the gateway's incremental fold, the `@perfidia/spectator` projection,
>   the protocol's spectator schemas, `replies.jsonl` and per-line flushing) and the read-only
>   server (`@perfidia/server`). Pass B (the web app) and Pass C (extras) are not built yet (§12).
> - This document describes what was built. The reviewed phase-3 design (with its `[critic]`
>   corrections) is the source of the decisions; "design §x" below and in code comments refers to
>   it. Where this document and the code disagree, the code wins; fix this document.
> - Everything is local: nothing is hosted, no secret is read or served.

**Contents:**

1. What Pass A delivers
2. Packages and data flow
3. Running the server
4. Reading matches: discovery, publication, status, tailing
5. Folding: workers, timelines, the cache
6. The REST API
7. The WebSocket
8. What is public, and what never is
9. Limits and hardening
10. Tests and measurements
11. Dependencies and the supply chain
12. Deviations, open issues, and what Pass B adds

---

## 1. What Pass A delivers

The design's "done when" (§1.2), as measured on this container (4 vCPU, Bun 1.4.3):

| Criterion                                                                                                                 | Result                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The war golden served through the API reduces to final standings equal to its `end` line                                  | `war.test.ts`: meta, keyframe 0 and every steps page, reduced with `@perfidia/spectator/reduce`, give the end line's standings and result, 31 islands and 42 cities, the same steps as a direct fold, and every keyframe equal to the reduction up to its cursor. Folded and served in about 4.7 s; after a restart, read from the cache in about 60–100 ms. |
| A WebSocket client following a fake arena match while it is written ends with the same frame as a fold of the whole file  | `live.test.ts`: `bun run arena -- run --fake --days 2` writes into the runs root while a client follows from keyframe 0; it ends with the whole-file fold's frame, with contiguous `{from, to}` ranges and no gap (about 850 live `steps` messages for 2,937 lines).                                                                                         |
| A client resumed after a server restart (served from the cache) ends with that frame, with no duplicate or missing cursor | `live.test.ts`: a log written in 40 chunks cut anywhere (partial lines included); clients from the start, after a disconnect, and after a restart from the cache all end with the whole-file frame and contiguous ranges.                                                                                                                                    |
| `bun run check` is green; goldens unchanged; the engine stays pure                                                        | See the commit report. Fixtures are append-only (no file under `packages/sim/fixtures` changed). The replayer and the projection are browser-pure (lint overrides and the architecture tests).                                                                                                                                                               |

## 2. Packages and data flow

```
protocol ← engine ← gateway ← bots ← sim ← orchestrator          (unchanged)
                     gateway ← spectator ← server                 (new: server = protocol, engine, spectator)
protocol/spectator ← spectator/reduce ← (web, Pass B)
orchestrator ┄┄ dev dependency ┄┄ spectator, server               (tests generate fake arena runs)
```

- **`@perfidia/spectator`** (pure, browser-runnable). `.`: the fold of `match.jsonl` into
  frames, steps (patches and feed items), moments and keyframes, through the engine's push replay
  (`createReplay`) and the gateway's incremental fold (`createGatewayFold`). `./annotations`: the
  separate, mutable fold of `llm_calls.jsonl` and `replies.jsonl`. `./reduce`: steps applied to
  frames and game time for display; it imports `@perfidia/protocol/spectator` only (2 KB
  minified). Ruleset event names live in `src/fold/rulesets.ts` only.
- **`@perfidia/server`** (Bun). The only place that does I/O for spectators:
  - `src/config.ts`: flags, and the only environment reads (`PORT`, `PERFIDIA_SERVE_TRUST_PROXY`);
  - `src/store/`: discovery, side files, the line tail, statuses, `publish.json`;
  - `src/fold/`: the worker threads, the only code that runs the fold;
  - `src/timeline/`: the in-memory timeline, the gzipped cache, the LRU;
  - `src/service/`: the framework-free service (REST functions, the registry of matches, the live
    hub of the WebSocket);
  - `src/http/`: the route table (Zod schemas), the OpenAPI document, the two adapters (Elysia 2,
    and the raw `Bun.serve` fallback), the gate (methods, rate limit, origin), headers, gzip.

```
run dir ──tail (complete lines)──► worker: createReplay + gateway fold + projection
   │                                          │ batches (steps, keyframes, moments, reports, notes)
   │                                          ▼
   │                              Timeline (memory) ⇄ cache dir (gzip, keyed by log id + versions)
   ├─ llm_calls.jsonl, replies.jsonl ──► annotations fold (main thread, mutable)
   └─ seats.json, arena.json, summary.json ──► seats, fake flag, status
                                              ▼
                       service ──REST──► clients;  live hub ──WS steps {from, to}──► clients
```

Steps depend on `match.jsonl` only, so a live fold, a refold after a restart and a fold of the
finished file give the same steps; costs, reasoning and replies are annotations, never steps.

## 3. Running the server

```sh
bun run serve -- --runs runs --cache .cache/spectator
# then: http://127.0.0.1:8080/api/matches, /api/openapi/json, ws://127.0.0.1:8080/api/live
```

| Flag                           | Meaning                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--runs <dir>`                 | Root whose subdirectories are run directories (`sim run --out`, `arena run --out`). Required.                                                |
| `--cache <dir>`                | The server's own timeline cache. Without it, every restart refolds every match.                                                              |
| `--publish <file>`             | `publish.json`: the public matches (§4). Without it every discovered run is listed (development). Required to bind a non-loopback host.      |
| `--host`, `--port`             | Default `127.0.0.1` and `$PORT`, else 8080.                                                                                                  |
| `--origin <url>`               | Another browser origin allowed to open the WebSocket (repeatable).                                                                           |
| `--no-costs`, `--no-reasoning` | Leave costs, tokens and spend, or reasoning summaries and reply text, out of the annotations (design §9 Q2, Q4; both are served by default). |
| `--adapter raw`                | Serve with the raw `Bun.serve` adapter instead of Elysia.                                                                                    |
| `--dev`                        | Serve the OpenAPI UI page (`/api/openapi`).                                                                                                  |

Environment: `PORT`, and `PERFIDIA_SERVE_TRUST_PROXY=fly` (read the client IP from
`Fly-Client-IP`, send HSTS). Nothing else is read; the server holds no API key. `SIGHUP` re-reads
`publish.json`; `SIGINT`/`SIGTERM` stop it (running matches' timelines are written to the cache
first). Exit code 3 on a configuration error.

Examples:

```sh
# The war golden, as a finished match.
mkdir -p /tmp/runs/war && cp packages/sim/fixtures/golden/perfidia-1@1.1.0/lockstep-6p-6d-war.jsonl.gz /tmp/runs/war/match.jsonl.gz
bun run serve -- --runs /tmp/runs --cache /tmp/spectator-cache
# A fake arena match, followed live while it is written (arena flushes match.jsonl per line).
bun run arena -- run --fake --days 2 --out /tmp/runs/fake2
# A bot match at real-time speed (a game day in 2.4 wall minutes), flushed per line.
bun run sim -- run --clock realtime --time system --speed 600 --days 1 --live-flush --out /tmp/runs/bots
```

`publish.json`:

```json
{
  "format": "perfidia-publish/1",
  "matches": [
    { "id": "war", "title": "Six bots at war", "featured": true },
    {
      "id": "fake2",
      "title": "Fake models",
      "description": "Bots behind the LLM pipe",
      "visibility": "after_end"
    }
  ]
}
```

## 4. Reading matches: discovery, publication, status, tailing

- **Discovery.** The subdirectories of `--runs` that hold a regular `match.jsonl` or
  `match.jsonl.gz`, named by a valid match id (`^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$`). Symbolic
  links are never followed. The root is rescanned every 10 s and on `fs.watch` events; a vanished
  directory is dropped. Ids are index keys, never paths built from requests.
- **Publication.** Without `--publish`, every run is listed (local development). With it, only
  the listed ids exist for clients; each has a title, a description, `featured`, and a
  `visibility`: `live` (default) or `after_end` (absent from every route until the log has an end
  line, computed from the log, so it survives restarts). The file is re-read on change, every 2 s
  and on `SIGHUP`: removing an id unpublishes the match from every route at once, and its sockets
  get `status: unpublished`. A file that fails to parse at startup stops the server; later, it
  publishes nothing until fixed (fail closed). An unverifiable run is never public when a file is
  given (it is listed, as `unverifiable`, in development).
- **Status**, in order of precedence (`store/status.ts`): `loading` (the first fold has not
  reached the tail), `unverifiable` (Level E diverged, a line failed its schema, or the ruleset is
  unknown), `ended` (end line; `degraded` when `arena.json` says so), then `fatal` (a `fatal`
  line), `stopped`, `degraded`, `aborted`, `fatal`, `incomplete` (from `arena.json` or
  `summary.json`), `paused`, `stalled` (no new line for 1.5 × 3600 / speed wall seconds, at least
  10 minutes, in real time; 3 h 30 in lockstep; measured from the log's modification time, so it
  survives restarts), else `live`. Reasons are a fixed vocabulary (`domination`, `time`,
  `last_standing`, `stopped_after_day`, `aborted`, `engine_error`, `model_errors`,
  `operator_pause`, `unverifiable`), never operator text.
- **Tailing** (`store/tail.ts`). A byte offset per file; complete lines only, the partial
  remainder kept (lines are cut on the byte 0x0A, so UTF-8 can be cut anywhere). A changed inode,
  a smaller size or a different first line means the log was replaced: the match starts over
  under a new timeline and its clients get `resync {log_replaced}`. A finished log is no longer
  tailed, but its file is checked every few seconds, so a run deleted and rerun under the same
  name is noticed. Polled every 250 ms and on `fs.watch` events. `.gz` logs are read whole.
- **Side files** are read leniently: a `seats.json`, `arena.json` or `summary.json` that fails its
  schema is ignored with a warning and never makes a match unverifiable. `llm_calls.jsonl` and
  `replies.jsonl` are tailed into the annotations fold.

## 5. Folding: workers, timelines, the cache

- **Workers** (`fold/worker.ts`, `fold/pool.ts`). Two worker threads; each holds the folds of
  several logs. The main thread sends raw lines and receives batches (after at most 50 ms of work,
  and at the end of each message): new steps, keyframes, moments, the report copies the new items
  name, the seats whose notebook or counts changed, the cursor and the status. The main thread
  never folds (an architecture test checks that only `fold/worker.ts` imports the fold). At most
  two logs are folded from scratch at a time; the others wait as `loading`. A worker that crashes
  fails its folds, which refold from the first line on a new worker (three failures make the
  match unverifiable).
- **Timelines** (`timeline/timeline.ts`). Everything the fold produced, plus the frame at the
  tail, updated by applying each step with the web's reducer. Batches apply idempotently by
  cursor, so a refold of the same log adds nothing it already holds.
- **Startup.** Every listed match is loaded from the cache, or folded in the background. A
  finished match whose cache file exists is ready at once (a 7-day match: about 0.5 s from process
  start to `ended`, the process included). A running match serves its cached prefix at once while
  the worker refolds the log from its first line (§12: the fold cannot be resumed from a
  snapshot yet).
- **The cache** (`timeline/cache.ts`). One gzipped JSON file per (timeline id, match id, log id),
  written through a temporary file and a rename when a fold reaches the end of a log that cannot
  grow, every minute for a running match, and at shutdown. The timeline id changes with the log,
  `TIMELINE_VERSION` and `ENGINE_VERSION`, so a new fold version refolds. A file that does not
  parse is deleted and the log refolded. 544 KB for the 7-day fake run.
- **LRU.** Finished timelines stay in memory in an LRU of 8; an evicted one is read back from the
  cache on the next request (never refolded). Running matches always stay in memory.

## 6. The REST API

GET and HEAD only. Bodies are JSON validated by the protocol's Zod schemas in the contract tests;
errors are data, `{ok: false, code, message, hint}`. The OpenAPI 3.1 document is generated from
the route table (`GET /api/openapi/json`).

| Route                                                                  | Response                                                                                         | Cache                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `/api/health`                                                          | `Health`: ok, version, format, uptime, folds in progress                                         | `no-store`                                       |
| `/api/matches`                                                         | `MatchListItem[]` (never starts a fold)                                                          | 10 s                                             |
| `/api/matches/:id`                                                     | `MatchMeta`: seats, map, config, clock, status, cursor, timeline, keyframe cursors, verification | 5 s live, 1 h finished, ETag                     |
| `/api/matches/:id/latest`                                              | `Frame` at the tail (its `seq` is the cursor to subscribe from)                                  | `no-store`                                       |
| `/api/matches/:id/t/:timeline/keyframes/:seq`                          | `Frame` (cursors listed in the meta only)                                                        | immutable                                        |
| `/api/matches/:id/t/:timeline/steps?after&limit`                       | `{from, to, steps, lastSeq, more}`, `limit` ≤ 2,000                                              | immutable when finished or full, else `no-store` |
| `/api/matches/:id/t/:timeline/moments`                                 | `Moment[]`                                                                                       | immutable when finished, else 5 s                |
| `/api/matches/:id/feed?after\|before&kinds&players&pair&private&limit` | `{items: [{seq, item}], more}`, `limit` ≤ 200                                                    | `no-store` live, 1 h finished                    |
| `/api/matches/:id/annotations/:seat/:turn`                             | `TurnAnnotation` (side files)                                                                    | `no-store` until complete, then 1 h              |
| `/api/matches/:id/players/:seat`                                       | `PlayerDossier`                                                                                  | 10 s                                             |
| `/api/matches/:id/reports/:report`                                     | `ReportDetail` with the other copies' ids                                                        | immutable                                        |

Codes: `NOT_FOUND` (unknown or unpublished match), `TIMELINE_GONE` (refetch the meta),
`NO_KEYFRAME`, `NO_SEAT`, `NO_ANNOTATION`, `NO_REPORT`, `NO_ROUTE`, `BAD_REQUEST` (422),
`METHOD_NOT_ALLOWED` (405), `RATE_LIMITED` (429 with `Retry-After`), `LOADING` (503 with
`Retry-After` while a match's header is not folded yet), `UPGRADE_REQUIRED` (426), `INTERNAL`
(500, a fixed body). Bodies over 8 KB are gzipped when accepted; immutable bodies are kept
serialised and compressed in a small memo.

## 7. The WebSocket (`/api/live`, one match per socket)

Messages are the protocol's `ClientMsg` and `ServerMsg` (`@perfidia/protocol/spectator`).

1. The client loads the meta (timeline), a base frame (keyframe 0, or `/latest`) and sends
   `{type: "subscribe", match, timeline, after}`, `after` being the cursor of its base.
2. The server answers `status`, `clock` (real-time matches), the `annot` messages of the turns
   open now, then the missing steps in messages of at most 500 steps, each
   `{type: "steps", from, to, steps}` with every step `from < seq ≤ to`; it waits for the socket
   to drain whenever a send reports backpressure.
3. When the cursor reaches the tail, the socket joins the match's topic, in the same synchronous
   step as the check, so no range is missed or sent twice; every later batch is published once
   as a `steps` range whose `from` is the previous tail.
4. A client that sees `from` differ from its cursor subscribes again with its cursor (a gap). A
   client that reconnects subscribes with its cursor and gets exactly the missing range, also after
   a server restart (same timeline). A cursor ahead of a restarted server's tail waits until the
   refold passes it.
5. `resync {timeline}` when the client's timeline is not the current one (a new log or fold
   version: refetch the meta and a base); `resync {log_replaced}` when the log is replaced;
   `status {unpublished}` when the match is unpublished. While a match loads, `subscribe` is
   queued and answered with `status: loading`.

`annot` messages carry a reply's reasoning, text and tool names as `replies.jsonl` grows; they are
not durable (the annotations route serves the same content). `ping` gets `pong`.

## 8. What is public, and what never is

Spectators see everything in the game: every city, army, movement, private message, proposal,
notebook, public thought, wake and tool result code; profiles and models (a fake seat is flagged
`fake: true`); per turn and round, reasoning summaries, reply text, tool names, costs, tokens and
latency (annotations, policy flags in §3).

Never served: the header's `idKey` and `seed` (for `--id-key seed` runs the seed is the key);
`arena.json` and `summary.json` raw (they hold the seed, alerts, pause causes and reason text);
`transcripts/` and `prompts/`; request ids, error messages and refusal explanations from
`llm_calls.jsonl` (only error kinds and refusal categories); `gw` and `turn` error text;
divergence texts (a fixed wording); file and cache paths; stack traces; API keys (none is read).
Player-authored text is cleaned (newlines kept, other control characters replaced, bidi controls
removed) and sent as typed fields.

## 9. Limits and hardening

| Scope        | Limit                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP, per IP | Token bucket: 300 per minute, burst 120; 429 with `Retry-After`                                                                                 |
| Sockets      | 32 per IP, 5,000 in all (429 at upgrade); 60 subscribes per IP per minute                                                                       |
| Per socket   | One match; 20 messages per 10 s (closed with 1008); 4 KiB per message; idle 120 s with pings                                                    |
| Backpressure | 1 MiB queued on a subscribed socket closes it (Bun's `closeOnBackpressureLimit`); the client resumes from its cursor. Catch-up waits for drain. |
| Paging       | `limit` capped on every paged route; filter lists capped (20 kinds, 12 players)                                                                 |

Every response carries `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors
'none'`, …), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`; HSTS behind
Fly. No CORS, no cookies. A WebSocket upgrade must come from the server's own origin, a
`--origin`, or no origin (non-browser clients). The server binds 127.0.0.1 unless given a
`publish.json`. The cache directory is the server's own and outside every route.

## 10. Tests and measurements

Server tests (`packages/server/src/*.test.ts`, in the default `bun test`; 39 tests, about 37 s run
alone):

| File                                    | What it checks                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `war.test.ts`                           | The war golden through the API (§1), keyframes, moments, feed filters, restart from the cache                                                                                                                                                                                                                          |
| `live.test.ts`                          | Following `arena run --fake` live; chunks cut anywhere with a resumed and a restarted client; a stale timeline gets `resync`; a replaced log gets `resync`; a crash-truncated log stays live then stalls; annotations and `annot` messages; `clock` messages of a running real-time match (`sim run --clock realtime`) |
| `contract.test.ts`                      | Every route on the war golden and a 1-day fake run, parsed with the protocol's schemas, on both adapters; pinned OpenAPI paths; error codes; cache headers, ETag/304, gzip, HEAD; one Eden `treaty` test                                                                                                               |
| `security.test.ts`                      | No secret in any response, WebSocket message, OpenAPI document, error body or cache file (planted refusal explanation, error message, request ids, API key in the environment, the shared prompt); methods, traversal, links; headers; foreign origin; rate, socket, message and payload limits; configuration         |
| `publish.test.ts`                       | Listing, the kill switch, an invalid file, `after_end` across a restart, unverifiable runs, `degraded`                                                                                                                                                                                                                 |
| `many.test.ts`                          | 100 WebSocket clients of one live match end with the whole fold's frame; health p99 under 100 ms while two war-golden folds run                                                                                                                                                                                        |
| `cache.test.ts`                         | LRU eviction and reload from the cache; a corrupt cache file is refolded                                                                                                                                                                                                                                               |
| `units.test.ts`, `architecture.test.ts` | Line tail, statuses and stall thresholds, the token bucket, steps and feed pages, the hub's catch-up under backpressure; env reads, SDK and orchestrator bans, the fold in the worker only, a framework-free service                                                                                                   |

Measured on this container:

| Item                                                     | Budget (design §6.3)         | Measured                                                                                                              |
| -------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Fold of the war golden (16,253 lines) through the server | ≤ 5 s                        | about 4.7 s to served, server start included                                                                          |
| Fold of a 7-day fake run (21,311 lines)                  | ≤ 5 s                        | about 5.5 s from `bun run serve` to `ended`                                                                           |
| Load of a cached finished timeline                       | ≤ 100 ms                     | 60–100 ms (war golden, in process); 0.54 s for a 7-day run from process start                                         |
| `/api/health` during two folds                           | ≤ 100 ms p99                 | p99 7–9 ms, max 10–40 ms                                                                                              |
| Line written → visible                                   | ≤ 1.5 s p95                  | 100 clients caught up 40–75 ms after the last write (25 ms polls in tests; 250 ms polls and `fs.watch` in production) |
| A frame                                                  | ≤ 60 KB raw                  | 40.6 KB (7-day fake run, end)                                                                                         |
| Cache per 7-day match                                    | ≤ 2 MB                       | 544 KB                                                                                                                |
| Steps of a 7-day match                                   | ≤ 1.5 MB raw, 250 KB gzipped | **over**: 2.96 MB, 411 KB gzipped (step 1's figure; §12)                                                              |
| Server memory                                            | ≤ 60 MB per match            | RSS 206 MB after a cold 7-day fold (worker heaps included), 94 MB after a restart from the cache                      |

## 11. Dependencies and the supply chain

Added to `packages/server` (exact pins; publish dates checked on the registry on 2026-10-18, all at
least 14 days old): `elysia@2.0.0-beta.21` (2026-10-02), `@elysia/openapi@2.0.0-beta.4`
(2026-09-03), and Elysia's peers `typebox@1.3.34` (2026-09-18), `exact-mirror@1.2.6` (2026-09-06),
`openapi-types@12.1.3` (2023-05-24), `@scalar/types@0.22.4` (2026-10-02); `@elysia/eden@2.0.0-beta.6`
(2026-10-02) as a dev dependency. Transitive: `deuri@3.0.0`, `memoirist@1.2.2`,
`@scalar/helpers@0.16.0`, `nanoid@5.1.16`, `type-fest@5.10.0`, `tagged-tag@1.0.0`, all older than
14 days. `bun.lock` still holds exactly one TypeScript (`typescript@7.0.2`) and one Zod
(`zod@4.6.5`). `bun audit`: no advisories.

- `bunfig.toml` sets `minimumReleaseAge = 1209600` (14 days). It does not hold back an exact pin,
  so every direct dependency is pinned exactly and its date checked when added.
- `scripts/check-dep-ages.ts` checks locked versions against the registry: with `--base <old
  lock>` only the versions a change adds. CI's `deps` job runs it blocking on pull requests'
  additions, and informational on the whole lock (four tooling versions locked before phase 3 are
  younger than 14 days today: `oxlint@1.87.0`, `oxfmt@0.72.0`, `@types/node@26.6.5`,
  `@babel/runtime@7.29.10`), plus `bun audit` (informational).
- Elysia betas move fast (betas 22–32 came out after beta 21): re-pin at most monthly, together
  with `@elysia/openapi`, and run the contract tests; the raw adapter is the tested fallback.

## 12. Deviations, open issues, and what Pass B adds

**Deviations from the design:**

- **The frame** has no `standings` field: `standingsOf(frame)` derives them (players by rank).
  Patches carry field-level updates (`cityFields`, `queueFields`, `playerFields`, `seatFields`),
  and build and recruit queues are a separate `queues` collection keyed `c3#7`. Moment and feed
  contexts are richer than the abridged design §3.3. Launch importance: 3 against an ally, 2 an
  attack with settlers, 1 an attack, 0 otherwise. The map's width is `maxX + max(0, minX)`.
  `SeatEnt.next.kind` also allows `start`.
- **Restart of a running match** refolds its log from the first line in a worker (its cached
  prefix is served meanwhile; the refold skips what the timeline holds) instead of resuming the
  replay from a cached engine snapshot and gateway state: the spectator fold has no snapshot and
  restore yet.
- **Validation** of path and query parameters happens in the route table for both adapters (the
  same 422 body), not in Elysia's validators; responses are built as `Response` objects and not
  validated at run time (the contract tests validate them). The OpenAPI document is generated from
  the route table and handed to `@elysia/openapi` as its `documentation`, so both adapters serve
  the same document. Eden is typed for `/api/health` only (the table's routes are registered in a
  loop).
- **Feed caching**: a finished match's feed is cached 1 h with an ETag rather than immutable (the
  feed route carries no timeline). Step pages that are full are immutable even while live.
- **Fail closed** is "a non-loopback host needs `--publish`"; `publish.json` has a format field.
- **Annotations**: `annot` messages follow `replies.jsonl` as it grows and are not re-sent when a
  turn completes; the 10-minute completeness rule counts from when the server saw the `turn` item.
- **Fake reasoning** text includes the bot's label ("Fake reasoning: …"), in fake runs only.

**Open issues:**

1. Steps of a 7-day match are over the §6.3 budget (2.96 MB, 411 KB gzipped against 1.5 MB and
   250 KB). Options: coarser checkpoint steps, dropping per-tick queue and seat churn.
2. The spectator fold cannot be saved and restored (see the restart deviation): a running match
   costs one fold per restart.
3. Memory after a cold fold is 206 MB RSS (two worker heaps); the per-match budget is unmeasured
   in isolation.
4. `clock` messages are tested on a real-time log written by `sim run` under virtual time; no
   real-time match at wall speed has been served yet.
5. The default `bun test` on this container took 348 s before phase 3 (2,945 tests), 395 s after
   step 1 (3,077 tests) and 422 s now (3,116 tests): far over the 90 s target of architecture
   §13.8, which the suite had already left before phase 3.
6. Open questions for the owner (design §9) still stand: visibility for external harnesses, full
   reasoning, prompts, public costs, what is public, content policy, hosting, the exit-test
   material.

**Pass B adds** the web app (`packages/web`, React SPA on the `./reduce` and
`@perfidia/protocol/spectator` sub-paths), static serving from the server (`--web-dist`, the SPA
fallback for non-`/api` paths only), `bun run dev` and `web:build`, the Playwright smoke test, the
how-to-watch overlay and the outsider-test pilot on the war golden (design §4, §6.2, §7). Pass C
adds the turn detail, dossier extras and live per-round reasoning.
