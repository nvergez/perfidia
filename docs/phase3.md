# Phase 3: the spectator view (Pass A as built)

> **Status.** Roadmap step 3 of `docs/brief.md`, "Spectator view": a live map, a diplomatic feed
> and a leaderboard. Exit criterion: an outsider understands the match within a few minutes.
>
> - **Pass A (data and server, no UI) is built**, in two steps: the pure data layer (the engine's
>   incremental replayer, the gateway's incremental fold, the `@perfidia/spectator` projection,
>   the protocol's spectator schemas, `replies.jsonl` and per-line flushing) and the read-only
>   server (`@perfidia/server`). Pass B (the web app) is in progress: its first step, the web
>   scaffold (`packages/web`, `--web-dist`), is built (§14); the views and the end-to-end smoke
>   test follow. Pass C (extras) is not built yet (§12).
> - This document describes what was built. The reviewed phase-3 design (with its `[critic]`
>   corrections) is the source of the decisions; "design §x" below and in code comments refers to
>   it. Where this document and the code disagree, the code wins; fix this document.
> - A security and correctness review of Pass A was fixed afterwards (§13 lists what changed).
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
    and the raw `Bun.serve` fallback), the gate (methods, exact paths, the `Host`, rate limit,
    origin), headers, gzip.

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
bun run serve -- --runs runs --cache .cache/spectator --all-runs
# then: http://127.0.0.1:8080/api/matches, /api/openapi/json, ws://127.0.0.1:8080/api/live
```

| Flag                           | Meaning                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--runs <dir>`                 | Root whose subdirectories are run directories (`sim run --out`, `arena run --out`). Required.                                                                  |
| `--cache <dir>`                | The server's own timeline cache. Without it, every restart refolds every match.                                                                                |
| `--publish <file>`             | `publish.json`: the public matches (§4). Required to bind a non-loopback host, and behind a trusted proxy.                                                     |
| `--all-runs`                   | List every discovered run instead (local development, loopback bind only). One of `--publish` and `--all-runs` is required.                                    |
| `--host`, `--port`             | Default `127.0.0.1` and `$PORT`, else 8080.                                                                                                                    |
| `--public-host <name[:port]>`  | A `Host` the server answers to (repeatable; required to bind a non-loopback host). A loopback bind answers to `127.0.0.1`, `localhost`, `[::1]` with its port. |
| `--origin <url>`               | Another browser origin allowed to open the WebSocket (repeatable).                                                                                             |
| `--no-costs`, `--no-reasoning` | Leave costs, tokens and spend, or reasoning summaries and reply text, out of the annotations (design §9 Q2, Q4; both are served by default).                   |
| `--adapter raw`                | Serve with the raw `Bun.serve` adapter instead of Elysia.                                                                                                      |
| `--web-dist <dir>`             | Serve the built web app (`bun run web:build` → `packages/web/dist`) outside `/api` (§14).                                                                      |
| `--dev`                        | Serve the OpenAPI UI page (`/api/openapi`); re-read `--web-dist` when it changes.                                                                              |

Environment: `PORT`, and `PERFIDIA_SERVE_TRUST_PROXY=fly` (read the client IP from
`Fly-Client-IP`, send HSTS; it requires `--publish`). Nothing else is read; the server holds no
API key. `SIGHUP` re-reads
`publish.json`; `SIGINT`/`SIGTERM` stop it (running matches' timelines are written to the cache
first). Exit code 3 on a configuration error.

Examples:

```sh
# The war golden, as a finished match.
mkdir -p /tmp/runs/war && cp packages/sim/fixtures/golden/perfidia-1@1.1.0/lockstep-6p-6d-war.jsonl.gz /tmp/runs/war/match.jsonl.gz
bun run serve -- --runs /tmp/runs --cache /tmp/spectator-cache --all-runs
# A fake arena match, followed live while it is written (arena flushes match.jsonl per line).
bun run arena -- run --fake --days 2 --out /tmp/runs/fake2
# A bot match at real-time speed (a game day in 2.4 wall minutes), flushed per line.
bun run sim -- run --clock realtime --time system --speed 600 --days 1 --live-flush --out /tmp/runs/bots
```

`publish.json` (replace it atomically: write a temporary file, then rename it over the old one):

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
  links are never followed: discovery uses `lstat`, and every run file is opened with
  `O_NOFOLLOW` and checked on the open descriptor. The root is rescanned every 10 s and on
  `fs.watch` events; a vanished directory is dropped. Ids are index keys, never paths built from
  requests.
- **Publication.** With `--all-runs`, every run is listed (local development). With `--publish`,
  only the listed ids exist for clients, and nothing of an unlisted run is read (no header, no side
  file, no poll, no watcher); each has a title, a description, `featured`, and a `visibility`:
  `live` (default) or `after_end` (absent from every route until the log has an end line,
  computed from the log, so it survives restarts). The file's directory is watched, and the file
  is re-read every 2 s and on `SIGHUP`: removing an id unpublishes the match from every route at
  once, and its sockets get `status: unpublished` (a client polls the meta to learn when it is
  back). A file that fails to parse at startup stops the server; later, a failed read is retried
  every 250 ms, and only if it still fails 500 ms later does it publish nothing until fixed (fail
  closed): an editor rewriting the file in place unpublishes nothing.
- **Verified before public.** With `--publish`, a match is visible only once its first fold has
  reached the log's tail without a divergence (or a verified cached prefix is loaded, for a
  running match after a restart): a tampered or stale run is never served, not even while its fold
  has not reached the bad line yet. In development (`--all-runs`) every run is listed, unverifiable
  and loading ones included.
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
  and its clients get `resync {log_replaced}`. A finished log is no longer tailed, but its file is
  checked every few seconds against the fingerprint of what was folded (§5), so a run deleted and
  rerun under the same name is noticed. Polled every 250 ms and on `fs.watch` events. `.gz` logs
  are read whole.
- **A replaced log with the same header** (a lockstep rerun with the same seed and id key has the
  same header, hence the same log id) never reuses the old log's timeline id: in the same process,
  and after a restart (the old log's cache file no longer matches the file), the new log gets the
  next generation of its id, salted with the file's identity (inode and birth time). Without
  `--cache` a restart cannot remember an earlier log, so use a cache in production.
- **Side files** are read leniently: a `seats.json`, `arena.json` or `summary.json` that fails its
  schema is ignored with a warning and never makes a match unverifiable. They are read once a
  listed match may be shown (an `after_end` match: at its end line). `llm_calls.jsonl` and
  `replies.jsonl` are tailed into the annotations fold at once for a running match (live `annot`
  messages); a finished one builds its annotations when a route first asks for them, and drops
  them with its timeline when the LRU evicts it.

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
  grow, every minute for a running match, and at shutdown (each time only once the fold has caught
  up with every complete line read). The timeline id changes with the log, `TIMELINE_VERSION` and
  `ENGINE_VERSION`, so a new fold version refolds. Each file records the log prefix it was folded
  from (its length and a hash of its last 64 KB; a `.gz` log: the compressed file's); a cached
  timeline is used only while the log file still holds that prefix (exactly that, for a finished
  log), else the log gets a new timeline (§4). A file that does not parse is deleted and the log
  refolded. 544 KB for the 7-day fake run.
- **LRU.** Finished timelines stay in memory in an LRU of 8, with their annotations. An evicted
  one leaves a summary in memory (meta fields, the tail frame, notebooks and counts), which
  answers the meta, `/latest`, the dossier and the listing; immutable bodies the HTTP layer still
  holds are answered without it too (§6). Other routes read it back from the cache (never a
  refold). Running matches always stay in memory.

## 6. The REST API

GET and HEAD only, exact paths only (a trailing slash or an empty segment is no route, on both
adapters). Bodies are JSON validated by the protocol's Zod schemas in the contract tests; errors
are data, `{ok: false, code, message, hint}`. The OpenAPI 3.1 document is generated from the route
table (`GET /api/openapi/json`).

| Route                                                                  | Response                                                                                         | Cache                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `/api/health`                                                          | `Health`: ok, version, format, uptime, folds in progress                                         | `no-store`                                       |
| `/api/matches`                                                         | `MatchListItem[]` (never starts a fold)                                                          | 10 s                                             |
| `/api/matches/:id`                                                     | `MatchMeta`: seats, map, config, clock, status, cursor, timeline, keyframe cursors, verification | 5 s live, 1 h finished, ETag                     |
| `/api/matches/:id/latest`                                              | `Frame` at the tail (its `seq` is the cursor to subscribe from)                                  | `no-store`                                       |
| `/api/matches/:id/t/:timeline/keyframes/:seq`                          | `Frame` (cursors listed in the meta only)                                                        | immutable                                        |
| `/api/matches/:id/t/:timeline/steps?after&limit`                       | `{from, to, steps, lastSeq, more}`, `limit` ≤ 2,000; pages end at multiples of 2,000 steps       | immutable when finished or full, else `no-store` |
| `/api/matches/:id/t/:timeline/moments`                                 | `Moment[]`                                                                                       | immutable when finished, else 5 s                |
| `/api/matches/:id/feed?after\|before&kinds&players&pair&private&limit` | `{items: [{seq, item}], more}`, `limit` ≤ 200                                                    | `no-store` live, 1 h finished                    |
| `/api/matches/:id/annotations/:seat/:turn`                             | `TurnAnnotation` (side files)                                                                    | `no-store` until complete, then 1 h              |
| `/api/matches/:id/players/:seat`                                       | `PlayerDossier`                                                                                  | 10 s                                             |
| `/api/matches/:id/reports/:report`                                     | `ReportDetail` with the other copies' ids                                                        | immutable                                        |

Codes: `NOT_FOUND` (unknown or unpublished match), `TIMELINE_GONE` (refetch the meta),
`NO_KEYFRAME`, `NO_SEAT`, `NO_ANNOTATION`, `NO_REPORT`, `NO_ROUTE`, `BAD_REQUEST` (422),
`METHOD_NOT_ALLOWED` (405), `WRONG_HOST` (421: a `Host` the server does not answer to),
`RATE_LIMITED` (429 with `Retry-After`), `LOADING` (503 with `Retry-After` while a match's header
is not folded yet), `UPGRADE_REQUIRED` (426), `INTERNAL` (500, a fixed body).

- **Steps pages are aligned.** A page never crosses a multiple of 2,000 steps, so a client paging
  from any cursor (a keyframe's, say) reaches the aligned pages after its first one; follow
  `more`, a page may hold fewer than `limit` steps. In a `more: true` page of a running match (an
  immutable page), `lastSeq` is the page's own `to`, a lower bound of the tail.
- **The body memo.** Immutable bodies are kept serialised and gzipped, keyed by match, timeline
  and parameters, bounded by 512 entries and 32 MB. Only canonical bodies are kept: keyframes, a
  finished match's moments, reports, and aligned whole step pages asked for from the cursor that
  ends the page before them, so arbitrary cursors cannot grow or churn it. A held body is answered
  before the match's timeline is looked up (an evicted timeline is not read back for it).
- **`Cache-Control` is `private`**: browsers may keep bodies (immutable ones for a year), shared
  caches may not, so a takedown is not undone by a proxy. A CDN in front of the server (a later
  hosting step) must be configured for this and purged on a takedown.

## 7. The WebSocket (`/api/live`, one match per socket)

Messages are the protocol's `ClientMsg` and `ServerMsg` (`@perfidia/protocol/spectator`).

1. The client loads the meta (timeline), a base frame (keyframe 0, or `/latest`) and sends
   `{type: "subscribe", match, timeline, after}`, `after` being the cursor of its base.
2. The server answers `status`, `clock` (real-time matches), the `annot` messages of the turns
   open now, then the missing steps in messages of at most 200 steps, each
   `{type: "steps", from, to, steps}` with every step `from < seq ≤ to`; it waits for the socket
   to drain whenever a send reports backpressure. Catch-up is bounded: a cursor more than 2,000
   steps behind gets `resync {behind}` (catch up over the gzipped REST pages, or from `/latest`,
   then subscribe again); a socket that does not drain within 10 s is closed (code 1013; it
   resumes from its cursor); and when the catch-up messages waiting in all sockets' buffers reach
   32 MB, a new catch-up gets `resync {backpressure}`.
3. When the cursor reaches the tail, the socket joins the match's topic, in the same synchronous
   step as the check, so no range is missed or sent twice; every later batch is published once
   as a `steps` range whose `from` is the previous tail.
4. A client that sees `from` differ from its cursor subscribes again with its cursor (a gap). A
   client that reconnects subscribes with its cursor and gets exactly the missing range, also after
   a server restart (same timeline). A cursor ahead of a restarted server's tail waits until the
   refold passes it; a cursor beyond the tail of a finished match gets `resync {gap}`.
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
Player-authored text is cleaned (newlines kept, other control characters replaced; bidi controls,
bidi marks, zero-width spaces, word joiners, U+FEFF and tag characters removed; the zero-width
joiner and non-joiner kept for scripts and emoji) and sent as typed fields.

## 9. Limits and hardening

| Scope        | Limit                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP, per IP | Token bucket: 300 per minute, burst 120; 429 with `Retry-After`                                                                                 |
| Sockets      | 32 per IP, 5,000 in all (429 at upgrade); 60 subscribes per IP per minute                                                                       |
| Per socket   | One match; 20 messages per 10 s (closed with 1008); 4 KiB per message; idle 120 s with pings                                                    |
| Backpressure | 1 MiB queued on a subscribed socket closes it (Bun's `closeOnBackpressureLimit`); the client resumes from its cursor. Catch-up waits for drain. |
| Catch-up     | At most 2,000 steps behind (`resync {behind}`), 200 steps per message, closed after 10 s without draining, 32 MB queued in all                  |
| Paging       | `limit` capped on every paged route; filter lists capped (20 kinds, 12 players); step pages aligned on 2,000 steps                              |

"Per IP" means per client key: an IPv4 address, an IPv6 address's /64 (one subscriber's
network), an IPv4-mapped IPv6 address as its IPv4 address. Memory under abuse is bounded by the
catch-up budget: an idle subscribed socket costs about 8 KB (300 at the tail: +2.4 MB RSS).

Every response carries `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors
'none'`, …), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`; HSTS behind
Fly. No CORS, no cookies.

- **Host.** A request whose `Host` is not one the server answers to gets 421 (`/api/health`
  aside, for platform health checks): a DNS-rebinding page cannot read a loopback server.
- **WebSocket origin.** An upgrade must come from an origin of the server's own host names
  (`http(s)://<host>`), a `--origin`, or no origin (non-browser clients); never from an origin
  derived from the request's `Host`. The origin and the socket caps are checked on the WebSocket
  route itself, and only `/api/live` is that route (Elysia runs with `strictPath`), so no other
  spelling of the path skips them.
- **The OpenAPI UI page** (`/api/openapi`, which loads a third-party script) is registered only
  with `--dev`; production serves the JSON document only.
- The server binds 127.0.0.1 unless given a `publish.json` and its public host names. The cache
  directory is the server's own and outside every route.

## 10. Tests and measurements

Server tests (`packages/server/src/*.test.ts`, in the default `bun test`; 53 tests, about 46 s run
alone):

| File                                    | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `war.test.ts`                           | The war golden through the API (§1), keyframes, moments, feed filters, restart from the cache                                                                                                                                                                                                                                                                                                                                                                                                         |
| `live.test.ts`                          | Following `arena run --fake` live; chunks cut anywhere with a resumed and a restarted client; a stale timeline gets `resync`; a replaced log gets `resync`; a crash-truncated log stays live then stalls; annotations and `annot` messages of a running match; `clock` messages of a running real-time match (`sim run --clock realtime`)                                                                                                                                                             |
| `contract.test.ts`                      | Every route on the war golden and a 1-day fake run, parsed with the protocol's schemas, on both adapters; pinned OpenAPI paths; error codes; exact paths only and the same answers from both adapters on edge inputs (trailing slashes, `%`, unknown query); the `Host` (421) and WebSocket origins on every spelling of `/api/live`; `private` cache headers, ETag/304, gzip, HEAD; one Eden `treaty` test                                                                                           |
| `security.test.ts`                      | No secret in any response, WebSocket message, OpenAPI document, error body or cache file (planted refusal explanation, error message, request ids, API key in the environment, the shared prompt); methods, traversal, links; headers; foreign origin; rate, socket, message and payload limits, on both adapters and every spelling of the WebSocket path; two run directories with the same log; the OpenAPI UI in development only; configuration (`--all-runs`, `--public-host`, a trusted proxy) |
| `publish.test.ts`                       | Listing, the kill switch, re-subscribing after it, a file rewritten in place (nothing unpublished), an invalid file (fail closed after the retries), `after_end` across a restart, unverifiable runs (a tampered log never listed nor served while it folds), an invalid line (unverifiable in meta and frames), `degraded`                                                                                                                                                                           |
| `many.test.ts`                          | 100 WebSocket clients of one live match end with the whole fold's frame; health p99 under 100 ms while two war-golden folds run                                                                                                                                                                                                                                                                                                                                                                       |
| `cache.test.ts`                         | LRU eviction: meta and `/latest` from the summary, held bodies without a cache read, other routes read back from the cache; a corrupt cache file is refolded; a log replaced by others with the same header (renamed over, then rewritten in place) gets a new timeline each time, also after a restart                                                                                                                                                                                               |
| `units.test.ts`, `architecture.test.ts` | Line tail (links refused), fingerprints, statuses and stall thresholds, the token bucket, client keys (IPv6 /64), the gate (paths, Host), the memo's bounds, `publish.json` retries, aligned and canonical pages, a refold batch straddling the cursor held, feed pages; the hub's catch-up under backpressure, too far behind, past a finished tail, a socket that never drains, the budget; env reads, SDK and orchestrator bans, the fold in the worker only, a framework-free service             |

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
  lock>` only the versions a change adds. A CI `deps` job (not yet in `ci.yml`: workflow files can
  only be changed by the owner, the patch is in the phase-3 pull request) runs it blocking on pull
  requests' additions, and informational on the whole lock (four tooling versions locked before phase 3 are
  younger than 14 days today: `oxlint@1.87.0`, `oxfmt@0.72.0`, `@types/node@26.6.5`,
  `@babel/runtime@7.29.10`), plus `bun audit` (informational).
- Elysia betas move fast (betas 22–32 came out after beta 21): re-pin at most monthly, together
  with `@elysia/openapi`, and run the contract tests; the raw adapter is the tested fallback.

## 12. Deviations, open issues, and what Pass B adds

**Deviations from the design:**

- **The frame** has no `standings` field: `standingsOf(frame)` derives them (players by rank).
  Patches carry field-level updates (`cityFields`, `queueFields`, `playerFields`, `seatFields`),
  and build and recruit queues are a separate `queues` collection keyed `c3#7`. Moment and feed
  contexts are richer than the abridged design §3.3. A launch item carries the attack's recorded
  `foe` (the besieger when the target is besieged: a relief), and `againstAlly` compares the
  attacker with that foe, not with the city's owner. Launch importance: 3 against an ally, 2 a
  relief or an attack with settlers, 1 an attack, 0 otherwise. The map's width is
  `maxX + max(0, minX)`. `SeatEnt.next.kind` also allows `start`.
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
  feed route carries no timeline). Step pages that are full are immutable even while live; pages
  are aligned on 2,000 steps; caching is `private`, not public.
- **Fail closed** is stricter than the design: listing every run needs `--all-runs` (loopback
  only); a non-loopback host needs `--publish` and `--public-host`; a trusted proxy needs
  `--publish`. `publish.json` has a format field.
- **WebSocket**: catch-up messages hold at most 200 steps (the design's "at most 500"), and
  catch-up is bounded (§7) with a new `resync` reason, `behind`.
- **Text hygiene** also removes bidi marks, zero-width spaces, word joiners, U+FEFF and tag
  characters (an amendment to design §2.6's list).
- **Annotations**: `annot` messages follow `replies.jsonl` as it grows and are not re-sent when a
  turn completes; the 10-minute completeness rule counts from when the server saw the `turn` item.
- **Fake reasoning** text includes the bot's label ("Fake reasoning: …"), in fake runs only.

**Open issues:**

1. Steps of a 7-day match are over the §6.3 budget (2.96 MB, 411 KB gzipped against 1.5 MB and
   250 KB). Options: coarser checkpoint steps, dropping per-tick queue and seat churn.
2. The spectator fold cannot be saved and restored (see the restart deviation): a running match
   costs one fold per restart.
3. Memory after a cold fold is 206 MB RSS (two worker heaps); the per-match budget is unmeasured
   in isolation. With 13 matches (ten copies of the war golden, two fake runs) the server holds
   about 330–440 MB RSS, cold or restarted from the cache (8 finished timelines in the LRU).
4. A request line or headers over Bun's limit get Bun's own 431, without the security headers
   (it never reaches the handler).
5. Symbolic links: run files are opened with `O_NOFOLLOW`, but a run directory swapped for a
   link between discovery and an open is followed (only the last path component is checked).
6. `clock` messages are tested on a real-time log written by `sim run` under virtual time; no
   real-time match at wall speed has been served yet.
7. The default `bun test` on this container took 348 s before phase 3 (2,945 tests), 395 s after
   step 1 (3,077 tests), 422 s after step 2 (3,116 tests) and 432 s after the review fixes
   (3,134 tests, 18 skipped): far over the 90 s target of architecture §13.8, which the suite had
   already left before phase 3.
8. Open questions for the owner (design §9) still stand: visibility for external harnesses, full
   reasoning, prompts, public costs, what is public, content policy, hosting, the exit-test
   material.

**Pass B adds** the web app (`packages/web`, React SPA on the `./reduce` and
`@perfidia/protocol/spectator` sub-paths), static serving from the server (`--web-dist`, the SPA
fallback for non-`/api` paths only), `bun run dev` and `web:build`, the Playwright smoke test, the
how-to-watch overlay and the outsider-test pilot on the war golden (design §4, §6.2, §7). Pass C
adds the turn detail, dossier extras and live per-round reasoning.

## 13. Review fixes

A security and correctness review of Pass A found 25 issues; the fixes, and the measurements that
show them (probes run against `bun run serve` on this container):

| Issue                                                                               | Fix                                                                                              | Measured after                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/live/` (Elysia's loose router) skipped the origin check and the socket caps   | `strictPath`; canonical paths in the gate; origin and caps checked on the WebSocket route itself | contract and security tests: no spelling of the path opens a socket from a foreign origin or past a cap                                                                                                             |
| No `Host` check: DNS rebinding read every run; origins trusted the request's `Host` | 421 for another `Host` (health aside); origins from the configured host names                    | contract test on both adapters                                                                                                                                                                                      |
| Sockets that stop reading held about 330 KB each; IPv6 /64s unlimited               | catch-up bound, 200 steps per message, 10 s drain timeout, 32 MB budget; limits keyed by /64     | 300 stuck sockets 1,990 steps behind: RSS back under its starting value within 4 s; the 10 s drain close is covered by a unit test (on loopback the kernel buffers absorbed the catch-up, so the timer never armed) |
| LRU thrash: each request for an evicted match read its cache file (25–40 ms)        | summaries for meta, `/latest`, dossiers; held immutable bodies answered first                    | 30 meta requests over 10 evicted matches: p50 0.7 ms, max 4.8 ms (was 25.1 ms and 40.1 ms)                                                                                                                          |
| The body memo was bounded by entries only; any cursor made an entry                 | 32 MB and 512 entries; canonical bodies only; keys with the match id                             | 256 distinct pages: RSS 328 MB after against 437 MB before the run (no growth)                                                                                                                                      |
| Every run directory was parsed into memory, listed or not                           | unlisted runs are not read; finished matches' annotations built on demand, dropped with the LRU  | 50 unlisted 7-day runs: first health 338–407 ms (was 3,511 ms), idle RSS from the cache 74 MB (was 280 MB)                                                                                                          |
| A tampered run was public (and `verified: ok`) while it loaded                      | with `publish.json`, visible only once verified                                                  | publish test polls during the fold: never listed nor served                                                                                                                                                         |
| A non-atomic edit of `publish.json` unpublished everything                          | 250 ms retries for 500 ms before failing closed; the directory is watched                        | publish test: a truncate-then-write unpublishes nothing                                                                                                                                                             |
| WebSocket catch-up from cursor 0 was a 27,000× amplifier                            | catch-up bounded to 2,000 steps (`resync {behind}`)                                              | unit test                                                                                                                                                                                                           |
| `/api/openapi/` served the Scalar UI in production                                  | the UI is registered with `--dev` only                                                           | security test                                                                                                                                                                                                       |
| A loopback bind behind a proxy listed every run                                     | `--all-runs` is explicit; a trusted proxy needs `--publish`                                      | configuration test                                                                                                                                                                                                  |
| Memo keys omitted the match id                                                      | keys are match, timeline, parameters                                                             | security test with two copies of the war golden                                                                                                                                                                     |
| `public` caching kept taken-down content in shared caches                           | `private`                                                                                        | contract test                                                                                                                                                                                                       |
| A cursor beyond a finished tail hung                                                | `resync {gap}`                                                                                   | unit test                                                                                                                                                                                                           |
| The adapters disagreed on edge inputs                                               | exact paths, health through the route table, undecodable parameters fail their schema            | contract test on both adapters (Bun's 431 aside, §12)                                                                                                                                                               |
| `lstat` then open by path followed a swapped link                                   | `O_NOFOLLOW` and `fstat` on the descriptor                                                       | unit test                                                                                                                                                                                                           |
| Invisible marks and tag characters kept by the text cleaner                         | removed (zero-width joiner and non-joiner kept)                                                  | unit and property tests                                                                                                                                                                                             |
| A relief of a besieged ally's city was told as an attack on that ally               | launches use the recorded foe (`foe`); reliefs are importance 2                                  | war golden: one attack on an ally (p2 on p3), three reliefs by p2 at c17 against p6                                                                                                                                 |
| A log replaced by one with the same header served the stale cache                   | cache files record their source; a replaced log gets a new timeline id generation                | cache test: a renamed-over log, a restart, then a log rewritten in place: three timelines                                                                                                                           |
| Every battle of a second at a besieged city was "a siege begins"                    | the read-ahead stops at the next battle of that city                                             | war golden: 8 battles flagged for 8 `siege_started` (was 12)                                                                                                                                                        |
| Projection freshness, the silent timer and `Timeline.apply`'s filter were untested  | `fold/fresh.test.ts` (a fresh projection after every line), a straddling-batch unit test         | each of the three mutants now fails a test                                                                                                                                                                          |
| After an invalid line the frames still said `live`                                  | the fold steps the line as `unverifiable`                                                        | publish test                                                                                                                                                                                                        |
| A running match's full pages carried a stale `lastSeq`                              | `lastSeq` is the page's `to` in a `more: true` page of a running match                           | unit test                                                                                                                                                                                                           |

`TIMELINE_VERSION` is 2 (the fold's output changed: `foe`, reliefs, battle flags, text hygiene), so
caches made before are refolded once.

## 14. Pass B, step B1: the web scaffold (as built)

`packages/web` (`@perfidia/web`) is the spectator SPA: React 19 with Zustand, shadcn/ui components
copied by hand onto `radix-ui` (`src/ui/`, MIT notice in `src/ui/README.md`), Tailwind 4 through its
CLI, bundled by `Bun.build`. It imports only React, the pinned UI packages,
`@perfidia/protocol/spectator` and `@perfidia/spectator/reduce` (lint override and
`src/architecture.test.ts`); ruleset ids appear in `src/skins/` only.

```sh
bun run web:build                      # Tailwind, then Bun.build of src/index.html into packages/web/dist; prints sizes, fails over budget
bun run serve -- --runs runs --cache .cache/spectator --all-runs --web-dist packages/web/dist
bun run dev -- --runs runs             # build, then Tailwind --watch, bun build --watch and the server (--web-dist, --dev)
bun packages/web/scripts/shot.ts --url http://127.0.0.1:8080/m/war --out /tmp/war   # screenshots (1440x900, 390x844) and console errors
bun run test:e2e                       # PERFIDIA_E2E=1 bun test packages/web/e2e (the smoke test of a later step)
```

- **Layout.** `src/lib/` (ids, time as the engine prints it, model names with "Fake" for fake seats,
  12 colour-blind-safe colours paired with shapes, the History API router, wrapped
  `localStorage`), `src/api/` (the REST client and the WebSocket client: resumable cursor, gap
  re-subscribe, resync, backoff; every payload parsed with the protocol's schemas, a failure dropped,
  reported and re-synced), `src/playback/` (the pure playback engine: segments from keyframe 0 and
  from `/latest` that merge, binary search on `t`, client keyframes every 500 steps, speeds 5 min/s
  to 6 h/s, live lockstep and real-time clock anchoring with its cap), `src/store/` (the match and UI
  stores, the session that loads a match and runs the animation-frame loop, shared selectors and
  hooks), `src/skins/` (perfidia-1 1.1.0 and 1.0.0 labels, blocs, sieges, the win rule from the
  config and `ext.domination`; a default skin), `src/pages/` (the match list and the match layout),
  `src/onboarding/` ("How to watch"). The view components (`src/map`, `timeline`, `board`, `story`,
  `feed`, `thoughts`, `players`) are stubs that the next steps replace.
- **Served by the server** with `--web-dist <dir>` on both adapters: an index of the directory made
  at startup (no path built from a request; links, dotfiles and special files skipped), hashed
  assets `private, max-age=31536000, immutable`, `index.html` and other files `no-cache`, gzip and
  ETags, and `index.html` for every GET/HEAD path outside `/api` (the app routes it; `/api` paths
  keep their JSON 404). The page's CSP adds the same-origin WebSocket to `connect-src`
  (`ws://<host> wss://<host>`, the host the gate checked). `packages/server/src/static.test.ts`.
  The gate's exact-path rule now applies to `/api` paths only.
- **Dependencies** (exact pins, publish dates from the registry, all at least 14 days old on
  2026-10-18): `react` and `react-dom` 19.3.0 (2026-09-09; the npm advisory endpoint reports none for
  19.3.0, so 19.3.1 is not adopted under the security exception), `zustand` 5.0.15 (2026-08-13),
  `radix-ui` 1.6.7 (2026-07-24), `class-variance-authority` 0.7.1 (2024-11-26), `clsx` 2.1.1
  (2024-04-23), `tailwind-merge` 3.7.0 (2026-09-12), `lucide-react` 1.51.0 (2026-10-03),
  `tw-animate-css` 1.4.0 (2025-09-24); dev: `tailwindcss` and `@tailwindcss/cli` 4.3.3 (2026-07-16),
  `@types/react` and `@types/react-dom` 19.3.0 (2026-09-09), `playwright-core` 1.56.1 (2025-10-17,
  matching the pre-installed Chromium 1194), and `@perfidia/engine` for one test (the time format
  against `fmtTime`). `scripts/check-dep-ages.ts bun.lock --base <the lock before>`: 158 added
  versions of 157 packages, none younger than 14 days. The lock still holds one TypeScript (7.0.2) and
  one Zod (4.6.5), no `bun` package and no `ts-morph`; `bun pm untrusted`: no dependency with a
  lifecycle script runs. `bun audit` reports one high advisory, `braces@3.0.3`
  (GHSA-vfj7-8cjw-p6xm, stack exhaustion on deeply nested patterns), reached only through the
  Tailwind CLI's file watcher (`@tailwindcss/cli` → `@parcel/watcher` → `micromatch`), a build-time
  tool fed our own glob patterns; no fixed version exists (3.0.3 is the latest).
- **Sizes** (`bun run web:build`): JS about 159 KB gzipped (510 KB minified; React DOM 202 KB and Zod
  100 KB of it), CSS about 8 KB gzipped; budgets 200 KB and 25 KB. `src/architecture.test.ts` also
  builds the bundle in process and fails above 200 KB.
- **Tests**: `bun test packages/web` runs 58 unit tests in about 0.4 s (no DOM).
- **CI**: the GitHub App cannot change workflow files; the proposed `web` job (`bun run web:build`)
  is delivered with the phase-3 pull request as `ci-web-build.patch`, for the owner to apply.
