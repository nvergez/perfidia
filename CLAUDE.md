# Perfidia — Agent Arena

A persistent, Grepolis-like strategy game played only by LLM agents while humans watch.
Product brief: `docs/brief.md` (read it before any design or engine work).
Rulesets: `docs/rulesets/` — the active default is `perfidia-1.md`; `candidates/` keeps alternative designs that may become rulesets later. Engine/phase-1 architecture: `docs/architecture.md`.
Matches can run different rulesets side by side: the engine core (time, events, determinism, logs, replay, clocks) is ruleset-agnostic; a ruleset is an immutable, versioned module (`id@version`). Never change a published ruleset version's behavior — publish a new version.

## Toolchain (non-negotiable)

- **Bun 1.4.3** for everything: package manager (`bun install`, workspaces, catalogs), runtime, test runner (`bun test`), bundler. Never use npm, pnpm, yarn, node, npx, vitest or jest. Use `bunx` for CLIs.
- **TypeScript 7 only** (`typescript@7.0.2`, the Go-native `tsc`). It is forced across the workspace via `overrides`; never add a package that pulls another TypeScript, never use `bun check`, never rely on the TypeScript JavaScript compiler API.
- **oxlint** (type-aware rules on) for linting, **oxfmt** for formatting. No ESLint, Prettier or Biome.
- **Zod** for every schema that crosses a boundary (actions, events, views, API, LLM tools, MCP).

Root scripts (run from the repo root): `bun run typecheck`, `bun run lint`, `bun run format`, `bun run format:check`, `bun test`, `bun run check` (all of the above). Every change must leave `bun run check` green.

## Packages (`packages/*`, scope `@perfidia/*`)

- `protocol` — Zod schemas and inferred types shared by everything: ids, actions, events, player views, rules config shape. No runtime logic beyond validation.
- `engine` — the deterministic game simulation. **Pure TypeScript:** no `bun:*`, no `node:*`, no Elysia, no I/O, no `Date`, no `Math.random`, no floating-point game maths (integers only; fixed-point where fractions are needed), seeded PRNG only. Must run unchanged in a browser.
- `gateway` — the only way into the engine for players: fog-of-war projection, briefings, action validation with explanatory errors, per-seat caps. LLM-agnostic. (MCP exposure comes in phase 2.)
- `bots` — scripted players that play exclusively through the gateway (never the engine directly).
- `sim` — headless match runner (CLI): builds a world, runs a match with bots under the lockstep or real-time clock, writes logs, verifies replays.
- Later phases: `orchestrator` (LLM harness), `server` (Elysia HTTP/WS/MCP), `web` (spectator SPA).

Dependency direction: `protocol` ← `engine` ← `gateway` ← `bots` ← `sim`. Never import "upwards".

## Code conventions

- ESM, `strict` TypeScript, no `any` (use `unknown` + narrowing). Named exports only.
- Game time is an integer number of **game-seconds** since match start. Durations are integers. No wall-clock time inside `engine`.
- Ids are short, stable, human-readable strings (e.g. `p3`, `c12`, `i7`) — LLMs will quote them in messages.
- Errors returned to players are data, not exceptions: `{ ok: false, code, message, hint }` where `message`/`hint` say what is wrong and how to fix it, with numbers ("120 wood missing, available in 40 game minutes").
- Tests live next to code as `*.test.ts` and use `bun:test`; use `fast-check` for invariants. Determinism tests compare state hashes across runs.
- Keep comments sparse and meaningful; no commented-out code.

## Resource safety (mandatory)

On 2026-10-10 a test that ran `oxlint --type-aware` in a repo mirror, again and again, reached 36 GB + 7 GB per run and crashed the machine (kernel panic). The machine is shared with many other sessions; memory is the scarce resource.

- Never spawn `bun run lint`, `oxlint`, `tsgolint`, `tsc`, `bun run check` or `bun test` from inside a test, or from code a test runs. Tooling probes are manual (plant, run once, revert) or live in a standalone script run explicitly, never in `bun test` or `check`.
- Never lint or type-check a copy or mirror of the repo (copied tsconfigs + symlinked `node_modules`).
- Before running a heavy command, or one you will repeat, measure one run with `/usr/bin/time -l <cmd>` ("maximum resident set size"). Above about 4 GB, stop and find out why instead of repeating it.
- Every subprocess spawned from code has a hard timeout and is killed with its whole process group. Cache failures as well as successes, so a failing setup never re-runs.
- Never leave a command running in the background unattended. To stop one, kill its process group (`kill -- -<pgid>`) or `pkill -f <unique path>`, not just the parent.
- Check `memory_pressure` before long or parallel runs; if it is not "normal", wait or run less in parallel.

## Working rules for agents

- Stay inside the files/packages your task owns. Do not edit root config, lockfile or another package unless your task says so.
- Do not run `git commit`, `git push` or create branches; the orchestrator handles git.
- Do not run `bun install`/`bun add` unless your task says you own dependencies.
- Report honestly: if something fails or is skipped, say so with the output.
