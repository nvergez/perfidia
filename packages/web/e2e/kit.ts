// The browser smoke test's kit (`smoke.test.ts`, docs/phase3.md §15.5 and §16.4): the material
// (the war golden, a fake run, hostile text planted in a copy of it), the shared environment (an
// in-process server over a fresh build, one Chromium), and the helpers every check uses: `open` a
// page as a returning viewer with its console errors and CSP violations recorded, wait for the map
// or a clock reading, seek with the keyboard, and check that the DOM holds no HTML sink. The Pass C
// checks live in `checks/*.ts`, one file per feature agent, registered by `smoke.test.ts`.

// oxlint-disable no-await-in-loop -- browser steps follow each other on purpose
import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, createReplay, fnv1a64 } from "@perfidia/engine";
import { LogLineSchema, type LogLine } from "@perfidia/protocol";
import type { Browser, BrowserContext, Page } from "playwright-core";

export const WEB = join(import.meta.dir, "..");
export const WAR_GOLDEN = join(
  WEB,
  "..",
  "sim",
  "fixtures",
  "golden",
  "perfidia-1@1.1.0",
  "lockstep-6p-6d-war.jsonl.gz",
);
/** `bun run stats`'s entry (phase 4 Pass 3): the smoke test aggregates the fake run with it. */
export const STATS_CLI = join(WEB, "..", "server", "src", "stats", "cli.ts");
export const DAY = 86_400;
export const HOUR = 3_600;

/** Player text a page must show as text, never as markup, a script or a link. */
export const HOSTILE = {
  img: '<img src=x onerror="window.__xss=1">',
  script: "<script>window.__xss=2</script>",
  js: "javascript:window.__xss=3",
  url: "https://evil.example/phish",
  bidi: "‮gnp.exe",
  attr: '" onmouseover="window.__xss=4" x="',
} as const;

export type JsonObject = Record<string, unknown>;
export const isObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Rewrites each JSON line of a file through `edit` (lines it returns unchanged stay byte-equal). */
export function editLines(path: string, edit: (o: JsonObject) => boolean): void {
  const out = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      const o: unknown = JSON.parse(line);
      return isObject(o) && edit(o) ? JSON.stringify(o) : line;
    });
  writeFileSync(path, out.join("\n"));
}

/** A message the log did not have, sent by `seat` right after its first accepted action. */
export interface ExtraMessage {
  readonly seat: string;
  readonly to: string;
  readonly text: string;
}

/**
 * Gives a log edited where the engine state sees it (message and proposal text) the checkpoint and
 * end hashes a replay of the edited log produces, so Level E holds again; with `extra`, also adds a
 * message (an act line, its events as the engine produces them, the later lines renumbered). The
 * other lines stay byte-equal. Throws on any other divergence (the edit changed more than text).
 */
export function rehash(path: string, extra?: ExtraMessage): void {
  const raw = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  const header = LogLineSchema.parse(JSON.parse(raw[0] ?? ""));
  if (header.k !== "header") throw new Error(`${path}: no header line`);
  out.push(raw[0] ?? "");
  const produced = new Map<number, string>();
  let pushing: LogLine | null = null;
  const replay = createReplay(header, {
    onCheckpoint(hour, r) {
      // `stateHash`, on the read view (the engine is exactly in checkpoint state here).
      const h = fnv1a64(canonicalJson(r.state));
      produced.set(hour, h);
      // The checkpoint of the ckpt line being pushed: its hash is compared right after this call.
      if (pushing?.k === "ckpt" && pushing.hour === hour) pushing.h = h;
    },
  });
  const push = (line: LogLine, at: number): ReturnType<typeof replay.push> => {
    pushing = line;
    const step = replay.push(line);
    pushing = null;
    if (!step.ok && !(line.k === "end" && replay.divergence?.kind === "end")) {
      throw new Error(`${path}: line ${at} diverges: ${JSON.stringify(replay.divergence)}`);
    }
    return step;
  };
  // The extra message goes in after `after`'s events (before the next line that is not an event).
  let after: { readonly t: number; readonly n: number; readonly turn: number; rt: number } | null =
    null;
  let shift = 0;
  for (let i = 1; i < raw.length; i += 1) {
    const text = raw[i] ?? "";
    if (text === "") {
      out.push(text);
      continue;
    }
    const o: unknown = JSON.parse(text);
    const line = LogLineSchema.parse(o);
    if (after !== null && line.k !== "ev" && extra !== undefined) {
      const act = LogLineSchema.parse({
        a: { text: extra.text, to: [extra.to], type: "send_message" },
        i: 0,
        k: "act",
        n: after.n + 1,
        r: { ok: true },
        rt: after.rt,
        seat: extra.seat,
        t: after.t,
        tool: "send_message",
        turn: after.turn,
      });
      out.push(JSON.stringify(act));
      for (const e of push(act, i).events) {
        const ev = LogLineSchema.parse({ e, k: "ev", t: after.t });
        push(ev, i);
        out.push(JSON.stringify(ev));
      }
      after = null;
      shift = 1;
    }
    let edited = false;
    if (
      shift > 0 &&
      (line.k === "act" || line.k === "gw" || line.k === "obs" || line.k === "note")
    ) {
      line.n += shift;
      edited = true;
    }
    if (line.k === "ckpt") {
      const h = produced.get(line.hour) ?? line.h;
      edited ||= h !== line.h;
      line.h = h;
    }
    const before = line.k === "ckpt" || line.k === "end" ? line.h : null;
    push(line, i + 1);
    if (line.k === "end" && replay.divergence?.kind === "end") line.h = replay.divergence.actual;
    if ((line.k === "ckpt" || line.k === "end") && line.h !== before) edited = true;
    if (
      extra !== undefined &&
      shift === 0 &&
      line.k === "act" &&
      line.seat === extra.seat &&
      line.r.ok
    ) {
      after = { t: line.t, n: line.n, turn: line.turn, rt: line.rt };
    }
    if (!edited || !isObject(o)) {
      out.push(text);
      continue;
    }
    // The line as written, its keys in their order, with the new number and hash.
    const fresh: JsonObject = { ...o };
    if ("n" in line) fresh.n = line.n;
    if (line.k === "ckpt" || line.k === "end") fresh.h = line.h;
    out.push(JSON.stringify(fresh));
  }
  writeFileSync(path, out.join("\n"));
}

const hostileMessage = (text: string): string => `${HOSTILE.img} ${HOSTILE.js} ${text}`;
const hostileProposal = (text: string): string => `${HOSTILE.attr} ${HOSTILE.url} ${text}`;

/** Hostile names where the harness and the log hold tool names and labels (p1's turn 1). */
export const HOSTILE_TOOL = `${HOSTILE.img}${HOSTILE.bidi}`;
export const HOSTILE_LOGGED_TOOL = `${HOSTILE.script}${HOSTILE.bidi}`;
export const HOSTILE_LABEL = `<b>cat</b>${HOSTILE.bidi}`;

/**
 * Plants hostile text in a copy of a fake run: p1's profile, messages and proposals (re-hashed),
 * p1's thoughts and notes (each note a new version), its replies' reasoning and text; in p1's
 * turn 1, a tool name in its first reply and in its first read (`obs`) line, and a refusal's
 * category and an error's kind in its first model call.
 */
export function plantHostile(dir: string): void {
  const seatsPath = join(dir, "seats.json");
  const seats: unknown = JSON.parse(readFileSync(seatsPath, "utf8"));
  const list = isObject(seats) && Array.isArray(seats.seats) ? seats.seats : [];
  for (const seat of list) {
    if (!isObject(seat) || seat.seat !== "p1" || !isObject(seat.profile)) continue;
    seat.profile.goal = `${HOSTILE.img} goal`;
    seat.profile.temperament = HOSTILE.script;
    seat.profile.word = `${HOSTILE.js} ${HOSTILE.url}`;
    seat.profile.style = `${HOSTILE.bidi}${HOSTILE.attr}`;
  }
  writeFileSync(seatsPath, JSON.stringify(seats, null, 2));
  let notes = 0;
  let obs = false;
  editLines(join(dir, "match.jsonl"), (o) => {
    const a = o.a;
    if (o.k === "act" && isObject(a) && typeof a.text === "string") {
      if (a.type === "send_message") a.text = hostileMessage(a.text);
      else if (a.type === "propose") a.text = hostileProposal(a.text);
      else return false;
      return true;
    }
    const e = o.e;
    if (o.k === "ev" && isObject(e) && isObject(e.data) && typeof e.data.text === "string") {
      if (e.type === "message") e.data.text = hostileMessage(e.data.text);
      else if (e.type === "proposal") e.data.text = hostileProposal(e.data.text);
      else return false;
      return true;
    }
    if (o.seat !== "p1") return false;
    if (o.k === "turn" && typeof o.thought === "string") {
      o.thought = `${HOSTILE.img} ${HOSTILE.script} ${HOSTILE.url}`;
      return true;
    }
    if (o.k === "note" && typeof o.text === "string") {
      notes += 1;
      o.text = `${HOSTILE.attr} ${HOSTILE.js} ${HOSTILE.bidi}\n${HOSTILE.img} version ${notes}`;
      return true;
    }
    if (o.k === "obs" && o.turn === 1 && !obs) {
      obs = true;
      o.tool = HOSTILE_LOGGED_TOOL;
      return true;
    }
    return false;
  });
  // A 1-day fake run has no message yet (the bots write once at war): p1 sends one.
  rehash(join(dir, "match.jsonl"), {
    seat: "p1",
    to: "p2",
    text: hostileMessage(`${HOSTILE.script} ${HOSTILE.bidi}`),
  });
  editLines(join(dir, "replies.jsonl"), (o) => {
    if (o.seat !== "p1") return false;
    o.reasoning = [`${HOSTILE.script} reasoning ${HOSTILE.url}`];
    o.text = [HOSTILE.img];
    const first: unknown = Array.isArray(o.calls) ? o.calls[0] : undefined;
    if (o.turn === 1 && o.round === 0 && isObject(first)) first.name = HOSTILE_TOOL;
    return true;
  });
  let call = false;
  editLines(join(dir, "llm_calls.jsonl"), (o) => {
    if (o.k !== "llm_call" || o.seat !== "p1" || o.turn !== 1 || call) return false;
    call = true;
    o.stop = "refusal";
    o.refusal = { category: HOSTILE_LABEL, explanation: "not for viewers", recommendedModel: null };
    o.error = { kind: HOSTILE_LABEL, status: null, message: "not for viewers" };
    return true;
  });
}

/** A line of a run's files, in the order a run writes them (`livePlan`). */
export interface PlanItem {
  readonly file: "match.jsonl" | "llm_calls.jsonl" | "replies.jsonl";
  readonly line: string;
  /** The parsed line. */
  readonly o: JsonObject;
}

const field = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" ? String(v) : "";
const roundKey = (o: JsonObject): string =>
  `${field(o.seat)}|${field(o.turn)}|${field(o.kind ?? "round")}|${field(o.round ?? o.rt)}`;

/**
 * A finished arena run's lines in the order a run writes them: a round's model calls and reply
 * (`llm_calls.jsonl`, `replies.jsonl`) before that round's act, obs and gw lines in `match.jsonl`,
 * and the rest of a turn's side lines (its closing thought call) before its turn line. Appending
 * the items one by one replays the run as a server following it live sees it.
 */
export function livePlan(dir: string): PlanItem[] {
  const read = (file: PlanItem["file"]): PlanItem[] =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((line) => {
        const o: unknown = JSON.parse(line);
        return { file, line, o: isObject(o) ? o : {} };
      });
  const side = new Map<string, PlanItem[]>();
  for (const it of [...read("llm_calls.jsonl"), ...read("replies.jsonl")]) {
    if (it.o.k !== "llm_call" && it.o.k !== "reply") continue;
    const k = roundKey(it.o);
    side.set(k, [...(side.get(k) ?? []), it]);
  }
  const plan: PlanItem[] = [];
  const flush = (k: string): void => {
    const xs = side.get(k);
    if (xs === undefined) return;
    side.delete(k);
    plan.push(...xs.filter((x) => x.file === "llm_calls.jsonl"));
    plan.push(...xs.filter((x) => x.file === "replies.jsonl"));
  };
  for (const it of read("match.jsonl")) {
    const o = it.o;
    if ((o.k === "act" || o.k === "gw" || o.k === "obs") && typeof o.rt === "number") {
      for (let r = 0; r <= o.rt; r += 1) flush(roundKey({ ...o, kind: "round", round: r }));
    }
    if (o.k === "turn") {
      for (const k of side.keys()) if (k.startsWith(`${field(o.seat)}|${field(o.turn)}|`)) flush(k);
    }
    plan.push(it);
  }
  for (const k of side.keys()) flush(k);
  return plan;
}

/** Why the smoke test does not run here (null: it runs). */
export async function skipReason(): Promise<string | null> {
  if (process.env.PERFIDIA_E2E !== "1") {
    return "set PERFIDIA_E2E=1 (bun run test:e2e) to run the browser smoke test";
  }
  const { chromium } = await import("playwright-core");
  const exe = chromium.executablePath();
  if (!existsSync(exe)) {
    return `Chromium is not installed at ${exe} (PLAYWRIGHT_BROWSERS_PATH; CI: bunx playwright-core install chromium)`;
  }
  return null;
}

export interface Env {
  readonly url: string;
  readonly browser: Browser;
  readonly root: string;
  /** The finished fake run's directory (the live test writes it again, line by line). */
  readonly fakeDir: string;
  readonly rescan: () => void;
  /**
   * A second server over the same runs that publishes neither costs nor reasoning (`--no-costs
   * --no-reasoning`): the UI's "not published" lines.
   */
  readonly privateUrl: string;
  readonly stop: () => Promise<void>;
}

let env: Env | null = null;
/** Console errors and page errors of every page opened, by path. */
export const errors: string[] = [];
const contexts: BrowserContext[] = [];

export function setEnv(e: Env): void {
  env = e;
}

export function current(): Env {
  if (env === null) throw new Error("the smoke environment did not start");
  return env;
}

export async function closeContexts(): Promise<void> {
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
}

/** A page of a returning viewer ("How to watch" seen), its console errors collected. */
export async function open(
  path: string,
  size = { width: 1440, height: 900 },
  o: { readonly base?: string } = {},
): Promise<Page> {
  const { browser, url } = current();
  const context = await browser.newContext({ viewport: size });
  contexts.push(context);
  // A returning viewer (storage blocked: the overlay would show); CSP violations recorded (Chromium
  // logs none for a refused eval, so the console check alone would miss them).
  await context.addInitScript({
    content: `try { localStorage.setItem("perfidia.howToWatch.seen", "1"); } catch {}
window.__csp = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__csp.push(e.violatedDirective + " " + e.blockedURI + " " + e.sourceFile + ":" + e.lineNumber);
});`,
  });
  const page = await context.newPage();
  // A missing element fails its step with Playwright's message, well inside the test's timeout.
  page.setDefaultTimeout(10_000);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${path}: console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${path}: ${e.message}`));
  await page.goto((o.base ?? url) + path);
  return page;
}

export async function mapReady(page: Page): Promise<void> {
  await page.waitForSelector("[data-map] [data-island]", { timeout: 15_000 });
}

/** The game clock of the timeline ("D4 12:51"). */
export async function clock(page: Page): Promise<string> {
  return (await page.getByRole("timer", { name: "Game time" }).textContent()) ?? "";
}

/** Seeks with the scrubber's keys: Home, then 6 h (Page Up), 15 min (→) and 1 min (Shift+→). */
export async function seekWithKeys(page: Page, t: number): Promise<void> {
  await page.getByRole("slider", { name: "Game time" }).focus();
  await page.keyboard.press("Home");
  let left = t;
  for (; left >= 6 * HOUR; left -= 6 * HOUR) await page.keyboard.press("PageUp");
  for (; left >= 900; left -= 900) await page.keyboard.press("ArrowRight");
  for (; left >= 60; left -= 60) await page.keyboard.press("Shift+ArrowRight");
}

// Run in the page (a string: this project type-checks without the DOM library, see
// tsconfig.e2e.json): what would show HTML made from strings, scripts, links out of the app, a
// bidi control that reached the text (the spectator text is cleaned of them), a handler planted by
// hostile text that ran, or a CSP violation.
const DIRTY_DOM = `(() => {
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    for (const a of el.getAttributeNames()) {
      if (/^on/i.test(a) || /^(srcdoc|formaction)$/i.test(a)) out.push(el.tagName + " " + a);
    }
  }
  for (const el of document.querySelectorAll("iframe, object, embed, img, video, audio, base, form")) {
    out.push(el.tagName);
  }
  for (const s of document.querySelectorAll("script")) {
    if (s.src === "" || s.textContent !== "") out.push("inline script");
  }
  for (const a of document.querySelectorAll("a[href], area[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (!href.startsWith("/") || href.startsWith("//")) out.push("link " + href);
  }
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const v = walk.currentNode.nodeValue ?? "";
    if (/[\\u202A-\\u202E\\u2066-\\u2069]/.test(v)) out.push("bidi control in text: " + v.slice(0, 40));
  }
  if (window.__xss !== undefined) out.push("planted handler ran: " + window.__xss);
  for (const v of window.__csp ?? []) out.push("CSP violation: " + v);
  return out;
})()`;

/** No HTML made from strings, no script, frame or link out of the app, no bidi control, no CSP violation. */
export async function domIsClean(page: Page): Promise<void> {
  const bad: unknown = await page.evaluate(DIRTY_DOM);
  expect(bad).toEqual([]);
}

/** Waits until the game clock reads `text`. */
export async function clockReads(page: Page, text: string): Promise<void> {
  await page
    .getByRole("timer", { name: "Game time" })
    .filter({ hasText: new RegExp(`^${text}$`) })
    .waitFor();
}

/** What has the focus in the page: `tag[data-x=…]` for a marked element, else its tag. */
export async function focused(page: Page): Promise<string> {
  const v: unknown = await page.evaluate(`(() => {
    const el = document.activeElement;
    if (el === null) return "none";
    for (const a of ["data-city", "data-open-turn", "data-player", "data-testid"]) {
      const v = el.getAttribute(a);
      if (v !== null) return el.tagName.toLowerCase() + "[" + a + "=" + v + "]";
    }
    return el.tagName.toLowerCase();
  })()`);
  return String(v);
}
