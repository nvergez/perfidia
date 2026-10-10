import type { Explainer, Fmt } from "@perfidia/engine/contracts";
import type { Violation } from "@perfidia/protocol";

// Wording of sandbox-1's own violation codes (docs/architecture.md §7.3). Details are flat numbers,
// ids and short labels; the explainers turn them into a message and a hint.

/**
 * `rename_city` with a name that is empty, too long, or uses other characters than ASCII letters,
 * digits, space, `-`, `_` and `.`: details `{city, reason: "length" | "characters", length, max}`.
 */
export const CITY_NAME_INVALID = "CITY_NAME_INVALID";

type Details = Violation["details"];

function text(d: Details, key: string): string {
  const v = d[key];
  return v === undefined || v === null ? "?" : String(v);
}

const ALLOWED = "ASCII letters, digits, space, '-', '_' and '.'";

const cityNameInvalid: Explainer = (v, _f: Fmt) => {
  const city = text(v.details, "city");
  const max = text(v.details, "max");
  const length = text(v.details, "length");
  if (v.details["reason"] === "characters") {
    return {
      message: `The new name of ${city} uses characters that city names do not allow.`,
      hint: `Use only ${ALLOWED}, 1 to ${max} characters.`,
    };
  }
  return {
    message: `The new name of ${city} has ${length} characters; city names have 1 to ${max}.`,
    hint: `Choose a name of 1 to ${max} characters among ${ALLOWED}.`,
  };
};

/** `Ruleset.errors`: the explainer of each sandbox-1 code. */
export const SANDBOX_1_ERRORS = Object.freeze({
  [CITY_NAME_INVALID]: cityNameInvalid,
}) satisfies Readonly<Record<string, Explainer>>;

/** `Ruleset.errorSamples`: the samples of each code, for the explain tests and the fingerprint. */
export const SANDBOX_1_ERROR_SAMPLES: readonly Violation[] = Object.freeze([
  Object.freeze({
    code: CITY_NAME_INVALID,
    details: Object.freeze({ city: "c3", reason: "length", length: 21, max: 16 }),
  }),
  Object.freeze({
    code: CITY_NAME_INVALID,
    details: Object.freeze({ city: "c3", reason: "characters", length: 6, max: 16 }),
  }),
]);
