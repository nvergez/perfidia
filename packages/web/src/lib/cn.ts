import { clsx, type ClassValue } from "clsx";

// Class names joined, later Tailwind utilities winning over earlier conflicting ones (the shadcn
// `cn`). It replaces `tailwind-merge` (5.2 KB gzipped of the initial load, docs/phase3.md §16.1)
// with the same algorithm over the class groups this app uses: walk the classes from the last,
// keep a class unless a later one of the same group (under the same variants and `!`) was kept,
// and let a kept class claim the groups it overrides (`p` claims `px`, `size` claims `w` and `h`).
// A class of no known group always stays. `cn.test.ts` checks the classes written in `src` against
// `tailwind-merge` itself, pair by pair: a new class that these tables misread fails it.

const words = (s: string): string[] => s.split(" ");
const set = (s: string): ReadonlySet<string> => new Set(words(s));

/** Stems whose value is a size, a length or a fraction (`px-2`, `w-1/2`, `top-[3px]`). */
const SIZED = words(
  "p px py pt pr pb pl ps pe m mx my mt mr mb ml ms me w h size min-w max-w min-h max-h inset inset-x inset-y top right bottom left start end basis translate-x translate-y gap gap-x gap-y space-x space-y indent scroll-m scroll-mx scroll-my scroll-mt scroll-mr scroll-mb scroll-ml scroll-ms scroll-me scroll-p scroll-px scroll-py scroll-pt scroll-pr scroll-pb scroll-pl scroll-ps scroll-pe border-spacing border-spacing-x border-spacing-y",
);
/** Stems that are their own group whatever their value. */
const ANY = words(
  "z order opacity duration delay ease cursor select pointer-events whitespace leading tracking line-clamp aspect grid-cols grid-rows auto-rows auto-cols col-start col-end row-start row-end underline-offset outline-offset rotate scale scale-x scale-y skew skew-x skew-y items self justify-items justify-self place-items place-content place-self align overscroll overscroll-x overscroll-y overflow overflow-x overflow-y fill grow shrink accent caret origin will-change float clear mix-blend bg-blend box box-decoration appearance columns hyphens wrap grid-flow field-sizing",
);
/** Stems with rules of their own (`stemGroup`). */
const SPECIAL = words(
  "animate blur backdrop-blur resize transition col row justify rounded rounded-t rounded-r rounded-b rounded-l rounded-s rounded-e rounded-tl rounded-tr rounded-br rounded-bl flex text text-shadow font bg border border-x border-y border-t border-r border-b border-l border-s border-e ring ring-offset outline shadow drop-shadow touch break snap stroke content list decoration object divide-x divide-y divide from via to",
);
/** Every stem, longest first (`inset-x` before `inset`). */
const STEMS = [...SIZED, ...ANY, ...SPECIAL].toSorted((a, b) => b.length - a.length);
const SIZED_SET = new Set(SIZED);
const ANY_SET = new Set(ANY);

const TEXT_SIZES = set("xs sm base lg xl 2xl 3xl 4xl 5xl 6xl 7xl 8xl 9xl");
const FONT_WEIGHTS = set("thin extralight light normal medium semibold bold extrabold black");
const DISPLAYS = set(
  "block inline-block inline flex inline-flex table inline-table table-cell table-row flow-root grid inline-grid contents list-item hidden",
);
const POSITIONS = set("static fixed absolute relative sticky");
const SHADOW_SIZES = set(" 2xs xs sm md lg xl 2xl none inner");
const LINE_STYLES = set("solid dashed dotted double hidden none");
const ALIGNS = set("left center right justify start end");
const WRAPS = set("wrap nowrap balance pretty");
const ANIMATIONS = set("none spin ping pulse bounce");
const BREAKS = set("normal words all keep");
const BG_POSITIONS = set(
  "center top bottom left right top-left top-right bottom-left bottom-right left-top left-bottom right-top right-bottom",
);
const BG_REPEATS = set("repeat no-repeat repeat-x repeat-y repeat-round repeat-space");
const BG_SIZES = set("auto cover contain");
const BG_ATTACHMENTS = set("fixed local scroll");
const OBJECT_FITS = set("contain cover fill none scale-down");
const DECORATION_STYLES = set("solid double dotted dashed wavy");
const STOPS = set("from via to");

/** `group utility utility…`: whole utilities and their groups. */
const SINGLE: ReadonlyMap<string, string> = new Map(
  [
    "sr sr-only not-sr-only",
    "visibility visible invisible collapse",
    "text-overflow truncate text-ellipsis text-clip",
    "text-transform uppercase lowercase capitalize normal-case",
    "font-style italic not-italic",
    "text-decoration underline overline line-through no-underline",
    "fvn-spacing tabular-nums proportional-nums",
    "fvn-figure lining-nums oldstyle-nums",
    "fvn-normal normal-nums",
    "transform transform transform-gpu transform-cpu transform-none",
    "filter filter filter-none",
    "ring-w-inset ring-inset",
    "outline-style outline-hidden",
    "fvn-ordinal ordinal",
    "fvn-slashed-zero slashed-zero",
    "fvn-fraction diagonal-fractions stacked-fractions",
    "isolation isolate isolation-auto",
    "table-layout table-auto table-fixed",
    "border-collapse border-collapse border-separate",
    "grow grow",
    "shrink shrink",
  ].flatMap((line) => {
    const [group = "", ...us] = words(line);
    return us.map((u) => [u, group] as const);
  }),
);

/** `[…]` and `(…)` values (an arbitrary value or a CSS variable). */
const isArbitrary = (v: string): boolean =>
  (v.startsWith("[") && v.endsWith("]")) || (v.startsWith("(") && v.endsWith(")"));
const LENGTH =
  /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^0$/;
const COLOR_FN = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix)\(.+\)$/;
const IMAGE =
  /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/;
const SHADOW = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/;
const SIZE_WORD =
  /^(\d+(\.\d+)?|\d+\/\d+|px|full|auto|screen|fit|min|max|dvh|dvw|svh|lvh|lh|xs|sm|md|lg|xl|[2-7]xl|3xs|2xs|prose|none)$/;
const inner = (v: string): string => v.slice(1, -1);
const isArbitraryLength = (v: string): boolean =>
  v.startsWith("[") && v.endsWith("]") && LENGTH.test(inner(v)) && !COLOR_FN.test(inner(v));
const isNumber = (v: string): boolean => /^\d+(\.\d+)?$/.test(v);
/** A width: nothing (`border`), a number or an arbitrary length. */
const isWidth = (v: string): boolean => v === "" || isNumber(v) || isArbitraryLength(v);

/** A utility's group after its stem (`px` of `px-2`); null: no group (never conflicts). */
function stemGroup(stem: string, v: string): string | null {
  if (SIZED_SET.has(stem)) return v !== "" && (isArbitrary(v) || SIZE_WORD.test(v)) ? stem : null;
  if (ANY_SET.has(stem)) return v === "" ? null : stem;
  if (stem.startsWith("rounded")) return stem;
  if (stem.startsWith("border")) {
    const side = stem.slice(6);
    if (isWidth(v)) return `border-w${side}`;
    return side === "" && LINE_STYLES.has(v) ? "border-style" : `border-color${side}`;
  }
  if (STOPS.has(stem)) {
    // Gradient stops: a colour, or a position (`from-10%`).
    if (v.endsWith("%")) return `${stem}-pos`;
    return v === "" ? null : stem;
  }
  switch (stem) {
    case "stroke":
      if (isNumber(v) || isArbitraryLength(v) || (v.startsWith("[") && isNumber(inner(v)))) {
        return "stroke-w";
      }
      return v === "" ? null : "stroke";
    case "snap":
      if (v === "x" || v === "y" || v === "both" || v === "none") return "snap-type";
      if (v === "mandatory" || v === "proximity") return "snap-strictness";
      if (v === "start" || v === "end" || v === "center" || v === "align-none") {
        return "snap-align";
      }
      return v === "normal" || v === "always" ? "snap-stop" : null;
    case "content":
      // `content-none` and `content-['…']` set `content`; the others align content.
      if (v === "none" || isArbitrary(v)) return "content";
      return v === "" ? null : "align-content";
    case "list":
      if (v === "inside" || v === "outside") return "list-position";
      return v === "" ? null : "list-type";
    case "decoration":
      if (DECORATION_STYLES.has(v)) return "decoration-style";
      if (isNumber(v) || isArbitraryLength(v) || v === "auto" || v === "from-font") {
        return "decoration-w";
      }
      return v === "" ? null : "decoration-color";
    case "object":
      if (OBJECT_FITS.has(v)) return "object-fit";
      return v === "" ? null : "object-position";
    case "divide-x":
    case "divide-y":
      return v === "reverse" ? `${stem}-reverse` : isWidth(v) ? stem : null;
    case "divide":
      if (LINE_STYLES.has(v)) return "divide-style";
      return v === "" ? null : "divide-color";
    case "text-shadow":
    case "drop-shadow":
      if (v === "" || SHADOW_SIZES.has(v)) return stem;
      return `${stem}-color`;
    case "animate":
      return ANIMATIONS.has(v) || isArbitrary(v) ? stem : null;
    case "col":
    case "row":
      return v.startsWith("span-") || v === "auto" ? `${stem}-start-end` : null;
    case "justify":
      return v === "" ? null : "justify-content";
    case "flex":
      if (v === "row" || v === "col" || v === "row-reverse" || v === "col-reverse") {
        return "flex-direction";
      }
      if (v === "wrap" || v === "nowrap" || v === "wrap-reverse") return "flex-wrap";
      return v === "" ? null : "flex";
    case "text":
      if (TEXT_SIZES.has(v) || isArbitraryLength(v)) return "font-size";
      if (ALIGNS.has(v)) return "text-alignment";
      if (WRAPS.has(v)) return "text-wrap";
      return v === "" ? null : "text-color";
    case "font":
      if (FONT_WEIGHTS.has(v) || isNumber(v)) return "font-weight";
      if (v.startsWith("[") && isNumber(inner(v))) return "font-weight";
      return v === "" ? null : "font-family";
    case "bg":
      if (BG_POSITIONS.has(v) || v.startsWith("position-")) return "bg-position";
      if (BG_REPEATS.has(v)) return "bg-repeat";
      if (BG_SIZES.has(v) || v.startsWith("size-")) return "bg-size";
      if (BG_ATTACHMENTS.has(v)) return "bg-attachment";
      if (v.startsWith("clip-")) return "bg-clip";
      if (v.startsWith("origin-")) return "bg-origin";
      if (v.startsWith("[position:")) return "bg-position";
      if (v.startsWith("[length:") || v.startsWith("[size:")) return "bg-size";
      if (v === "none" || /^(linear|radial|conic)/.test(v)) return "bg-image";
      if (v.startsWith("[") && IMAGE.test(inner(v))) return "bg-image";
      return v === "" ? null : "bg-color";
    case "ring":
      return isWidth(v) ? "ring-w" : "ring-color";
    case "ring-offset":
      if (isNumber(v) || isArbitraryLength(v)) return "ring-offset-w";
      return v === "" ? null : "ring-offset-color";
    case "outline":
      if (isWidth(v)) return "outline-w";
      return LINE_STYLES.has(v) ? "outline-style" : "outline-color";
    case "shadow":
      if (SHADOW_SIZES.has(v) || (v.startsWith("[") && SHADOW.test(inner(v)))) return "shadow";
      return "shadow-color";
    case "touch":
      if (v === "auto" || v === "none" || v === "manipulation") return "touch";
      if (v === "pan-x" || v === "pan-left" || v === "pan-right") return "touch-x";
      if (v === "pan-y" || v === "pan-up" || v === "pan-down") return "touch-y";
      return v === "pinch-zoom" ? "touch-pz" : null;
    case "break":
      return BREAKS.has(v) ? "break" : null;
    default:
      // blur, backdrop-blur, resize, transition: any value, or none.
      return stem;
  }
}

/** Groups by utility, and merged lists by input (both bounded: cleared when full). */
const groups = new Map<string, string | null>();
const merged = new Map<string, string>();
const CACHE_MAX = 2_000;

/** The group of a utility without variants or `!` (`px-2` → `px`); null: none. */
export function classGroup(utility: string): string | null {
  const hit = groups.get(utility);
  if (hit !== undefined) return hit;
  const group = findGroup(utility);
  if (groups.size >= CACHE_MAX) groups.clear();
  groups.set(utility, group);
  return group;
}

function findGroup(utility: string): string | null {
  const u = utility.startsWith("-") ? utility.slice(1) : utility;
  const single = SINGLE.get(u);
  if (single !== undefined) return single;
  if (DISPLAYS.has(u)) return "display";
  if (POSITIONS.has(u)) return "position";
  if (u.startsWith("[") && u.endsWith("]")) {
    const colon = u.indexOf(":");
    return colon > 1 ? `[${u.slice(1, colon)}]` : null;
  }
  for (const stem of STEMS) {
    if (u === stem) return stemGroup(stem, "");
    if (u.startsWith(`${stem}-`)) return stemGroup(stem, u.slice(stem.length + 1));
  }
  return null;
}

/** `group a b c`: a kept class of `group` claims `a`, `b` and `c` too. */
const CONFLICTS: ReadonlyMap<string, readonly string[]> = new Map(
  [
    "overflow overflow-x overflow-y",
    "overscroll overscroll-x overscroll-y",
    "inset inset-x inset-y start end top right bottom left",
    "inset-x start end right left",
    "inset-y top bottom",
    "flex basis grow shrink",
    "gap gap-x gap-y",
    "p px py ps pe pt pr pb pl",
    "px ps pe pr pl",
    "py pt pb",
    "m mx my ms me mt mr mb ml",
    "mx ms me mr ml",
    "my mt mb",
    "size w h",
    "font-size leading",
    "fvn-normal fvn-ordinal fvn-slashed-zero fvn-figure fvn-spacing fvn-fraction",
    "fvn-ordinal fvn-normal",
    "fvn-slashed-zero fvn-normal",
    "fvn-figure fvn-normal",
    "fvn-spacing fvn-normal",
    "fvn-fraction fvn-normal",
    "scroll-m scroll-mx scroll-my scroll-ms scroll-me scroll-mt scroll-mr scroll-mb scroll-ml",
    "scroll-mx scroll-mr scroll-ml",
    "scroll-my scroll-mt scroll-mb",
    "scroll-p scroll-px scroll-py scroll-ps scroll-pe scroll-pt scroll-pr scroll-pb scroll-pl",
    "scroll-px scroll-pr scroll-pl",
    "scroll-py scroll-pt scroll-pb",
    "border-spacing border-spacing-x border-spacing-y",
    "line-clamp display overflow",
    "rounded rounded-s rounded-e rounded-t rounded-r rounded-b rounded-l rounded-tl rounded-tr rounded-br rounded-bl",
    "rounded-t rounded-tl rounded-tr",
    "rounded-r rounded-tr rounded-br",
    "rounded-b rounded-br rounded-bl",
    "rounded-l rounded-tl rounded-bl",
    "border-w border-w-x border-w-y border-w-s border-w-e border-w-t border-w-r border-w-b border-w-l",
    "border-w-x border-w-s border-w-e border-w-r border-w-l",
    "border-w-y border-w-t border-w-b",
    "border-color border-color-x border-color-y border-color-s border-color-e border-color-t border-color-r border-color-b border-color-l",
    "border-color-x border-color-s border-color-e border-color-r border-color-l",
    "border-color-y border-color-t border-color-b",
    "touch touch-x touch-y touch-pz",
    "touch-x touch",
    "touch-y touch",
    "touch-pz touch",
  ].map((line) => {
    const [group = "", ...rest] = words(line);
    return [group, rest] as const;
  }),
);

/** Variants (`md:`, `hover:`, `[&>svg]:`), split on colons outside brackets and parentheses. */
function splitVariants(cls: string): { readonly variants: string[]; readonly base: string } {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < cls.length; i += 1) {
    const ch = cls[i];
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    else if (ch === ":" && depth === 0) {
      parts.push(cls.slice(from, i));
      from = i + 1;
    }
  }
  return { variants: parts, base: cls.slice(from) };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Variants in a canonical order: sorted, except arbitrary ones, which keep their place. */
function variantKey(variants: readonly string[]): string {
  const out: string[] = [];
  let run: string[] = [];
  for (const v of variants) {
    if (v.startsWith("[")) {
      out.push(...run.toSorted(byText), v);
      run = [];
    } else run.push(v);
  }
  out.push(...run.toSorted(byText));
  return out.join(":");
}

/** Merges a space-separated class list: later conflicting utilities win (see the module comment). */
export function mergeClasses(list: string): string {
  const hit = merged.get(list);
  if (hit !== undefined) return hit;
  const out = mergeList(list);
  if (merged.size >= CACHE_MAX) merged.clear();
  merged.set(list, out);
  return out;
}

function mergeList(list: string): string {
  const classes = list.trim().split(/\s+/);
  const claimed = new Set<string>();
  const kept: string[] = [];
  for (let i = classes.length - 1; i >= 0; i -= 1) {
    const cls = classes[i] ?? "";
    if (cls === "") continue;
    const { variants, base } = splitVariants(cls);
    let utility = base;
    let important = false;
    if (utility.startsWith("!")) {
      important = true;
      utility = utility.slice(1);
    } else if (utility.endsWith("!")) {
      important = true;
      utility = utility.slice(0, -1);
    }
    const slash = utility.lastIndexOf("/");
    let group = classGroup(utility);
    if (group === null && slash > 0 && !utility.endsWith("]")) {
      group = classGroup(utility.slice(0, slash));
    }
    if (group === null) {
      kept.push(cls);
      continue;
    }
    const prefix = `${variantKey(variants)}${important ? "!" : ""}|`;
    if (claimed.has(prefix + group)) continue;
    claimed.add(prefix + group);
    for (const g of CONFLICTS.get(group) ?? []) claimed.add(prefix + g);
    kept.push(cls);
  }
  return kept.toReversed().join(" ");
}

/** Class names joined, later Tailwind utilities winning over earlier conflicting ones (shadcn). */
export function cn(...inputs: ClassValue[]): string {
  return mergeClasses(clsx(inputs));
}
