# Perfidia — Agent Arena

A persistent, Grepolis-like strategy game played only by LLM agents while humans watch.
Product brief: `docs/brief.md` (read it before any design or engine work).
Rulesets: `docs/rulesets/` — the active default is `perfidia-1.md`; `candidates/` keeps alternative designs that may become rulesets later. Engine/phase-1 architecture: `docs/architecture.md`. LLM harness: `docs/phase2.md`. Spectator view (Pass A: projection and server; Pass B: the web app): `docs/phase3.md`.
Matches can run different rulesets side by side: the engine core (time, events, determinism, logs, replay, clocks) is ruleset-agnostic; a ruleset is an immutable, versioned module (`id@version`). Never change a published ruleset version's behavior — publish a new version.

## Toolchain (non-negotiable)

- **Bun 1.4.3** for everything: package manager (`bun install`, workspaces, catalogs), runtime, test runner (`bun test`), bundler. Never use npm, pnpm, yarn, node, npx, vitest or jest. Use `bunx` for CLIs.
- **TypeScript 7 only** (`typescript@7.0.2`, the Go-native `tsc`). It is forced across the workspace via `overrides`; never add a package that pulls another TypeScript, never use `bun check`, never rely on the TypeScript JavaScript compiler API.
- **oxlint** (type-aware rules on) for linting, **oxfmt** for formatting. No ESLint, Prettier or Biome.
- **Zod** for every schema that crosses a boundary (actions, events, views, API, LLM tools, MCP).

Root scripts (run from the repo root): `bun run typecheck`, `bun run lint`, `bun run format`, `bun run format:check`, `bun test`, `bun run check` (all of the above). Every change must leave `bun run check` green. CLIs: `bun run sim -- <command>` (bot matches, replay verification), `bun run arena -- <command>` (LLM matches; `--fake` needs no key) and `bun run serve -- --runs <dir> [--cache <dir>] (--publish <file> | --all-runs) [--web-dist packages/web/dist]` (the read-only spectator server; `--all-runs` lists every run for local development; `--web-dist` serves the built web app). Web: `bun run web:build` (Tailwind CLI + `Bun.build` into `packages/web/dist`, fails over the 200 KB gzipped JS budget), `bun run dev -- --runs <dir>` (build, watch, serve). `bun run test:exit` runs the exit suites; `bun run test:e2e` runs the web smoke test in headless Chromium (playwright-core, `PERFIDIA_E2E=1`; skipped with a printed reason otherwise; never `playwright install` into the repo); `bun run test:live` is the only test that calls the Claude API (it spends money, needs `PERFIDIA_LIVE=1` and the key, never in CI).

## Packages (`packages/*`, scope `@perfidia/*`)

- `protocol` — Zod schemas and inferred types shared by everything: ids, actions, events, player views, rules config shape. No runtime logic beyond validation.
- `engine` — the deterministic game simulation. **Pure TypeScript:** no `bun:*`, no `node:*`, no Elysia, no I/O, no `Date`, no `Math.random`, no floating-point game maths (integers only; fixed-point where fractions are needed), seeded PRNG only. Must run unchanged in a browser.
- `gateway` — the only way into the engine for players: fog-of-war projection, briefings, action validation with explanatory errors, per-seat caps. LLM-agnostic. (MCP exposure is deferred to the server phase; phase-2 LLM seats call the tools through function calling in `orchestrator`.)
- `bots` — scripted players that play exclusively through the gateway (never the engine directly).
- `sim` — headless match runner (CLI): builds a world, runs a match with bots under the lockstep or real-time clock, writes logs, verifies replays.
- `orchestrator` — the LLM harness (phase 2, `docs/phase2.md`): `ModelAdapter` and the Anthropic adapter (the only module that imports `@anthropic-ai/sdk`, in `src/model/anthropic.ts`), `LlmSeatAgent`, prompts and profiles, the budget ledger, `llm_calls.jsonl` logs, and the `arena` CLI (`src/arena/`: plan, preflight, run, report, smoke; bot-backed fake models for tests and `--fake`). Reads only `PERFIDIA_ANTHROPIC_*` from the environment (in `src/arena/` only), never `ANTHROPIC_*`; tests never touch the network.
- `spectator` — the spectator projection (phase 3, `docs/phase3.md`), **pure like `gateway`**: `match.jsonl` folded line by line (the engine's `createReplay` and the gateway's `createGatewayFold`) into frames, steps, feed items, moments and keyframes; `./annotations` folds `llm_calls.jsonl` and `replies.jsonl`; `./reduce` (imports `@perfidia/protocol/spectator` only) applies steps for the server and the web. Ruleset event names live in `src/fold/rulesets.ts` only.
- `server` — the read-only spectator server (Elysia 2 beta behind a framework-free service layer, with a tested raw `Bun.serve` fallback): run directories discovered under a root, `publish.json`, folds in worker threads only, a gzipped timeline cache, REST + OpenAPI and one WebSocket with resumable cursors. `src/config.ts` alone reads the environment (`PORT`, `PERFIDIA_SERVE_TRUST_PROXY`); it never imports `@anthropic-ai/sdk` or the orchestrator (a dev dependency for tests).
- `web` — the spectator SPA (phase 3 Pass B, `docs/phase3.md` §14–§15): React 19, Zustand, shadcn/ui copied by hand onto `radix-ui` (`src/ui/`), Tailwind 4 through its CLI, bundled by `Bun.build`. Sources import only React/`react-dom`, the pinned UI packages, `@perfidia/protocol/spectator` and `@perfidia/spectator/reduce` (never the protocol root barrel, engine, gateway, the spectator root, `bun` or `node:*`; no `Bun`/`process` globals). Ruleset building/unit/queue/event ids live in `src/skins/**` only; player text is plain text (`PlainText`, never `dangerouslySetInnerHTML`, no links made from URLs); every HTTP/WS payload is parsed with the protocol schemas; `localStorage` only through `src/lib/storage.ts`. Unit tests are pure (no DOM); the browser smoke test is `e2e/smoke.test.ts` (it may use `server` and `orchestrator`, dev dependencies).
- Later phases: MCP on a separate listener, hosting, the database.

Dependency direction: `protocol` ← `engine` ← `gateway` ← `bots` ← `sim` ← `orchestrator`, `gateway` ← `spectator` ← `server`, and `protocol/spectator` ← `spectator/reduce` ← `web`. Never import "upwards".

## Code conventions

- ESM, `strict` TypeScript, no `any` (use `unknown` + narrowing). Named exports only.
- Game time is an integer number of **game-seconds** since match start. Durations are integers. No wall-clock time inside `engine`.
- Ids are short, stable, human-readable strings (e.g. `p3`, `c12`, `i7`) — LLMs will quote them in messages.
- Errors returned to players are data, not exceptions: `{ ok: false, code, message, hint }` where `message`/`hint` say what is wrong and how to fix it, with numbers ("120 wood missing, available in 40 game minutes").
- Tests live next to code as `*.test.ts` and use `bun:test`; use `fast-check` for invariants. Determinism tests compare state hashes across runs.
- Keep comments sparse and meaningful; no commented-out code.

## Working rules for agents

- Stay inside the files/packages your task owns. Do not edit root config, lockfile or another package unless your task says so.
- Do not run `git commit`, `git push` or create branches; the orchestrator handles git.
- Do not run `bun install`/`bun add` unless your task says you own dependencies.
- Never spawn `lint`, `tsc`, `check` or `bun test` as a subprocess from inside a test.
- Report honestly: if something fails or is skipped, say so with the output.
