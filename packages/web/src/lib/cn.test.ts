import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { twMerge } from "tailwind-merge";
import { classGroup, cn, mergeClasses } from "./cn.ts";

// `cn` without tailwind-merge (docs/phase3.md §16): every ordered pair of the class names written
// under `src` (string literals: JSX `className`, `cn(…)`, `cva` tables) merges exactly as
// tailwind-merge 3.7 merges it, so the app's styles are unchanged. A class added later that the
// table in `cn.ts` misreads fails here, with the pair named.

const SRC = join(import.meta.dir, "..");
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const CLASS = /^!?-?[a-z[(][\w:/[\]().%#,=&>*@+!-]*$/;

/**
 * Classes a later view is likely to write (lists, sparklines, gradients, decorations, scrolling),
 * checked as if they were in `src` already: a new view seldom has to extend `cn.ts`.
 */
const LIKELY = `
  -rotate-90 -top-1 -translate-x-1/2 accent-primary align-baseline align-middle align-top
  animate-pulse animate-spin appearance-none aria-expanded:rotate-90 aspect-square
  aspect-video auto-rows-min backdrop-blur-sm basis-1/2 bg-[length:4px_4px] bg-center bg-cover
  bg-linear-to-r bg-no-repeat bg-transparent blur-sm border-2 border-collapse border-dashed
  border-dotted border-l-2 border-spacing-2 border-t border-transparent box-border box-content
  break-all break-words capitalize caret-primary clear-both col-span-2 col-start-2 columns-2
  content-between content-center content-none content-start cursor-default cursor-pointer
  data-[state=open]:rotate-180 decoration-2 decoration-dotted delay-100 diagonal-fractions
  divide-border divide-x divide-y divide-y-2 drop-shadow drop-shadow-md drop-shadow-primary
  duration-200 ease-out even:bg-card field-sizing-content fill-current fill-none first:pt-0
  flex-1 flex-auto flex-none float-left float-right font-[450] font-medium font-mono font-sans
  font-semibold from-10% from-primary gap-1 gap-x-2 gap-y-1 grid-cols-2 grid-cols-[1fr_auto]
  grid-flow-col grid-flow-row group-hover:opacity-100 grow grow-0 h-[3px] h-dvh h-px
  hyphens-auto indent-2 inset-0 inset-x-0 isolate isolation-auto italic items-baseline
  justify-between justify-self-end last:border-0 leading-none leading-tight left-1/2
  line-clamp-2 line-clamp-3 line-through list-decimal list-disc list-inside list-none max-h-64
  max-w-prose md:grid-cols-3 min-h-svh min-w-0 mix-blend-multiply
  motion-reduce:transition-none motion-safe:animate-pulse no-underline normal-case not-italic
  not-sr-only object-contain object-cover odd:bg-muted opacity-0 opacity-50 order-1 order-last
  ordinal origin-center origin-left origin-top outline-2 outline-hidden outline-none
  outline-offset-2 overflow-auto overflow-hidden overflow-x-auto overflow-y-auto
  overscroll-contain peer-checked:bg-primary place-items-center pointer-events-auto
  pointer-events-none resize-none resize-y ring-1 ring-2 ring-inset ring-offset-2
  ring-offset-background ring-ring rotate-90 rounded-full rounded-sm rounded-t-md row-span-2
  scale-100 scale-95 scale-x-50 scale-y-75 scroll-m-2 scroll-mt-4 scroll-p-2 select-none
  select-text self-center self-start shadow-md shadow-none shadow-sm shrink-0 size-3 skew-x-2
  slashed-zero sm:max-w-lg snap-always snap-center snap-mandatory snap-start snap-x snap-y
  space-x-2 space-y-1 sr-only stroke-2 stroke-[1.5] stroke-current stroke-none table-auto
  table-fixed tabular-nums text-2xl text-[0.65rem] text-[10px] text-balance text-base
  text-center text-clip text-ellipsis text-left text-lg text-nowrap text-pretty text-primary
  text-right text-shadow-primary text-shadow-sm text-sm text-xs to-90% to-transparent top-0
  touch-none touch-pan-y tracking-tight tracking-wider transition-all transition-colors
  transition-none transition-opacity translate-y-1 truncate underline underline-offset-2
  uppercase via-muted w-[calc(100%-2rem)] w-px whitespace-nowrap whitespace-pre-wrap
  will-change-auto will-change-transform wrap-anywhere wrap-break-word z-10 z-50
`.split(/\s+/);

/** Every class-like word of a string literal in a web source (tests excluded). */
function vocabulary(): string[] {
  const out = new Set<string>();
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })) {
    // Tests, and this module's group names (not classes).
    if (/\.test\.tsx?$/.test(file) || file === "lib/cn.ts") continue;
    const text = readFileSync(join(SRC, file), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const m of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
      for (const w of (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/)) {
        if (w.length > 1 && CLASS.test(w) && !w.includes("${")) out.add(w);
      }
    }
  }
  for (const w of LIKELY) if (w !== "") out.add(w);
  return [...out].toSorted(byText);
}

/** The variants of a class (`md:hover:` → "hover,md"), to compare only classes that may conflict. */
function variantsOf(cls: string): string {
  const parts = cls.split(/:(?![^[]*\])/);
  return parts.slice(0, -1).toSorted(byText).join(",");
}

/** A class without its variants and `!`, as `classGroup` takes it (`md:!p-2` → `p-2`). */
function utilityOf(cls: string): string {
  const base = cls.split(/:(?![^[]*\])/).at(-1) ?? cls;
  return base.replace(/^!/, "").replace(/!$/, "");
}

describe("cn", () => {
  test("merges every pair of the app's classes as tailwind-merge does", () => {
    const words = vocabulary();
    expect(words.length).toBeGreaterThan(400);
    // Only the classes tailwind-merge knows can conflict; it keeps a repeated unknown one twice.
    const known = words.filter((w) => twMerge(`${w} ${w}`) === w);
    expect(known.length).toBeGreaterThan(300);
    const buckets = new Map<string, string[]>();
    for (const w of known) {
      const k = variantsOf(w);
      buckets.set(k, [...(buckets.get(k) ?? []), w]);
    }
    // Every class against one class of each of this module's groups (and every class it leaves
    // ungrouped), both ways: within a group the relation to the others is the group's, so this
    // covers every pair at a fraction of the cost.
    const wrong: string[] = [];
    for (const group of buckets.values()) {
      const reps = new Map<string, string>();
      for (const w of group) {
        const g = classGroup(utilityOf(w));
        reps.set(g === null ? `?${w}` : g, reps.get(g ?? `?${w}`) ?? w);
      }
      for (const a of group) {
        for (const b of reps.values()) {
          for (const list of [`${a} ${b}`, `${b} ${a}`]) {
            const want = twMerge(list);
            if (mergeClasses(list) !== want) wrong.push(`${list} → ${want}`);
          }
        }
      }
    }
    for (const w of words) {
      if (mergeClasses(`${w} ${w}`) !== twMerge(`${w} ${w}`)) wrong.push(`${w} ${w} (repeated)`);
    }
    expect(wrong).toEqual([]);
  });

  test("the shadcn cases", () => {
    expect(cn("px-2 py-1", "p-3")).toBe("p-3");
    expect(cn("p-3", "px-2")).toBe("p-3 px-2");
    expect(cn("h-8 px-3 text-sm", "h-7 text-xs")).toBe("px-3 h-7 text-xs");
    expect(cn("text-muted-foreground", "text-xs")).toBe("text-muted-foreground text-xs");
    expect(cn("border border-input", "border-destructive/50")).toBe("border border-destructive/50");
    expect(cn("size-4", "w-6")).toBe("size-4 w-6");
    expect(cn("w-6", "size-4")).toBe("size-4");
    expect(cn("hover:bg-accent", "hover:bg-primary", "bg-card")).toBe("hover:bg-primary bg-card");
    expect(cn("animate-in fade-in-0", "animate-in")).toBe("animate-in fade-in-0 animate-in");
    expect(cn("animate-pulse", "animate-spin")).toBe("animate-spin");
    expect(cn("a", false, null, undefined, { b: true, c: false }, ["d"])).toBe("a b d");
  });
});
