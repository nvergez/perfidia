import { defaultSkin } from "./default.ts";
import { perfidiaSkin } from "./perfidia-1.ts";
import type { Skin } from "./types.ts";

// The skin of a ruleset ref (`perfidia-1@1.1.0`): by ruleset id, the default skin otherwise. Skins
// are made once per ref.

export type * from "./types.ts";

const made = new Map<string, Skin>();

export function skinFor(ruleset: string): Skin {
  let skin = made.get(ruleset);
  if (skin === undefined) {
    const id = ruleset.split("@")[0] ?? "";
    skin = id === "perfidia-1" ? perfidiaSkin(ruleset) : defaultSkin(ruleset);
    made.set(ruleset, skin);
  }
  return skin;
}
