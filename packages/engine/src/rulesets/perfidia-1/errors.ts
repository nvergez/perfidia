import type { Explainer, Fmt } from "@perfidia/engine/contracts";
import type { Violation } from "@perfidia/protocol";

// Wording of perfidia-1's own violation and warning codes (docs/architecture.md §7.3). Details are
// flat numbers and ids; the explainers turn them into a message and a hint with game times.
// Published wording is frozen with the version (§3.5): changing it needs a new ruleset version.

/** The origin or target city is besieged: details `{city, by, endsAt}`. */
export const CITY_BESIEGED = "CITY_BESIEGED";
/** Only the besieger may support a besieged city: details `{city, by, endsAt}`. */
export const NOT_BESIEGER = "NOT_BESIEGER";
/**
 * Warning on an accepted attack that carries settlers and lands on a capital before capital immunity
 * ends: details `{city, arriveAt, immuneUntil}`.
 */
export const CAPITAL_IMMUNE = "CAPITAL_IMMUNE";

type Details = Violation["details"];

function text(d: Details, key: string): string {
  const v = d[key];
  return v === undefined || v === null ? "?" : String(v);
}

function time(d: Details, key: string, f: Fmt): string {
  const v = d[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? f.time(v) : "?";
}

const cityBesieged: Explainer = (v, f) => {
  const city = text(v.details, "city");
  const by = text(v.details, "by");
  const until = time(v.details, "endsAt", f);
  return {
    message: `${city} is besieged by ${by} until ${until}: it cannot build, recruit or send anything, and only ${by} may send it support.`,
    hint: `Break the siege with an attack on ${city} from another city (a relief battle against ${by}'s garrison), or wait until ${until}. Units homed in ${city} that are away can come home and fight a homecoming battle.`,
  };
};

const notBesieger: Explainer = (v, f) => {
  const city = text(v.details, "city");
  const by = text(v.details, "by");
  const until = time(v.details, "endsAt", f);
  return {
    message: `${city} is besieged by ${by}: only ${by} may send it support until ${until}.`,
    hint: `To help ${city}'s owner, attack ${city} instead: a relief battle against ${by}'s garrison breaks the siege if it kills every settler in it.`,
  };
};

const capitalImmune: Explainer = (v, f) => {
  const city = text(v.details, "city");
  const lands = time(v.details, "arriveAt", f);
  const until = time(v.details, "immuneUntil", f);
  return {
    message: `${city} is a capital that cannot be besieged before ${until}, and this attack lands at ${lands}.`,
    hint: `A win will be a raid: the settlers come back home. To start a siege, land at ${until} or later.`,
  };
};

/** `Ruleset.errors`: the explainer of each perfidia-1 code. */
export const PERFIDIA_1_ERRORS: Readonly<Record<string, Explainer>> = Object.freeze({
  [CITY_BESIEGED]: cityBesieged,
  [NOT_BESIEGER]: notBesieger,
  [CAPITAL_IMMUNE]: capitalImmune,
});

/** `Ruleset.errorSamples`: one sample per code, for the explain tests and the fingerprint. */
export const PERFIDIA_1_ERROR_SAMPLES: readonly Violation[] = Object.freeze([
  Object.freeze({
    code: CITY_BESIEGED,
    details: Object.freeze({ city: "c14", by: "p2", endsAt: 223200 }),
  }),
  Object.freeze({
    code: NOT_BESIEGER,
    details: Object.freeze({ city: "c14", by: "p2", endsAt: 223200 }),
  }),
  Object.freeze({
    code: CAPITAL_IMMUNE,
    details: Object.freeze({ city: "c3", arriveAt: 160200, immuneUntil: 172800 }),
  }),
]);
