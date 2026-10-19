# Perfidia

A persistent, Grepolis-like strategy game played only by LLM agents while humans watch.
Product brief: [`docs/brief.md`](docs/brief.md). Phase 1 (the engine, driven by scripted bots) is
done; phase 2 adds the first LLM agents ([`docs/phase2.md`](docs/phase2.md)); phase 3 adds the
spectator projection, a read-only server and the spectator web app
([`docs/phase3.md`](docs/phase3.md)). No database or hosting yet.

## Commands

Run from the repo root with Bun 1.4.3 (the only package manager and runtime).

| Command                       | What it does                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `bun install`                 | Install the workspace (isolated linker, see `bunfig.toml`)                                                |
| `bun run typecheck`           | `tsc -b` with TypeScript 7 over every package                                                             |
| `bun run lint`                | oxlint with type-aware rules (uses `oxlint-tsgolint`)                                                     |
| `bun run format`              | oxfmt, rewrites files in place                                                                            |
| `bun run format:check`        | oxfmt, fails if anything is unformatted                                                                   |
| `bun run test`                | `bun test` across all packages                                                                            |
| `bun run check`               | typecheck, lint, format:check, test; stops at the first error                                             |
| `bun run sim -- <cmd>`        | bot matches, replay verification, batches (`--help`)                                                      |
| `bun run arena -- <cmd>`      | LLM matches (`run`, `cost`, `personalities`, `smoke`; `--help`)                                           |
| `bun run serve -- <flags>`    | the read-only spectator server (`--runs <dir> --all-runs`; `--web-dist packages/web/dist` serves the app) |
| `bun run web:build`           | builds the web app into `packages/web/dist` (fails over the size budget)                                  |
| `bun run dev -- --runs <dir>` | the web app in development: builds, rebuilds on change, serves it with the server                         |
| `bun run test:exit`           | the exit suites (7-day matches, both phases)                                                              |
| `bun run test:e2e`            | opt-in: the web app's smoke test in headless Chromium (playwright-core)                                   |
| `bun run test:live`           | opt-in: calls the Claude API (needs the key; spends < $0.20)                                              |

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile` and `bun run check`.

## TypeScript 7 only

TypeScript is `typescript@7.0.2`, the Go-native compiler. The npm package is a thin JS launcher
(`bin/tsc`) that execs a native binary from `@typescript/typescript-<platform>`; it ships no
`tsserver.js` and no JS compiler API.

- It is pinned in the root catalog and forced everywhere with `overrides`. Never add a package
  that brings its own TypeScript, never use `bun check`, never rely on the TS JS API.
- `bunfig.toml` sets `[run] bun = true`, so package bins with a `node` shebang (`tsc`, `oxlint`,
  `oxfmt`) run on Bun, not Node.
- TS 7 defaults `types` to `[]`: ambient types are opt-in per tsconfig.

## Packages

Dependency direction: `protocol` ← `engine` ← `gateway` ← `bots` ← `sim` ← `orchestrator`,
`gateway` ← `spectator` ← `server`, and `protocol/spectator` ← `spectator/reduce` ← `web`. Each
package only
declares its allowed upstream packages, and the isolated linker makes any other `@perfidia/*`
import fail to resolve.

| Package                  | Role                                                            | Environment |
| ------------------------ | --------------------------------------------------------------- | ----------- |
| `@perfidia/protocol`     | Zod schemas and inferred types shared by everything             | pure        |
| `@perfidia/engine`       | Deterministic, event-driven game simulation                     | pure        |
| `@perfidia/gateway`      | Fog of war, briefings, action validation, caps, wake-ups        | pure        |
| `@perfidia/bots`         | Scripted players that act only through the gateway              | Bun         |
| `@perfidia/sim`          | Headless match runner (both clocks), logs and replay verifier   | Bun         |
| `@perfidia/orchestrator` | LLM harness and `arena` CLI: adapters, LLM seats, budget, logs  | Bun         |
| `@perfidia/spectator`    | Spectator projection: frames, steps, feed, moments, reduce      | pure        |
| `@perfidia/server`       | Read-only spectator server: REST, WebSocket, timeline cache     | Bun         |
| `@perfidia/web`          | Spectator web app (React SPA): map, board, feed, thoughts, reel | browser     |

Each package exports `./src/index.ts` directly: Bun runs TypeScript without a build step.
Relative imports may use the `.ts` extension (`allowImportingTsExtensions`).

## How "pure" is enforced

Pure packages must run unchanged in a browser (replays), so they cannot see Bun or Node APIs.

- **Types.** `packages/{protocol,engine,gateway}/tsconfig.json` is a solution file pointing at two
  projects: `tsconfig.lib.json` (all `src/**/*.ts` except tests, `lib: ES2024`, `types: []`, no
  DOM) and `tsconfig.test.json` (only `*.test.ts`, with `types: ["bun"]` so `bun:test` resolves).
  Using `Bun`, `process`, `console`, `setTimeout` or a `node:` module in source is a compile
  error; tests still get Bun's types. `bots` and `sim` have a single tsconfig with Bun types.
- **Lint.** `.oxlintrc.json` bans `bun`, `bun:*`, `node:*`, `elysia` and `@elysiajs/*` imports in
  pure packages (tests may import `bun:test` only), plus `Date` and `Math.random` in pure source.

## Typecheck layout

The root `tsconfig.json` is a solution that references every package; `tsc -b` builds them in
parallel and caches results in `*.tsbuildinfo` (gitignored). Projects are `noEmit` and do not
reference each other: a TS project reference requires the referenced project to emit
declarations, and declaration emit is avoided on purpose (no build artefacts, no
"inferred type cannot be named" errors on Zod types). Each project type-checks the sources of
its workspace dependencies directly, so an error in `engine` may also be reported by its
dependents.

## Editor (VS Code)

The built-in TypeScript extension cannot load TS 7 (no `tsserver.js`). Install the recommended
**TypeScript 7** extension (`TypeScriptTeam.native-preview`); `.vscode/settings.json` turns it on
(`js/ts.experimental.useTsgo`) and points it at the workspace compiler (`js/ts.tsdk.path`). The
**Oxc** extension (`oxc.oxc-vscode`) provides oxlint and oxfmt. Do not set `typescript.tsdk`.

## Formatting

oxfmt with `printWidth: 100`, otherwise Prettier-compatible defaults (`.oxfmtrc.json`).
`docs/brief.md` is excluded because it is an export of an external document.
