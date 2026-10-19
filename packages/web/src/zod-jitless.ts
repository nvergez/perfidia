// Zod (behind the protocol's schemas) calls the Function constructor once when it builds its first
// object schema, to learn whether it may compile parsers. The page's CSP (`script-src 'self'`)
// refuses it: Zod carries on without compiling, but the browser records a CSP violation on every
// page load (and would send a report once a `report-to` is set). Zod takes its global config from
// `globalThis.__zod_globalConfig` when it loads and skips the probe under `jitless`, so this module
// sets that flag; `main.tsx` imports it first, before anything that loads Zod. The e2e smoke test
// fails on any `securitypolicyviolation`.

const KEY = "__zod_globalConfig";
const current: unknown = Reflect.get(globalThis, KEY);
Reflect.set(globalThis, KEY, {
  ...(typeof current === "object" && current !== null ? current : {}),
  jitless: true,
});

/** Set by this module, before Zod loads. */
export const ZOD_JITLESS = true;
