import { canonicalJson, utf8Encode } from "@perfidia/engine/core";
import type { AnyRuleset, ExtraTool, ReadCtx } from "@perfidia/engine/contracts";
import { domain, recruitMax } from "@perfidia/engine/domain";
import { EngineBug, EngineMisuse, type ApplyOutput, type Match } from "@perfidia/engine/kernel";
import { describeError } from "@perfidia/gateway/clock";
import {
  explain,
  leaderboard,
  rulesInfo,
  timePair,
  toolError,
  toolWarning,
  viewCity,
  viewIsland,
  viewMap,
  viewPlayer,
  type ExplainEnv,
} from "@perfidia/gateway/present";
import {
  checkDailyCap,
  openArchive,
  searchArchivePage,
  seatOf,
  writeNote,
  type GatewayState,
  type WakeScheduler,
} from "@perfidia/gateway/seat";
import {
  ActionSchema,
  JsonSchema,
  TOOL_ARGS,
  TOOL_INFO,
  TOOL_NAMES,
  z,
  type Action,
  type CityId,
  type Json,
  type JsonObject,
  type PlayerId,
  type ToolArgs,
  type ToolCall,
  type ToolError,
  type ToolFamily,
  type ToolKind,
  type ToolName,
  type ToolResult,
  type UnitCounts,
  type Violation,
  type ViolationDetails,
  type ZodType,
} from "@perfidia/protocol";
import { TOOL_DESCRIPTIONS } from "./descriptions.ts";

// The tool registry (docs/architecture.md §8.3): the brief's 22 tools in every ruleset, plus the
// ruleset's extra tools (§3.7), and layers 2–5 of §7.2 in front of the engine:
//
//   2 schema         the tool's Zod schema, and the optional fields the ruleset does not accept
//   3 ids and fog    ids every seat may check: cities, islands and players exist (public), the
//                    acting city is the seat's own, a recalled movement is the seat's own (a hidden
//                    movement reads exactly like a missing one); the details are the engine's own
//   4 interface caps attack launches and messages per game day, the notebook's size
//   5 normalisation  batch expansion into consecutive actions, "max" counts, end_turn clamping
//
// then the engine (layer 6). Layer 1, the turn gate, is the turn handle's (`host.ts`). A tool never
// throws on player input (P12); anything else its gateway code throws becomes `INTERNAL`, never an
// engine error, which aborts the match (§7.3).

/** What a tool can do while it runs: the match, the seat's gateway state and the host's lines. */
export interface ToolEnv {
  readonly match: Match;
  readonly seat: PlayerId;
  readonly gw: GatewayState;
  /** The match's wake scheduler (`end_turn` sets the self-wake). An addition to §8.3's `ToolEnv`. */
  readonly wake: WakeScheduler;
  /** The seat's turn number, the round (from 0) and the call's index in the round. */
  readonly turn: { readonly index: number; readonly round: number; readonly call: number };
  /** Applies engine action `a`, item `i` of the call: writes its `act` line and delivers its events. */
  submit(a: Action, i: number): ApplyOutput;
  /** Writes the `note` line of an accepted `write_note` (an addition to §8.3's `ToolEnv`). */
  note(mode: "append" | "replace", text: string): void;
  /** `end_turn` ran: the turn ends after this round (an addition to §8.3's `ToolEnv`). */
  endTurn(): void;
}

export interface ToolSpec<A = unknown> {
  readonly name: string;
  readonly family: ToolFamily;
  readonly kind: ToolKind;
  /** Gateway-owned for the 22 tools, identical in every ruleset; the ruleset's for an extra tool. */
  readonly description: string;
  /** A `z.object` (§3.7). */
  readonly args: ZodType<A>;
  /** Layers 3–6 on schema-valid arguments. Never throws on player input (P12). */
  handle(env: ToolEnv, args: A): ToolResult;
}

export type ToolRegistry = ReadonlyMap<string, ToolSpec>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** `z.toJSONSchema(args)`: root `type: "object"`. */
  readonly inputSchema: JsonObject;
}

/** A gateway failure that must stop the match: a `ToolEnv` call of the host that threw. */
export class HostFailure extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HostFailure";
  }
}

// Helpers ---------------------------------------------------------------------------------------

function lookup<V>(rec: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/**
 * A deep copy of `value` through its canonical text (§6.3, §6.6): nothing in it aliases the engine,
 * the gateway state or an agent's objects, and a value that is not canonical JSON (a stray float,
 * a `Map`, …) throws.
 */
export function copyOf<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parsing the canonical text of `value` rebuilds a deep copy of `value`
  return JSON.parse(canonicalJson(value)) as T;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A fresh JSON object through its canonical text (§6.3, §6.6): no reference into the engine or the
 * gateway state survives, and a stray float throws (it becomes `INTERNAL`).
 */
export function jsonData(value: unknown): JsonObject {
  const parsed: unknown = JSON.parse(canonicalJson(value));
  if (!isJsonObject(parsed)) throw new Error("a tool result is not a JSON object");
  return parsed;
}

/** UTF-8 size of a value's canonical text (the `bytes` of an `obs` line). */
export function canonicalBytes(value: unknown): number {
  return utf8Encode(canonicalJson(value)).length;
}

function explainEnv(env: ToolEnv): ExplainEnv {
  return { r: env.match.read(), seat: env.seat, gw: env.gw };
}

/** The `ToolError` of a violation, worded for the seat at the current time. */
export function fail(env: ToolEnv, v: Violation): ToolError {
  return toolError(v, explainEnv(env));
}

function ok(env: ToolEnv, data: unknown, warnings: readonly Violation[] = []): ToolResult {
  const t = env.match.now;
  if (warnings.length === 0) return { ok: true, t, data: jsonData(data) };
  const e = explainEnv(env);
  return { ok: true, t, data: jsonData(data), warnings: warnings.map((w) => toolWarning(w, e)) };
}

const violation = (code: string, details: ViolationDetails): Violation => ({ code, details });

/** The result of one engine action: its data and warnings, or its explained rejection. */
function outcome(env: ToolEnv, out: ApplyOutput): ToolResult {
  return out.ok ? ok(env, out.data, out.warnings) : fail(env, out.violation);
}

function single(env: ToolEnv, a: Action): ToolResult {
  return outcome(env, env.submit(a, 0));
}

// Layer 3: ids every seat may check (public facts or its own). Details are the engine's shapes.

function ownCity(r: ReadCtx, seat: PlayerId, city: string): Violation | null {
  const c = lookup(r.state.cities, city);
  if (c === undefined) return violation("UNKNOWN_ID", { city });
  if (c.owner !== seat) return violation("NOT_OWNER", { city, owner: c.owner });
  return null;
}

function anyCity(r: ReadCtx, city: string): Violation | null {
  return lookup(r.state.cities, city) === undefined ? violation("UNKNOWN_ID", { city }) : null;
}

function anyIsland(r: ReadCtx, island: string): Violation | null {
  return lookup(r.state.islands, island) === undefined ? violation("UNKNOWN_ID", { island }) : null;
}

function anyPlayer(r: ReadCtx, player: string): Violation | null {
  return lookup(r.state.players, player) === undefined ? violation("UNKNOWN_ID", { player }) : null;
}

/** The seat's own movement; another player's reads exactly like a missing one. */
function ownMovement(r: ReadCtx, seat: PlayerId, movement: string): Violation | null {
  const m = lookup(r.state.movements, movement);
  return m === undefined || m.owner !== seat ? violation("UNKNOWN_ID", { movement }) : null;
}

/** The first violation of `checks`, as the call's rejection, or null. */
function precheck(env: ToolEnv, ...checks: ((r: ReadCtx) => Violation | null)[]): ToolError | null {
  const r = env.match.read();
  for (const check of checks) {
    const v = check(r);
    if (v !== null) return fail(env, v);
  }
  return null;
}

/** `INVALID_ARGS` for an optional tool field the ruleset does not accept (§3.7). */
function unsupported(env: ToolEnv, field: string): ToolError {
  return fail(
    env,
    violation("INVALID_ARGS", { field, ruleset: env.match.ruleset.ref, reason: "unsupported" }),
  );
}

/** Layer 4: today's allowance of attack launches or messages. */
function dailyCap(env: ToolEnv, kind: "attacks" | "messages"): ToolError | null {
  return checkDailyCap(seatOf(env.gw, env.seat), env.wake.rules, kind, env.match.now);
}

// Batches (layer 5) ------------------------------------------------------------------------------

/** One item of a batch: the action's data with `ok: true`, or the explained rejection. */
function itemOf(env: ToolEnv, out: ApplyOutput): JsonObject {
  if (!out.ok) return itemError(env, out.violation);
  const item: JsonObject = { ok: true, ...jsonData(out.data) };
  if (out.warnings.length > 0) {
    const e = explainEnv(env);
    item["warnings"] = out.warnings.map((w) => ({ ...toolWarning(w, e) }));
  }
  return item;
}

function itemError(env: ToolEnv, v: Violation): JsonObject {
  const { message, hint } = explain(v, explainEnv(env));
  return { ok: false, code: v.code, message, hint, details: { ...v.details } };
}

/**
 * `"max"` for `unit` in `city`, resolved just before its order is submitted (§7.4): the minimum of
 * what the stock pays for, the free population, the queue's `maxCount` and the unit's
 * `maxPerOrder` (`recruitMax`). At 0 no action is sent: the order fails with the violation a
 * count of 1 meets, which names the binding constraint.
 */
function resolveMax(
  env: ToolEnv,
  city: CityId,
  unit: string,
): { readonly count: number } | { readonly violation: Violation } {
  const r = env.match.read();
  const count = recruitMax(r, city, unit);
  if (count > 0) return { count };
  const probe: Action = { type: "recruit", city, unit, count: 1 };
  const hooks = r.ruleset.hooks;
  const guarded = hooks.guard === undefined ? null : hooks.guard(r, env.seat, probe);
  if (guarded !== null) return { violation: guarded };
  const handler = hooks.actions?.recruit ?? domain.actions.recruit;
  const verdict = handler.validate(r, env.seat, probe);
  if (!verdict.ok) return { violation: verdict.violation };
  throw new Error(`"max" of ${unit} in ${city} resolved to 0, yet a count of 1 is valid`);
}

// The 22 tools -----------------------------------------------------------------------------------

type Handler<T extends ToolName> = (env: ToolEnv, args: ToolArgs<T>) => ToolResult;

function spec<T extends ToolName>(name: T, handle: Handler<T>): ToolSpec<ToolArgs<T>> {
  const info = TOOL_INFO[name];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ToolArgs<T> is z.infer of TOOL_ARGS[T]; TypeScript cannot relate the two for a generic T
  const args = TOOL_ARGS[name] as unknown as ZodType<ToolArgs<T>>;
  return Object.freeze({
    name,
    family: info.family,
    kind: info.kind,
    description: TOOL_DESCRIPTIONS[name],
    args,
    handle,
  });
}

/** A read tool's view, or `UNKNOWN_ID` with `missing` when the view is `null`. */
function view(env: ToolEnv, value: unknown, missing: ViolationDetails): ToolResult {
  if (value === null) return fail(env, violation("UNKNOWN_ID", missing));
  return ok(env, value);
}

const readTools = {
  view_city: spec("view_city", (env, a) =>
    view(env, viewCity(env.match.read(), env.seat, a.city, env.gw), { city: a.city }),
  ),
  view_island: spec("view_island", (env, a) =>
    view(env, viewIsland(env.match.read(), env.seat, a.island), { island: a.island }),
  ),
  view_map: spec("view_map", (env, a) =>
    view(
      env,
      viewMap(env.match.read(), env.seat, a.fromCity),
      a.fromCity === undefined ? {} : { city: a.fromCity },
    ),
  ),
  view_player: spec("view_player", (env, a) =>
    view(env, viewPlayer(env.match.read(), env.seat, a.player, env.gw), { player: a.player }),
  ),
  leaderboard: spec("leaderboard", (env) => ok(env, leaderboard(env.match.read()))),
  rules: spec("rules", (env) => ok(env, rulesInfo(env.match))),
  read_notes: spec("read_notes", (env, a) => {
    const s = seatOf(env.gw, env.seat);
    const data: Record<string, unknown> = { notes: s.notes };
    if (a.search !== undefined) {
      const page = searchArchivePage(env.gw, env.seat, a.search);
      data["hits"] = page.hits;
      data["more"] = page.more;
    }
    if (a.open !== undefined) {
      const entry = openArchive(env.gw, env.seat, a.open);
      if (entry === null) {
        const key = a.open.startsWith("g") ? "message" : "report";
        return fail(env, violation("UNKNOWN_ID", { [key]: a.open }));
      }
      data["entry"] = entry;
    }
    return ok(env, data);
  }),
};

const gatewayTools = {
  write_note: spec("write_note", (env, a) => {
    const s = seatOf(env.gw, env.seat);
    const max = env.match.rules.gateway.notesMaxChars;
    const result = writeNote(s, a.text, a.mode, max, env.match.now);
    if (result.ok) env.note(a.mode, a.text);
    return result;
  }),
  end_turn: spec("end_turn", (env, a) => {
    const now = env.match.now;
    const s = seatOf(env.gw, env.seat);
    if (a.nextWakeIn === undefined && a.wakeAt === undefined) {
      env.endTurn();
      const pending = s.wake.selfAt;
      return ok(env, { wakeAt: pending === null ? null : timePair(pending), clamped: false });
    }
    const requested = a.wakeAt ?? now + (a.nextWakeIn ?? 0);
    const set = env.wake.requestSelfWake(env.seat, requested, now);
    env.endTurn();
    const warnings = set.clamped
      ? [
          violation("WAKE_CLAMPED", {
            requested: Math.min(requested, Number.MAX_SAFE_INTEGER),
            at: set.at,
          }),
        ]
      : [];
    return ok(env, { wakeAt: timePair(set.at), clamped: set.clamped }, warnings);
  }),
};

const engineTools = {
  build: spec("build", (env, a) => {
    const bad = precheck(env, (r) => ownCity(r, env.seat, a.city));
    if (bad !== null) return bad;
    const max = env.match.rules.queues.build.max;
    if (a.buildings.length > max) {
      return fail(
        env,
        violation("INVALID_ARGS", {
          path: "buildings",
          issue: `${a.buildings.length} items; the build queue holds at most ${max}`,
        }),
      );
    }
    const items = a.buildings.map((building, i) =>
      itemOf(env, env.submit({ type: "build", city: a.city, building }, i)),
    );
    return ok(env, { items });
  }),
  recruit: spec("recruit", (env, a) => {
    const bad = precheck(env, (r) => ownCity(r, env.seat, a.city));
    if (bad !== null) return bad;
    const items = a.orders.map((order, i) => {
      let count: number;
      if (order.count === "max") {
        const max = resolveMax(env, a.city, order.unit);
        if ("violation" in max) return itemError(env, max.violation);
        count = max.count;
      } else {
        count = order.count;
      }
      return itemOf(env, env.submit({ type: "recruit", city: a.city, unit: order.unit, count }, i));
    });
    return ok(env, { items });
  }),
  cancel_queue: spec("cancel_queue", (env, a) => {
    const bad = precheck(env, (r) => ownCity(r, env.seat, a.city));
    return bad ?? single(env, { type: "cancel_queue", city: a.city, item: a.item });
  }),
  send_resources: spec("send_resources", (env, a) => {
    const bad = precheck(
      env,
      (r) => ownCity(r, env.seat, a.from),
      (r) => anyCity(r, a.to),
    );
    const res = { wood: a.wood ?? 0, stone: a.stone ?? 0, gold: a.gold ?? 0 };
    return bad ?? single(env, { type: "send_resources", from: a.from, to: a.to, res });
  }),
  attack: spec("attack", (env, a) => {
    const bad =
      precheck(
        env,
        (r) => ownCity(r, env.seat, a.from),
        (r) => anyCity(r, a.to),
      ) ?? dailyCap(env, "attacks");
    return bad ?? single(env, { type: "attack", from: a.from, to: a.to, units: a.units });
  }),
  support: spec("support", (env, a) => {
    const bad = precheck(
      env,
      (r) => ownCity(r, env.seat, a.from),
      (r) => anyCity(r, a.to),
    );
    return bad ?? single(env, { type: "support", from: a.from, to: a.to, units: a.units });
  }),
  spy: spec("spy", (env, a) => {
    const bad = precheck(
      env,
      (r) => ownCity(r, env.seat, a.from),
      (r) => anyCity(r, a.to),
    );
    return bad ?? single(env, { type: "spy", from: a.from, to: a.to, gold: a.gold });
  }),
  recall_troops: spec("recall_troops", (env, a) => {
    if (a.movement !== undefined) {
      const movement = a.movement;
      const bad = precheck(env, (r) => ownMovement(r, env.seat, movement));
      return bad ?? single(env, { type: "recall", movement });
    }
    if (a.dismiss !== undefined) {
      const { city, player } = a.dismiss;
      const bad = precheck(
        env,
        (r) => ownCity(r, env.seat, city),
        (r) => anyPlayer(r, player),
      );
      return bad ?? single(env, { type: "dismiss", city, player });
    }
    const at = a.stationedAt;
    if (at === undefined) {
      // The schema's refinement allows no other shape; kept total for the type checker.
      return fail(env, violation("INVALID_ARGS", { path: "", issue: "name exactly one mode" }));
    }
    const home = a.home ?? null;
    const bad = precheck(
      env,
      (r) => anyCity(r, at),
      (r) => (home === null ? null : anyCity(r, home)),
    );
    const units: UnitCounts | null = a.units ?? null;
    return bad ?? single(env, { type: "recall_stationed", at, home, units });
  }),
  found_city: spec("found_city", (env, a) => {
    if (a.slot !== undefined && !env.match.rules.toolOptions.foundSlot) {
      return unsupported(env, "slot");
    }
    const bad = precheck(
      env,
      (r) => ownCity(r, env.seat, a.from),
      (r) => anyIsland(r, a.island),
    );
    const action: Action = {
      type: "found_city",
      from: a.from,
      island: a.island,
      units: a.units,
      slot: a.slot ?? null,
    };
    return bad ?? single(env, action);
  }),
  send_message: spec("send_message", (env, a) => {
    const to = a.to;
    const players = to === "all" ? [] : to;
    const bad =
      precheck(env, ...players.map((p) => (r: ReadCtx) => anyPlayer(r, p))) ??
      dailyCap(env, "messages");
    return bad ?? single(env, { type: "send_message", to, text: a.text });
  }),
  propose_alliance: spec("propose_alliance", (env, a) => {
    if (a.until !== undefined && !env.match.rules.toolOptions.pactUntil) {
      return unsupported(env, "until");
    }
    const bad = precheck(env, (r) => anyPlayer(r, a.to));
    const action: Action = {
      type: "propose",
      to: a.to,
      kind: a.kind,
      name: a.name ?? null,
      text: a.text ?? "",
      until: a.until ?? null,
    };
    return bad ?? single(env, action);
  }),
  answer_proposal: spec("answer_proposal", (env, a) =>
    single(env, { type: "answer", proposal: a.id, accept: a.accept }),
  ),
  leave_alliance: spec("leave_alliance", (env, a) => {
    const other = a.with ?? null;
    const bad = precheck(env, (r) => (other === null ? null : anyPlayer(r, other)));
    return bad ?? single(env, { type: "leave", with: other });
  }),
};

/** The 22 tools, by name, with the kind and family of `TOOL_INFO`. */
const STANDARD_TOOLS: Readonly<Record<ToolName, ToolSpec>> = Object.freeze({
  ...readTools,
  ...gatewayTools,
  ...engineTools,
});

// Extra tools (§3.7) ------------------------------------------------------------------------------

function extraSpec(tool: ExtraTool): ToolSpec {
  if (tool.kind === "read") {
    return Object.freeze({
      name: tool.name,
      family: tool.family,
      kind: "read",
      description: tool.description,
      args: tool.args,
      handle(env: ToolEnv, args: unknown): ToolResult {
        if (tool.read === undefined) {
          throw new Error(`extra read tool ${tool.name} has no read function`);
        }
        return ok(env, tool.read(env.match.read(), env.seat, args));
      },
    });
  }
  return Object.freeze({
    name: tool.name,
    family: tool.family,
    kind: "engine",
    description: tool.description,
    args: tool.args,
    handle(env: ToolEnv, args: unknown): ToolResult {
      const parsed = ActionSchema.safeParse({ type: "ext", tool: tool.name, args });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail(
          env,
          violation("INVALID_ARGS", {
            path: (issue?.path ?? []).slice(1).map(String).join("."),
            issue: issue?.message ?? "invalid arguments",
          }),
        );
      }
      return single(env, parsed.data);
    },
  });
}

/**
 * The tools of a match of `ruleset`: the 22 in `TOOL_NAMES` order, then the ruleset's extras.
 * Throws on an extra tool whose name collides (the registry rejects such a ruleset, §3.5).
 */
export function createToolRegistry(ruleset: AnyRuleset): ToolRegistry {
  const tools = new Map<string, ToolSpec>();
  for (const name of TOOL_NAMES) tools.set(name, STANDARD_TOOLS[name]);
  for (const extra of ruleset.tools ?? []) {
    if (tools.has(extra.name)) {
      throw new Error(`${ruleset.ref}: extra tool ${extra.name} collides with another tool`);
    }
    tools.set(extra.name, extraSpec(extra));
  }
  return tools;
}

/**
 * Name, description and JSON Schema of the 22 tools in `TOOL_NAMES` order, then of the ruleset's
 * extra tools: what phase 2 hands to MCP and to function calling (§8.3).
 */
export function toolDefinitions(ruleset: AnyRuleset): ToolDefinition[] {
  return [...createToolRegistry(ruleset).values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: jsonData(z.toJSONSchema(t.args)),
  }));
}

// One call, layers 2–6 --------------------------------------------------------------------------

/** How a call ran and what the host logs for it beyond the lines the tool wrote itself. */
export interface CallOutcome {
  readonly result: ToolResult;
  /**
   * `gw`: a gateway rejection (layers 2–4, nothing reached the engine) or `INTERNAL`; `obs`: a read
   * tool's answer; `null`: the tool wrote its own lines (`act`, `note`) or none.
   */
  readonly line: "gw" | "obs" | null;
  /** The parsed arguments (for the `obs` line). */
  readonly args?: Json;
  /** The gateway error behind an `INTERNAL` result. */
  readonly error?: string;
}

/** `INVALID_ARGS` for arguments that fail the tool's schema: the Zod path and what it expected. */
function schemaError(env: ToolEnv, error: z.ZodError): ToolError {
  const issue = error.issues[0];
  const details: ViolationDetails = {
    path: (issue?.path ?? []).map(String).join("."),
    issue: issue?.message ?? "invalid arguments",
  };
  if (issue !== undefined && "expected" in issue && typeof issue.expected === "string") {
    details["expected"] = issue.expected;
  }
  return fail(env, violation("INVALID_ARGS", details));
}

function internal(env: ToolEnv): ToolResult {
  try {
    return fail(env, violation("INTERNAL", {}));
  } catch {
    return {
      ok: false,
      t: env.match.now,
      code: "INTERNAL",
      message: "The gateway failed on this call; nothing was applied.",
      hint: "Send the call again; if it fails again, do something else.",
    };
  }
}

/** Errors that stop the match whatever the call: the engine's, and a host line that failed. */
function isFatal(e: unknown): boolean {
  return e instanceof EngineBug || e instanceof EngineMisuse || e instanceof HostFailure;
}

/**
 * Runs one call through layers 2–6: the tool (an unknown name is `INVALID_ARGS` with reason
 * `no_handler`: no such tool in this ruleset), its schema, then its handler. A gateway error is
 * `INTERNAL` (a `gw` line with the error); an engine error or a failed host line propagates.
 */
export function invokeTool(tools: ToolRegistry, env: ToolEnv, call: ToolCall): CallOutcome {
  let submitted = 0;
  const counted: ToolEnv = {
    match: env.match,
    seat: env.seat,
    gw: env.gw,
    wake: env.wake,
    turn: env.turn,
    submit(a, i) {
      submitted += 1;
      return env.submit(a, i);
    },
    note: (mode, text) => env.note(mode, text),
    endTurn: () => env.endTurn(),
  };
  try {
    const t = tools.get(call.tool);
    if (t === undefined) {
      const result = fail(
        env,
        violation("INVALID_ARGS", { tool: call.tool, reason: "no_handler" }),
      );
      return { result, line: "gw" };
    }
    let parsed: { success: true; data: unknown } | { success: false; error: z.ZodError };
    try {
      parsed = t.args.safeParse(call.args);
    } catch (e) {
      const result = fail(
        env,
        violation("INVALID_ARGS", {
          path: "",
          issue: `the arguments cannot be read (${describeError(e)})`,
        }),
      );
      return { result, line: "gw" };
    }
    if (!parsed.success) return { result: schemaError(env, parsed.error), line: "gw" };
    let args: Json;
    try {
      args = JsonSchema.parse(JSON.parse(canonicalJson(parsed.data)));
    } catch (e) {
      const result = fail(
        env,
        violation("INVALID_ARGS", {
          path: "",
          issue: `the arguments are not plain JSON (${describeError(e)})`,
        }),
      );
      return { result, line: "gw" };
    }
    const result = jsonResult(t.handle(counted, args));
    if (t.kind === "read")
      return result.ok ? { result, line: "obs", args } : { result, line: "gw" };
    if (!result.ok && submitted === 0) return { result, line: "gw" };
    return { result, line: null };
  } catch (e) {
    if (isFatal(e)) throw e;
    return { result: internal(env), line: "gw", error: describeError(e) };
  }
}

/** A result as agents receive it: a canonical copy (§6.6), so a stray float becomes `INTERNAL`. */
function jsonResult(result: ToolResult): ToolResult {
  return copyOf(result);
}
