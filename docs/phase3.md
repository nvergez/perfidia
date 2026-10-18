# Phase 3: the spectator view (Passes A and B as built)

> **Status.** Roadmap step 3 of `docs/brief.md`, "Spectator view": a live map, a diplomatic feed
> and a leaderboard. Exit criterion: an outsider understands the match within a few minutes.
>
> - **Pass A (data and server, no UI) is built**, in two steps: the pure data layer (the engine's
>   incremental replayer, the gateway's incremental fold, the `@perfidia/spectator` projection,
>   the protocol's spectator schemas, `replies.jsonl` and per-line flushing) and the read-only
>   server (`@perfidia/server`).
> - **Pass B (the exit-critical web app) is built**: the scaffold and `--web-dist` (§14), then the
>   views, the end-to-end smoke test and an outsider screenshot set (§15). What Pass B still
>   needs is owner work: the $0 pilot with people on the war golden and the exit test on a real
>   match of at least 4 game days (design §6.2). Pass C (extras) is not built yet (§12).
> - This document describes what was built. The reviewed phase-3 design (with its `[critic]`
>   corrections) is the source of the decisions; "design §x" below and in code comments refers to
>   it. Where this document and the code disagree, the code wins; fix this document.
> - A security and correctness review of Pass A was fixed afterwards (§13 lists what changed), and
>   so was one of Pass B (§15.10). An AI agent shown only screenshots stood in for an outsider
>   (§15.11): it is a proxy, not the pilot with people, which stays an owner step.
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
13. Review fixes
14. Pass B, step B1: the web scaffold
15. Pass B: the web app as built

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
protocol/spectator ← spectator/reduce ← web                     (Pass B; web dev-depends on server, orchestrator)
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
  aside, for platform health checks): a DNS-rebinding page cannot read a loopback server. A
  `Host` that does not even make a URL (`Host: a b`) gets 400 `BAD_REQUEST` after a token of the
  client's rate limit (429 once it is spent), without a log line (Pass B review, §15.10).
- **HTTP details.** Each encoding of a body is its own representation with its own ETag (the gzip
  one ends in `-gz"`); HEAD sends the `Content-Length` GET would send.
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

13. Review fixes
14. Pass B, step B1: the web scaffold
15. Pass B: the web app as built

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
fallback for non-`/api` paths only), `bun run dev` and `web:build`, the Playwright smoke test and
the how-to-watch overlay (design §4, §6.2, §7): built, see §14 and §15. Pass C adds the turn
detail, dossier extras and live per-round reasoning.

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
bun run test:e2e                       # PERFIDIA_E2E=1 bun test packages/web/e2e (the smoke test, §15)
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
  `feed`, `thoughts`, `players`) were stubs that the next steps replaced (§15).
- **Served by the server** with `--web-dist <dir>` on both adapters: an index of the directory made
  at startup (no path built from a request; links, dotfiles and special files skipped), hashed
  assets `private, max-age=31536000, immutable`, `index.html` and other files `no-cache`, gzip and
  ETags, and `index.html` for every GET/HEAD path outside `/api` (the app routes it; `/api` paths
  keep their JSON 404). The page's CSP adds the same-origin WebSocket to `connect-src`
  (`ws://<host> wss://<host>`, the host the gate checked; `wss://` only behind TLS since the Pass B
  review) and requires Trusted Types (`require-trusted-types-for 'script'; trusted-types 'none'`).
  `packages/server/src/static.test.ts`.
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
- **Sizes** at step B1 (`bun run web:build`): JS about 159 KB gzipped (510 KB minified; React DOM
  202 KB and Zod 100 KB of it), CSS about 8 KB gzipped; budgets 200 KB and 25 KB (§15 for Pass B). `src/architecture.test.ts` also
  builds the bundle in process and fails above 200 KB.
- **Tests** at step B1: `bun test packages/web` ran 58 unit tests in about 0.4 s (no DOM).
- **CI**: the GitHub App cannot change workflow files; the proposed `web` job (`bun run web:build`)
  is delivered with the phase-3 pull request as `ci-web-build.patch`, for the owner to apply.

## 15. Pass B: the web app as built

Steps B2a (map, timeline, key moments reel), B2b (board, story strip, feed, thoughts, players) and
B3 (integration, the end-to-end smoke test, these docs) replace the scaffold's stubs. Everything is
in `packages/web/src`; the design's §4 is the reference, and the deviations are listed in §15.7.

### 15.1 Running it

```sh
# Material: the war golden and a fake arena run (a few seconds; it has fake reasoning).
mkdir -p /tmp/runs/war && cp packages/sim/fixtures/golden/perfidia-1@1.1.0/lockstep-6p-6d-war.jsonl.gz /tmp/runs/war/match.jsonl.gz
bun run arena -- run --fake --days 1 --out /tmp/runs/fake1

bun run web:build                 # Tailwind CLI, then Bun.build into packages/web/dist; fails over budget
bun run serve -- --runs /tmp/runs --cache /tmp/spectator-cache --all-runs --web-dist packages/web/dist
# open http://127.0.0.1:8080/  (a match: /m/war; the reel: /m/war?reel=1; from the start: /m/war?start=1;
# the pair mode: /m/war?pair=p2,p3)

bun run dev -- --runs /tmp/runs   # build once, then Tailwind --watch, bun build --watch and the server
                                  # (--web-dist packages/web/dist --dev, port 8080); reload to see a change
bun run test:e2e                  # the browser smoke test (§15.5)
```

`web:build` now empties `dist/` instead of removing it, so a server started with `--dev` keeps
watching the same directory and re-indexes after each build.

### 15.2 What an outsider sees

- **Match list (`/`).** Live matches first, then finished ones: status, a FAKE badge on fake runs
  (and "Fake" on each fake seat, never a model name), the winners and how they won, the lineup
  with ids and model badges, "Watch the key moments" (`?reel=1`) and "Open".
- **Match view (`/m/:id`).** A finished match opens at its end (`?start=1`: at the first second),
  a running one live. "How to watch" opens by itself on a first visit (four bullets, the win rule
  with this match's numbers, the players with their colours and shapes); the flag is kept in
  `localStorage` through `lib/storage.ts`.
  - Desktop (≥ 1280 px): the story strip on top; leaderboard and blocs | map and timeline | tabs
    Feed, Thoughts, Players. Tablet: map and timeline beside the board, the tabs below. Phone: the
    story strip, the map, tabs Board, Feed, Thoughts, Players, and the timeline docked at the
    bottom.
  - **Story strip** (`story/`): the day and time, the leader and the margin, the bloc closest to a
    domination win (or its running countdown), and the irony sentence: the attack on an ally now
    at sea (red, pulsing), else the last betrayal, else the latest key moment; once the match ends,
    who won and how. The irony sentence is a button that seeks to what it tells of.
  - **Leaderboard and blocs** (`board/`): rank, glyph, "Name · id", model badge, a score bar split
    into its parts, cities, cities taken, army population (with the eye: hidden from players),
    alliance and pact chips, status (winner, eliminated, handed to a bot, "thinking… round N").
    The rule sentence from the skin, then per bloc its cities against the number needed, taken
    pips, and a running countdown; before the window opens: "opens in …", rows dimmed.
  - **Map** (`map/`): one SVG; islands by kind (Olympus gold), cities by owner colour and shape
    around their island (capital star, taken dot), sieges with a countdown arc, alliance outline
    rings, curved movement routes with markers moved on every animation frame through refs
    (attacks on an ally red and pulsing, supports dashed, returns faded), battle flashes for 2 game
    hours; zoom and pan (wheel, pinch, drag, buttons), a map key. A city opens its popover: owner,
    island, buildings and queues through the skin, garrison by owner ("hidden from players"),
    siege, former owners, the stock extrapolated with "≈", the last battle there. A battle report
    opens as a dialog with the fullest copy, rendered by the skin.
  - **Timeline** (`timeline/`): previous and next key moment, play/pause, the game clock, a
    scrubber (ARIA slider: day ticks, moment glyphs by kind, ←/→ 15 min, Shift 1 min, Page Up/Down
    6 h, Home, End), speeds 5 min/s to 6 h/s, LIVE or "Go live" while the match runs; keys Space,
    ←/→, +/−.
  - **Key moments reel**: importance-3 moments (plus importance 2 when there are fewer than 8), at
    most 16; each clip from t − 2 h to t + 30 min at 1 h/s with a caption card; the map rings the
    moment's cities and dims the other players.
  - **Feed** (`feed/`): cards in time order up to the playhead, following the bottom unless the
    viewer scrolls up ("N new"); chips All, Diplomacy, Military, Thoughts, Private only, a player
    filter, and the pair mode (`?pair=pA,pB`). Message cards show the lock and "Seen only by …",
    and "What pN was thinking when it wrote this" (the sender's thought of the same turn). Betrayal
    cards and "attack on an ally launched" cards are large and red, with "What they said before",
    "What they were thinking" and "Everything between pA and pB" (the pair mode). The last 300
    cards are rendered; "Older" pages from the feed route.
  - **Thoughts** (`thoughts/`): per agent the latest public thought, its status, a "Reasoning"
    expander (annotations: rounds, tools, cost), and the history of one thought per turn with
    wake-reason icons; bots behind "Show bots" (shown at once in a bots-only match).
  - **Players** (`players/`): a row per player, a hover card, and the dossier sheet: profile, who
    plays it (model, Bot, or Fake, explained), hand-off, spend against the cap, counts, the current
    notebook, and the thoughts with their reasoning.
- **One selection model** (`store/ui.ts`, `timeline/reel-focus.ts`): hovering or focusing a
  leaderboard row, a bloc or a player dims everyone else on the map; clicking a feed card, a moment
  glyph, a reel caption, the story strip's irony sentence or a "said before" message moves the
  playhead to that log line and selects the card; the selected card's city is ringed on the map
  from an hour before it to 6 game hours after; a city's owner opens the dossier; "Last battle
  here" opens the report.

### 15.3 Rules the code holds (architecture test, lint, review)

- Web sources import only React and `react-dom`, the pinned UI packages,
  `@perfidia/protocol/spectator` and `@perfidia/spectator/reduce`; no `Bun` or `process`
  (`src/architecture.test.ts`, the lint override). Ruleset building, unit, queue and event ids
  appear in `src/skins/**` only; island tints and moment colours are assigned by order of
  appearance and by feed kind, not by id.
- Player-authored text (messages, thoughts, notebooks, reasoning, names) goes through
  `PlainText`: React escaping, `white-space: pre-wrap`, `<bdi>`, no links made from URLs; no
  `dangerouslySetInnerHTML` (`react/no-danger`). The architecture test refuses the HTML and
  navigation sinks (`innerHTML`/`outerHTML` by property or by `["…"]`, `insertAdjacentHTML`,
  `createContextualFragment`, `parseFromString`, `setHTMLUnsafe`, `srcdoc`, `javascript:`,
  `document.write`, `eval`, `new Function`, `window.open`, `location.href =`/`assign`/`replace`)
  and every `href=` that is not a literal app path (`/…`, never `//…`) or `matchHref`/`routeHref`;
  lint adds `react/jsx-no-script-url`. The smoke test plants hostile text and checks the DOM
  (§15.5). `index.html` has no inline script (the server's CSP: `script-src 'self'`), and the page
  requires Trusted Types: no HTML or script sink accepts a string, whatever a later change does.
- **No CSP violation on load.** Zod probes `new Function` when it builds its first object schema;
  the CSP refuses it and the browser records a violation (and with Trusted Types, a console error)
  on every page. `src/zod-jitless.ts`, imported first by `main.tsx`, sets Zod's `jitless` flag
  through `globalThis.__zod_globalConfig` before Zod loads; the smoke test fails on any
  `securitypolicyviolation`.
- **Relative imports** must resolve under `src` (the architecture test resolves each one; a
  `../../engine/src/…` path is refused), and lint refuses `../../*/src/**` patterns too.
- **Public source maps.** The build keeps linked maps (the code ships anyway, minified) and
  rewrites their `sources` relative to the repository root (`packages/web/src/main.tsx`,
  `node_modules/…`), so a build written outside the repository (the e2e test's, a hosting build)
  never records the builder's absolute path (`scripts/build.ts`, `scripts/build.test.ts`).
- Every HTTP and WebSocket payload is parsed with the protocol's schemas; a failure is dropped,
  reported in the console and re-synced (`src/api/`). `localStorage` is touched by
  `lib/storage.ts` only, inside `try`/`catch`.
- `prefers-reduced-motion`: map markers jump once per game hour while playing and sit exactly
  when paused, nothing pulses, nothing scrolls smoothly. An `aria-live` region announces
  importance-3 moments as the playhead passes them: at most one every 5 s, the newest one when the
  window ends (none dropped), nothing for what is past on arrival or for a seek backwards, and
  nothing while the reel's captions speak (`pages/announce.ts`).
- **Keyboard.** "Skip to the timeline" and "Skip to the feed" come first; the map's cities are one
  tab stop (arrows move between them, Home and End); each leaderboard row is one tab stop (its
  name button, described by the row's figures; the figures' tips are off the tab order); Space on
  the timeline's slider plays or pauses; closing the city popover (Escape, ✕, a click on nothing)
  gives the focus back to the city. On the war golden at 1440 × 900, Play is the 11th tab stop
  (it was the 79th).
- Ids always next to names ("Odysseus · p1"); a fake seat reads "Fake", never a model name
  (`lib/models.ts`).
- The bundle: one JS chunk, 637.5 KB minified, **198.3 KB gzipped** (budget 200 KB; 193.2 KB before
  the Pass B review fixes; the architecture test's unsplit build: 202,990 of 204,800 bytes), CSS
  54.2 KB, 9.7 KB gzipped (budget 25 KB). To fit, the city popover, the hover card and the tooltips
  position their own panels instead of Radix Popover, HoverCard and Tooltip (floating-ui and
  popper cost about 10 KB gzipped); the unused shadcn copies were removed (`src/ui/README.md`).

### 15.4 Unit tests

`bun test packages/web/src packages/web/scripts`: 158 tests in 25 files, about 0.65 s, all pure
(no DOM): map geometry (slot positions, curves, interpolation, the turn-back point), zoom, what the
map reads from the feed (battle flashes, launches against allies, siege starts, the fullest report
copy, the cities of a selected card, the cities' keyboard order), playback keys (Space on the
slider) and the reel's plan and state machine, the story strip's templates (the margin of a win)
and its seek target, feed filters and windows (older pages never past the playhead; a message's
same-turn thought is its sender's turn), the alliances' history and a betrayal's battle, the
board's helpers (where a bloc stands), the moment titles with names, the announcer, wake reasons,
**the match session against a fake server** (`store/session.test.ts`: a cached meta of another
timeline is fetched again past every cache; `resync {behind}` catches up and subscribes from the
new cursor; a live gap of one line is not applied; `resync {log_replaced}` and `TIMELINE_GONE`
reload from a fresh meta; a lost socket shows in the store and "Retry now" reconnects), the live
clock's "waiting" flag, an overlapping steps page, the source map rewrite, plus B1's suites and
the architecture test (imports, relative imports, ruleset ids, sinks and links, storage, the
in-process bundle under 200 KB).

### 15.5 The end-to-end smoke test

`packages/web/e2e/smoke.test.ts`, run by `bun run test:e2e` (`PERFIDIA_E2E=1`); without the
variable, or without Chromium at `chromium.executablePath()`, it is skipped with a printed reason
(so the default `bun test` stays browser-free). It builds the app into a temporary directory
(in-process `buildWeb`), starts the server in process (`startServer` from `@perfidia/server`, with
`--web-dist` on that build, on `PERFIDIA_E2E_PORT` or any free port), copies the war golden in,
generates a 1-day fake arena run (`planArena`/`runArena` from `@perfidia/orchestrator`, both dev
dependencies of the web package), copies it once more with hostile text planted, waits for the
three to be folded and ended (the hostile copy still verifies), and drives headless Chromium
(playwright-core 1.56.1, Chromium 1194). Every page records `securitypolicyviolation` events and
console errors.

| Check (design §6.1 and the Pass B review)                | How                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The list shows the matches, the fake one with FAKE       | `[data-match=war]`, `[data-match=fake1]`; the FAKE badge on the fake card only                                                                                                                                                                                                                              |
| 31 islands and 42 city markers at the end                | the match opens at `D6 18:33`; `[data-map] [data-island]` = 31, `[data-map] [data-city]` = 42                                                                                                                                                                                                               |
| The end line's ranking and winners                       | rows in the order p4, p1, p5, p2, p6, p3; "winner" on p4 and p1 only                                                                                                                                                                                                                                        |
| Blocs read 16 / 2; the end: p1 and p4 by domination      | the rule sentence; a bloc at 16/16 and 2/2; the end card and the strip; the strip's margin ("held 16 of the 16 cities …, 2 of 2 taken, for 24 h; next: … with 16, 1 taken")                                                                                                                                 |
| D4 12:51: the betrayal card with its outcome and context | keyboard seek on the scrubber; the card names p2, p3 and c18, says "The attack failed: … p3 held … c18", with "said before" and "thinking"                                                                                                                                                                  |
| Each message opens its sender's thought of the same turn | at D4 08:57: "we remain friends" (p2) → "opportunist D4 08:56:32: message p3; attack c18 from c2" and "Turn 48, ended"; p3's call for help → "turtle D4 08:56:32: recruit c18 max hoplite" and "Turn 50, ended"                                                                                             |
| "Next key moment" moves the clock; `?start=1`            | the clock text changes; `/m/war?start=1` opens at `D1 00:00`                                                                                                                                                                                                                                                |
| A thought expands its reasoning (fake run)               | Thoughts tab, "Reasoning": "Fake reasoning: …" appears                                                                                                                                                                                                                                                      |
| Hostile player text stays text                           | p1's profile (`seats.json`), turn thoughts and notebook (`match.jsonl`), reasoning and replies (`replies.jsonl`) hold `<img onerror>`, `<script>`, `javascript:`, a URL, a bidi override and an attribute break-out: each is shown literally in Thoughts, Reasoning and the dossier; no planted handler ran |
| A match followed live, to its end                        | a run's log written line by line into the runs root while the page follows it: LIVE while lines arrive, then "The match is over" at `D2 00:00`, and the leaderboard in the order of the last frame's ranks                                                                                                  |
| No console error, no CSP violation, no HTML sink         | on every page: no `on*`/`srcdoc` attribute, no `img`/frame/`object`/`form`/`base`, no inline script, every link a path of the app (`/…`, never `//…`), no CSP or Trusted Types violation                                                                                                                    |
| A 390 × 844 phone screenshot                             | written to `$PERFIDIA_E2E_SHOTS`, else a new temporary directory (kept, path printed)                                                                                                                                                                                                                       |

Measured on this container: 8 tests pass in **13.9–15.5 s** in all (budget 30 s): build about
0.65 s, fake run about 1.3–1.5 s, folds ready 3.6–3.7 s later, the browser checks the rest
(`PERFIDIA_E2E=1 PERFIDIA_E2E_PORT=8263 bun test packages/web/e2e`). Mutants checked against it
(each on its own, restored after): the message's thought taken from the sender's previous turn
(`turn - 1` in `cards.tsx`) fails "Turn 48, ended"; the leaderboard reversed fails the war and the
live tests; `main.tsx` without `zod-jitless.ts` fails every page on a CSP (Trusted Types)
violation and a console error. The unit suite kills the review's M1 and M2 in `sameTurnOf`, M3
(no resubscribe after `resync {behind}`), M5 (an overlapping page re-adding held steps) and M6 (a
one-line gap applied). The e2e project has its own `tsconfig.e2e.json` without the DOM library (it
type-checks the server's Bun-typed sources, which do not compile against DOM's `BodyInit`), so the
in-page scripts are strings.

**CI.** The GitHub App cannot change workflow files, so the job is proposed as
`ci-e2e-job.patch`, delivered with the phase-3 pull request beside `ci-web-build.patch` (both
apply to `ci.yml` in either order): an `e2e` job that runs `bun install --frozen-lockfile`, restores
`.cache/ms-playwright` from `actions/cache` keyed on the pinned version
(`playwright-core-1.56.1-chromium-<os>`), runs `bunx playwright-core install --with-deps chromium`
in `packages/web` (the locked playwright-core, hence Chromium 1194) with `PLAYWRIGHT_BROWSERS_PATH`
pointing at that cache, then `bun run test:e2e` and fails if the smoke printed that it was skipped.
Nothing is installed by this step; bump the cache key with the pin.

### 15.6 Measurements

Frame rate of a replay at 1 h/s for 8–10 s in headless Chromium 1194 on this container (4 vCPU),
war golden, 1440 × 900 unless stated:

| Window, side tab                | DOM nodes   | fps       | fps with 4× CPU throttling                       |
| ------------------------------- | ----------- | --------- | ------------------------------------------------ |
| D2, Feed                        | 1,400–1,650 | 59.8–60.0 | 48.1                                             |
| D4, Feed                        | 3,656       | 59.9      | –                                                |
| D6, Feed (300 cards rendered)   | 8,000       | 59.2–59.8 | 15.4–18.1                                        |
| D6, Thoughts                    | 1,931       | 60.1      | 22.5 (16.3 before memoising the thought history) |
| D6, Players                     | 1,161       | 59.6      | 22.0–26.4                                        |
| D6, phone 390 × 844 (Board tab) | 942         | –         | 42.3                                             |

The design's budget (60 fps on desktop, ≥ 30 fps on a mid-range phone) holds; a throttled desktop
does not reach 30 fps late in the match. A trace (D6, Players tab, 3 s) shows main-thread paint
2.6 ms, layout 1.3 ms, layerize 1 ms and script about 3.8 ms per frame, plus 9 ms of raster per
frame: the whole map SVG repaints as its markers move. First map on screen: 0.30–0.36 s after
navigation to the finished war golden (loopback, a new browser context, the server's cache warm;
the design's budget is 1.5 s on desktop broadband), the clock at the end 0.35–0.48 s.

### 15.7 Deviations from the design

- **Arrival** on a finished match is at its end (who won is the first answer), not at seq 0;
  `?start=1` opens at the first second.
- **The end** reads "The match is over: … p1 and … p4 win by domination" (strip and end card), not
  "Domination: p1, p4"; the smoke test checks that sentence.
- **Popovers.** The city popover is a light panel portalled to the body (under the dialogs' layer,
  following the city through zoom, pan and scrolling, kept above the docked timeline on phones);
  the hover card and tooltips use the HTML popover API (`players/hover-panel.tsx`). Radix
  Popover, HoverCard and Tooltip were dropped for the bundle budget. The battle report is a modal
  dialog (the feed opens it while the map may be off-screen on a phone).
- **The reel** lasts about 68 s on the war golden (6 clips for 8 key moments, captions held 4–9 s),
  not "about 2 minutes"; "How to watch" says "a minute or two".
- **"thinking… round N"** has no "of M": the meta does not carry the round cap.
- **A fake seat** shows a "Fake" badge (with an explanation on hover and in the dossier) rather than
  "Odysseus · p1 · fake model (bot)"; its spend is labelled "(simulated prices)".
- **Additions:** the story strip's irony sentence seeks; betrayal cards lead into the pair mode;
  the selected card's city is ringed on the map. After the Pass B review and the outsider proxy
  (§15.10, §15.11): the strip states the margin of a win; each bloc row says where it stands; a
  betrayal card says how the attack went; launch cards name their origin city; moment titles in
  the reel and the scrubber read with names; a "Bots only" badge and a "test match" note; the
  connection state of a live match; skip links.
- **The pilot** (B3p) has not been run with people: a screenshot set reached through the UI only
  (§15.8) is the proxy prepared for it.
- **Dependencies:** none added; `@perfidia/server` and `@perfidia/orchestrator` became dev
  dependencies of the web package for the smoke test (`bun.lock`: two lines in the web workspace's
  entry, no new package).

### 15.8 The outsider screenshot set (a proxy for the design §6.2 pilot)

Sixteen PNGs taken through the UI only on the war golden published as "Six bots at war" (with
`--publish`), with a manifest that names only the action taken to reach each one, for people who
have never seen the project. They are delivered with the integration report, not committed:

| Shots | What they show                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | the match list                                                                                                                                                                |
| 2     | the first visit's "How to watch" overlay                                                                                                                                      |
| 3     | the default view of the finished match after "Start watching" (the end: winners in the strip, the board, the map, the feed)                                                   |
| 4–9   | the key moments reel at each of its 6 captions (the attack on an ally launched, the betrayal, the conquests and the countdown, the end), the map ringing each moment's cities |
| 10    | the view after the reel closed itself                                                                                                                                         |
| 11    | after clicking the strip's red sentence: the feed at the betrayal card with "What they said before" and "What they were thinking"                                             |
| 12–13 | after "Everything between …" on that card: the pair mode banner, then the feed scrolled up to the launch card and the private messages                                        |
| 14    | a dossier opened from the leaderboard (a scripted bot: profile, notebook, thoughts)                                                                                           |
| 15    | the end of the match after End on the timeline                                                                                                                                |
| 16    | the phone view (390 × 844)                                                                                                                                                    |

The set was taken again after the changes of §15.11 (`p3b-outsider-after/`, same actions, same
manifest).

### 15.9 Open issues

1. Throttled desktops fall under 30 fps late in a long match (§15.6). Options: draw the moving
   markers in a second SVG layer over a static one (only that layer re-rasters), render fewer feed
   cards while playing.
2. The JS bundle is at 198.3 of 200 KB gzipped (the architecture test's unsplit build: 202,990 of
   204,800 bytes): no headroom for Pass C without savings first. The largest web-owned pieces are
   `tailwind-merge` (28 KB minified), the map (35 KB) and the feed (34 KB); React DOM (207 KB) and
   Zod (102 KB) are most of it.
3. Not exercised in a browser: "Older…" paging from the feed route while the client lacks the
   start of the match; handoff and elimination cards and statuses (no fixture has them); a
   real-time match followed live at wall speed (the live smoke test is lockstep; a 3600×
   `sim run --clock realtime` showed LIVE).
4. Bot notebooks are raw JSON memory: laid out for reading, still data.
5. At 1280–1365 px the leaderboard truncates long names ("Conqueror (…" · p4: the id stays); on
   phones the map is too small for city ids (zoom shows them).
6. The pilot with people and the exit test on a real match of at least 4 days are owner steps
   (design §6.2, §9 Q10); the outsider proxy of §15.11 is an AI agent and replaces neither. Pass
   A's open issues (§12) stand.
7. The CI jobs `web` and `e2e` wait for the owner to apply `ci-web-build.patch` and
   `ci-e2e-job.patch` (unchanged by the review fixes: the e2e job runs `bun run test:e2e`, which
   now takes about 15 s).

### 15.10 Review fixes (Pass B)

An independent review of the integrated Pass B (security and correctness lenses) reported 18
findings; each was checked again here before it was fixed.

| Finding                                                                         | Verdict | What changed                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser-cached meta never revalidated: two matches mixed after a log change     | fixed   | The meta is fetched with `cache: "no-cache"` (ETag revalidation); a re-sync, `TIMELINE_GONE` or a base frame of another timeline refetches it with `cache: "reload"` (three tries, then an error, never a mixed view); a replay re-sync comes back to its time. Reproduced and checked in Chromium by swapping a run's log; unit tests. |
| Live viewers never told the connection is lost                                  | fixed   | A banner ("Connection to the server lost … Reconnecting in N s", "Retry now"), an "Offline" badge, "Reconnecting…" in the timeline; the lockstep note says how long since the last move. Checked by stopping the server under a live page.                                                                                              |
| No test of same-turn thoughts, the ranking, `?start=1` or the live session      | fixed   | §15.4, §15.5: e2e checks of both messages' thoughts, the end ranking and winners, `?start=1`, a live follow; unit tests of the session, a one-line gap and an overlapping page; the docs' mutant claim is now measured.                                                                                                                 |
| Zod's eval probe violates the CSP on every page                                 | fixed   | `src/zod-jitless.ts` (§15.3); no violation on `/`, `/m/war`, `/m/fake1`; the smoke test records violations. Trusted Types added to the page CSP (the app runs with no violation).                                                                                                                                                       |
| The smoke test's XSS checks see no hostile text; `//` links pass                | fixed   | A hostile run (§15.5); `//…` links fail; the `outerHTML` check replaced by sink checks.                                                                                                                                                                                                                                                 |
| Relative imports into other packages pass every check                           | fixed   | The import test resolves relative paths; a lint pattern too.                                                                                                                                                                                                                                                                            |
| A malformed `Host` gets 500 before the gate (no rate limit, a log line each)    | fixed   | 400 `BAD_REQUEST` after a rate-limit token, no log line, on both adapters (`security.test.ts`).                                                                                                                                                                                                                                         |
| No static check of other HTML sinks or of links from data                       | fixed   | The sink list and the link rule of §15.3; `react/jsx-no-script-url`.                                                                                                                                                                                                                                                                    |
| Public source maps expose the builder's absolute path                           | fixed   | `sources` rewritten relative to the repository root (§15.3).                                                                                                                                                                                                                                                                            |
| The page CSP allows `ws://` behind TLS                                          | fixed   | `wss://` only when the server is behind its TLS proxy.                                                                                                                                                                                                                                                                                  |
| HEAD answers `Content-Length: 0`; gzip and identity share an ETag               | fixed   | Static files and API bodies: HEAD gives GET's length; each encoding its own ETag (§9).                                                                                                                                                                                                                                                  |
| Escape on the city popover drops the focus to `<body>`                          | fixed   | The focus goes back to the city (an SVG element) on Escape, ✕ or a click on nothing; checked in Chromium.                                                                                                                                                                                                                               |
| A very long keyboard path to the timeline; Space dead after clicking the slider | fixed   | Skip links, one tab stop for the cities and per leaderboard row, Space on the slider (§15.3): Play is the 11th tab stop, not the 79th.                                                                                                                                                                                                  |
| The announcer reads the end on arrival and drops close moments                  | fixed   | §15.3 (`pages/announce.ts`, unit tests); nothing announced on arrival in Chromium.                                                                                                                                                                                                                                                      |
| "Waiting for the server…" while steps keep arriving                             | fixed   | Waiting only while the head is still before the clock's cap (unit tests).                                                                                                                                                                                                                                                               |
| At 1280 × 720 the scrubber is 147 px and the map shows no city ids              | fixed   | Side columns of 18.5 and 18 rem below 1366 px (scrubber about 290 px); city ids drawn down to a 0.62 px-per-tile map, their type growing as it shrinks.                                                                                                                                                                                 |
| The §15.8 list renumbered by the formatter                                      | fixed   | A table.                                                                                                                                                                                                                                                                                                                                |
| Feed side caches go stale; launch countdowns after the end; fake costs          | fixed   | A same-turn thought "not ended yet" is asked again, cached per timeline; older pages never past the playhead; no "(in …)" once the match has ended; "Simulated prices" under a fake turn's cost.                                                                                                                                        |

### 15.11 The outsider proxy (an AI agent, not the pilot)

An AI agent was shown only the sixteen screenshots of §15.8 and the design's five questions. **It
is a proxy, not the human pilot of the design's §6.2, which stays an owner step, as does the exit
test on a real match.** Its answers, graded against the war golden's log and fold:

| Question                                             | The proxy's answer, in short                                                                                                                                                                           | Grade                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 Who won, and by how much?                         | War p1 (p1, p4) by domination at D6 18:33; the final scores right; "the page never says by how much" (it summed the blocs' scores itself)                                                              | Right (a1 won by domination at D6 18:33 after a countdown from D5 18:33, 16 cities, 2 taken); the margin was missing from the page                                                       |
| Q2 How does a player win; how close was each?        | The rule right; the race told from the reel (War p1 10/16 at D4, both blocs 15/16 on D5, War p1's countdown, League p2 16/16 but 1/2 taken); Turtle p3's bar never seen                                | Mostly right; it placed the countdown's start at D5 19:04 (the screenshot's time; it began D5 18:33) and could not say why League p2 had no countdown                                    |
| Q3 Who is allied with whom, who betrayed whom?       | War p1 (p1, p4); League p2 (p2, p3) from D3 02:14; p2's attack on its ally p3 at c18 launched D4 08:56, landing D4 12:50, a2 dissolved; League p2 again (p2, p5) at D4 13:10; p2's reliefs to p5's c17 | Right (a1 formed D2 00:10, not "all match long"); it could not tell how the betrayal went (the attack failed: p3 held c18)                                                               |
| Q4 What does each agent intend, versus what it says? | p2 thought "attack c18 from c2" while telling p3 "we remain friends"; p3's call for help went to its attacker; p5's notebook unreadable; "the agents are scripted bots"                                | Right as far as it goes; weak by nature on bots (terse thoughts, canned messages). p3's message is the Turtle bot's call to its only ally, which was its attacker: real irony, not a bug |
| Q5 Where is the fighting?                            | c18 and c19 on D4; c35, c15, c37 on D5; c34, c37, c30, c17 on D6, with the reliefs                                                                                                                     | Right                                                                                                                                                                                    |

Its first impression: "polished and dense … the summary line tells you who won and names the one
betrayal … below the headline it is hard to follow: identical bot names, internal ids,
unexplained icons and terse command-log thoughts". What changed for its confusions:

| Confusion                                                                | Change                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The final leaderboard is not in score order                              | "Final ranking · the winners first" in the board's header; "How to watch" says it                                                                                                                                                                     |
| Both blocs read 16/16; why did League p2 not win?                        | Each bloc row says where it stands ("won the match", "was 1 conquest short of a countdown", "N cities short"); the strip gives the margin ("held 16 of the 16 cities a win needs, 2 of 2 taken, for 24 h; next: League p2 (p2, p5) with 16, 1 taken") |
| The icons under each name; the darker tail of the score bars             | A key line under the board's header (cities, conquered, army hidden from players); "How to watch" says to hover a score bar for its parts and how the score is made (from the skin)                                                                   |
| Internal ids ("a2 dissolved", "al (p1, p4)"), one name for two alliances | Moment titles in the reel and the scrubber read with names ("“War p1” a1 (Conqueror (bot) · p1, …)"); a dissolved alliance keeps its name and lists its members                                                                                       |
| The promise of AI agents, but scripted bots                              | A "Bots only" badge (list and header) and a "This is a test match" bullet in "How to watch"                                                                                                                                                           |
| p5's notebook is raw JSON                                                | Laid out for reading, captioned "A scripted bot's memory, as data"                                                                                                                                                                                    |
| Did the betrayal work?                                                   | The betrayal card: "The attack failed: Turtle (bot) · p3 held c18."                                                                                                                                                                                   |
| Two "Relief launched" cards that look like duplicates                    | Launch cards name their origin ("from c2", "from c9")                                                                                                                                                                                                 |
| The pair banner clips the card under it; "Between two…" truncated        | The feed's sticky header has a rule and a shadow; the button reads "Between two players"                                                                                                                                                              |
| Turtle p3's bloc bar cut off                                             | Lone players short of the cities share one "Alone:" line; the left column fits at 1440 × 900                                                                                                                                                          |
| Game time, the speed, the map's symbols                                  | "How to watch": "D4 12:50 is day 4 of the match at 12:50; 1 h/s plays one game hour per second"; it points to the "Map key"                                                                                                                           |
| `perfidia-1@1.1.0` and "Featured"                                        | "rules perfidia-1@1.1.0" with an explanation on hover; "Featured" explained on hover                                                                                                                                                                  |
| Left as they are                                                         | Two bots both named "Conqueror (bot)" (the log's names; ids and shapes tell them apart); unit names (peltast, hoplite: the skin's labels, no glossary yet); city ids only on the map (no region names)                                                |

The screenshots were taken again after these changes (`p3b-outsider-after/`, the same sixteen
actions); the proxy itself was not run again.
