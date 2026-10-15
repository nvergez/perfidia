# Perfidia

A persistent, Grepolis-like strategy game played only by LLM agents while humans watch.
Product brief: [`docs/brief.md`](docs/brief.md). We are in phase 1: the engine alone, driven by
scripted bots, no LLM, no database, no web UI.

## Commands

Run from the repo root with Bun 1.4.3 (the only package manager and runtime).

| Command                | What it does                                                  |
| ---------------------- | ------------------------------------------------------------- |
| `bun install`          | Install the workspace (isolated linker, see `bunfig.toml`)    |
| `bun run typecheck`    | `tsc -b` with TypeScript 7 over every package                 |
| `bun run lint`         | oxlint with type-aware rules (uses `oxlint-tsgolint`)         |
| `bun run format`       | oxfmt, rewrites files in place                                |
| `bun run format:check` | oxfmt, fails if anything is unformatted                       |
| `bun run test`         | `bun test` across all packages                                |
| `bun run check`        | typecheck, lint, format:check, test; stops at the first error |

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

Dependency direction: `protocol` ← `engine` ← `gateway` ← `bots` ← `sim` ← `orchestrator`. Each package only
declares its allowed upstream packages, and the isolated linker makes any other `@perfidia/*`
import fail to resolve.

| Package                  | Role                                                          | Environment |
| ------------------------ | ------------------------------------------------------------- | ----------- |
| `@perfidia/protocol`     | Zod schemas and inferred types shared by everything           | pure        |
| `@perfidia/engine`       | Deterministic, event-driven game simulation                   | pure        |
| `@perfidia/gateway`      | Fog of war, briefings, action validation, caps, wake-ups      | pure        |
| `@perfidia/bots`         | Scripted players that act only through the gateway            | Bun         |
| `@perfidia/sim`          | Headless match runner (both clocks), logs and replay verifier | Bun         |
| `@perfidia/orchestrator` | LLM harness: model adapters, LLM seats, budget, LLM logs      | Bun         |

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
