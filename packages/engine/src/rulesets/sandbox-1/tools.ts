import type { ActionHandler, ExtraTool, ReadCtx } from "@perfidia/engine/contracts";
import {
  AuthoredNameSchema,
  CityIdSchema,
  z,
  type ActionOf,
  type CityId,
  type DeepReadonly,
  type JsonObject,
  type PlayerId,
  type Violation,
} from "@perfidia/protocol";
import { SandboxConfigSchema, type SandboxConfig } from "./config.ts";
import { CITY_NAME_INVALID } from "./errors.ts";
import { SandboxExtSchema, type SandboxExt } from "./ext.ts";
import { hillStatus } from "./hill.ts";

// The extra tools of sandbox-1 (docs/architecture.md §3.7, §3.8), so the whole extra-tool path is
// exercised: `hill_status` (read, observe) answers from public data only; `rename_city` (write,
// economy) becomes the engine action `{type: "ext", tool: "rename_city", args}`, handled here by
// `hooks.actions.ext`, and emits the public `city_renamed`.

export const HILL_STATUS = "hill_status";
export const RENAME_CITY = "rename_city";
/** The sandbox event of a renamed city. */
export const CITY_RENAMED = "city_renamed";

export const HillStatusArgsSchema = z.strictObject({});

/** The tool's arguments, as agents see them; the engine re-checks the name against the config. */
export const RenameCityArgsSchema = z.strictObject({
  city: CityIdSchema,
  name: AuthoredNameSchema,
});

/** What the engine accepts before its own checks: the name's rules are worded by the ruleset. */
const RenameCityActionArgsSchema = z.strictObject({ city: CityIdSchema, name: z.string() });

/** `city_renamed {city, name}`: public. */
export const CityRenamedSchema = z.strictObject({ city: CityIdSchema, name: AuthoredNameSchema });

/**
 * The match's config, from a `ReadCtx` of any type: extra tools and action handlers receive an
 * untyped context, and the kernel only ever gives them the config of the ruleset that declares
 * them.
 */
function configOf(r: { readonly config: unknown }): DeepReadonly<SandboxConfig> {
  const parsed = SandboxConfigSchema.safeParse(r.config);
  if (!parsed.success) throw new Error("sandbox-1: the match config is not a sandbox-1 config");
  return parsed.data;
}

function extOf(r: ReadCtx): DeepReadonly<SandboxExt> {
  const parsed = SandboxExtSchema.safeParse(r.ext());
  if (!parsed.success) throw new Error("sandbox-1: state.ext is not a sandbox-1 ext");
  return parsed.data;
}

/** `hill_status`: whether the hill is open, its threshold, the city leaders. Public data only. */
export const HILL_STATUS_TOOL: ExtraTool = Object.freeze({
  name: HILL_STATUS,
  family: "observe",
  description:
    "Hill victory status: whether it is open and when it opens, how many cities a player needs to win at once, the total number of cities and the three players owning the most cities. Public data only.",
  args: HillStatusArgsSchema,
  kind: "read",
  read: (r: ReadCtx, _seat: PlayerId, _args: unknown): JsonObject =>
    hillStatus(configOf(r), r.state, extOf(r)),
});

/** `rename_city {city, name}`: a write tool, handled by `hooks.actions.ext`. */
export const RENAME_CITY_TOOL: ExtraTool = Object.freeze({
  name: RENAME_CITY,
  family: "economy",
  description:
    "Rename one of your cities. The name is public and shows on the map: ASCII letters, digits, space, '-', '_' and '.', at most the length the rules give (16 by default).",
  args: RenameCityArgsSchema,
  kind: "write",
});

interface RenamePlan {
  readonly city: CityId;
  readonly name: string;
}

type Verdict = { ok: true; plan: RenamePlan } | { ok: false; violation: Violation };

function reject(code: string, details: Violation["details"]): Verdict {
  return { ok: false, violation: { code, details } };
}

function validateRename(r: ReadCtx, seat: PlayerId, a: ActionOf<"ext">): Verdict {
  if (a.tool !== RENAME_CITY) {
    return reject("INVALID_ARGS", { tool: a.tool, reason: "unknown_tool" });
  }
  const args = RenameCityActionArgsSchema.safeParse(a.args);
  if (!args.success) {
    const path = args.error.issues[0]?.path.map((p) => String(p)).join(".") ?? "";
    return reject("INVALID_ARGS", { tool: a.tool, field: path === "" ? null : path });
  }
  const { city, name } = args.data;
  const record = Object.hasOwn(r.state.cities, city) ? r.state.cities[city] : undefined;
  if (record === undefined) return reject("UNKNOWN_ID", { city });
  if (record.owner !== seat) return reject("NOT_OWNER", { city });
  const max = configOf(r).names.cityMaxChars;
  if (name.length < 1 || name.length > max) {
    return reject(CITY_NAME_INVALID, { city, reason: "length", length: name.length, max });
  }
  if (!AuthoredNameSchema.safeParse(name).success) {
    return reject(CITY_NAME_INVALID, { city, reason: "characters", length: name.length, max });
  }
  return { ok: true, plan: { city, name } };
}

/** `hooks.actions.ext`: the write extra tool `rename_city`. */
export const extActionHandler: ActionHandler<ActionOf<"ext">, RenamePlan> = {
  validate: validateRename,
  apply(ctx, _seat, plan): JsonObject {
    const city = Object.hasOwn(ctx.state.cities, plan.city)
      ? ctx.state.cities[plan.city]
      : undefined;
    if (city === undefined) throw new Error(`sandbox-1: rename of the missing ${plan.city}`);
    city.name = plan.name;
    ctx.emit({
      type: CITY_RENAMED,
      public: true,
      to: [],
      data: { city: plan.city, name: plan.name },
    });
    return { city: plan.city, name: plan.name };
  },
};
