// The end-to-end smoke test of the spectator web app (phase-3 design §6.1 "End-to-end smoke"):
// headless Chromium (playwright-core, the pre-installed Playwright browsers) against an in-process
// spectator server that serves a fresh build of the app, the war golden, a fake arena run generated
// here, a copy of it with hostile player text planted (markup, script, URLs, bidi), and a run
// written line by line while a page follows it live. Every page records CSP violations and
// console errors; the DOM is checked for HTML sinks. Opt-in: `bun run test:e2e` (PERFIDIA_E2E=1);
// skipped with a printed reason otherwise, or when Chromium is not installed. The server listens on
// `PERFIDIA_E2E_PORT` (default: any free port). Budget: about 30 s.

// oxlint-disable no-await-in-loop -- browser steps follow each other on purpose
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

const WEB = join(import.meta.dir, "..");
const WAR_GOLDEN = join(
  WEB,
  "..",
  "sim",
  "fixtures",
  "golden",
  "perfidia-1@1.1.0",
  "lockstep-6p-6d-war.jsonl.gz",
);
const DAY = 86_400;
const HOUR = 3_600;
/** D4 12:51, a few seconds after p2's attack on its ally p3 lands at c18 (the betrayal). */
const BETRAYAL_SEEK = 3 * DAY + 12 * HOUR + 51 * 60;
/** D4 08:57: just after p2's "we remain friends" to p3 and p3's call for help (D4 08:56:32). */
const MESSAGES_SEEK = 3 * DAY + 8 * HOUR + 57 * 60;

/** Player text a page must show as text, never as markup, a script or a link. */
const HOSTILE = {
  img: '<img src=x onerror="window.__xss=1">',
  script: "<script>window.__xss=2</script>",
  js: "javascript:window.__xss=3",
  url: "https://evil.example/phish",
  bidi: "\u202Egnp.exe",
  attr: '" onmouseover="window.__xss=4" x="',
} as const;

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Rewrites each JSON line of a file through `edit` (lines it returns unchanged stay byte-equal). */
function editLines(path: string, edit: (o: JsonObject) => boolean): void {
  const out = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      const o: unknown = JSON.parse(line);
      return isObject(o) && edit(o) ? JSON.stringify(o) : line;
    });
  writeFileSync(path, out.join("\n"));
}

/**
 * Plants hostile text in a copy of a fake run where Level E does not see it: p1's profile
 * (`seats.json`), its turn thoughts and notebook (`match.jsonl`), its reasoning and replies
 * (`replies.jsonl`).
 */
function plantHostile(dir: string): void {
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
  editLines(join(dir, "match.jsonl"), (o) => {
    if (o.seat !== "p1") return false;
    if (o.k === "turn" && typeof o.thought === "string") {
      o.thought = `${HOSTILE.img} ${HOSTILE.script} ${HOSTILE.url}`;
      return true;
    }
    if (o.k === "note" && typeof o.text === "string") {
      o.text = `${HOSTILE.attr} ${HOSTILE.js} ${HOSTILE.bidi}`;
      return true;
    }
    return false;
  });
  editLines(join(dir, "replies.jsonl"), (o) => {
    if (o.seat !== "p1") return false;
    o.reasoning = [`${HOSTILE.script} reasoning ${HOSTILE.url}`];
    o.text = [HOSTILE.img];
    return true;
  });
}

async function skipReason(): Promise<string | null> {
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

const reason = await skipReason();
if (reason !== null) console.log(`web e2e smoke skipped: ${reason}`);

interface Env {
  readonly url: string;
  readonly browser: Browser;
  readonly root: string;
  /** The finished fake run's directory (the live test writes it again, line by line). */
  readonly fakeDir: string;
  readonly rescan: () => void;
  readonly stop: () => Promise<void>;
}

let env: Env | null = null;
const started = performance.now();
const errors: string[] = [];
const contexts: BrowserContext[] = [];

function current(): Env {
  if (env === null) throw new Error("the smoke environment did not start");
  return env;
}

/** A page of a returning viewer ("How to watch" seen), its console errors collected. */
async function open(path: string, size = { width: 1440, height: 900 }): Promise<Page> {
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
  await page.goto(url + path);
  return page;
}

async function mapReady(page: Page): Promise<void> {
  await page.waitForSelector("[data-map] [data-island]", { timeout: 15_000 });
}

/** The game clock of the timeline ("D4 12:51"). */
async function clock(page: Page): Promise<string> {
  return (await page.getByRole("timer", { name: "Game time" }).textContent()) ?? "";
}

/** Seeks with the scrubber's keys: Home, then 6 h (Page Up), 15 min (→) and 1 min (Shift+→). */
async function seekWithKeys(page: Page, t: number): Promise<void> {
  await page.getByRole("slider", { name: "Game time" }).focus();
  await page.keyboard.press("Home");
  let left = t;
  for (; left >= 6 * HOUR; left -= 6 * HOUR) await page.keyboard.press("PageUp");
  for (; left >= 900; left -= 900) await page.keyboard.press("ArrowRight");
  for (; left >= 60; left -= 60) await page.keyboard.press("Shift+ArrowRight");
}

// Run in the page (a string: this project type-checks without the DOM library, see
// tsconfig.e2e.json): what would show HTML made from strings, scripts, links out of the app, a
// handler planted by hostile text that ran, or a CSP violation.
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
  if (window.__xss !== undefined) out.push("planted handler ran: " + window.__xss);
  for (const v of window.__csp ?? []) out.push("CSP violation: " + v);
  return out;
})()`;

/** No HTML made from strings, no script, frame or link out of the app, no CSP violation. */
async function domIsClean(page: Page): Promise<void> {
  const bad: unknown = await page.evaluate(DIRTY_DOM);
  expect(bad).toEqual([]);
}

/** Waits until the game clock reads `text`. */
async function clockReads(page: Page, text: string): Promise<void> {
  await page
    .getByRole("timer", { name: "Game time" })
    .filter({ hasText: new RegExp(`^${text}$`) })
    .waitFor();
}

describe.skipIf(reason !== null)("the spectator web app in Chromium", () => {
  beforeAll(async () => {
    const t0 = performance.now();
    const root = mkdtempSync(join(tmpdir(), "perfidia-web-e2e-"));
    const runs = join(root, "runs");
    const stage = join(root, "stage");
    const dist = join(root, "dist");
    mkdirSync(join(runs, "war"), { recursive: true });
    copyFileSync(WAR_GOLDEN, join(runs, "war", "match.jsonl.gz"));

    const [{ chromium }, server, orchestrator, build] = await Promise.all([
      import("playwright-core"),
      import("@perfidia/server"),
      import("@perfidia/orchestrator"),
      import("../scripts/build.ts"),
    ]);
    const report = await build.buildWeb({ outdir: dist, quiet: true });
    const t1 = performance.now();
    // The war golden folds in a worker while the fake run is generated here.
    const s = server.startServer(
      {
        runs,
        cache: join(root, "cache"),
        publish: null,
        host: "127.0.0.1",
        port: Number(process.env.PERFIDIA_E2E_PORT ?? "0"),
        hosts: [],
        dev: false,
        webDist: dist,
        adapter: "elysia",
        trustProxy: null,
        origins: [],
        policy: { costs: true, reasoning: true },
        workers: 2,
        limits: {
          ...server.DEFAULT_LIMITS,
          httpPerMinute: 100_000,
          httpBurst: 100_000,
        },
        timing: { ...server.DEFAULT_TIMING, pollMs: 50, rescanMs: 200 },
      },
      { warn: () => undefined },
    );
    const plan = orchestrator.planArena(
      { ruleset: "perfidia-1@1.1.0", fake: true, seed: 3, idKey: "seed", days: 1 },
      orchestrator.arenaEnv({}),
    );
    await orchestrator.runArena(plan, {
      dir: join(stage, "fake1"),
      io: { out: () => undefined, err: () => undefined },
      quiet: true,
    });
    const t2 = performance.now();
    cpSync(join(stage, "fake1"), join(stage, "hostile"), { recursive: true });
    plantHostile(join(stage, "hostile"));
    renameSync(join(stage, "hostile"), join(runs, "hostile"));
    // Into the runs root by a rename (the server never sees half a copy).
    cpSync(join(stage, "fake1"), join(stage, "fake1-copy"), { recursive: true });
    renameSync(join(stage, "fake1-copy"), join(runs, "fake1"));
    s.rescan();
    const browser = await chromium.launch({ headless: true });
    env = {
      url: s.url,
      browser,
      root,
      fakeDir: join(stage, "fake1"),
      rescan: () => s.rescan(),
      stop: async () => {
        await browser.close();
        await s.stop();
        rmSync(root, { recursive: true, force: true });
      },
    };
    // The three matches folded and ended (the hostile copy still verifies: Level E holds).
    for (const end = performance.now() + 15_000; ;) {
      const res = await fetch(`${s.url}/api/matches`);
      const list: unknown = await res.json();
      const ended = Array.isArray(list)
        ? list.filter((m: unknown) => JSON.stringify(m).includes('"status":"ended"')).length
        : 0;
      if (ended === 3) break;
      if (performance.now() > end) throw new Error("the matches did not fold in 15 s");
      await Bun.sleep(50);
    }
    const t3 = performance.now();
    console.log(
      `web e2e setup: build ${Math.round(t1 - t0)} ms (JS ${(report.jsGzip / 1024).toFixed(1)} KB gzipped), fake run ${Math.round(t2 - t1)} ms, folds ready ${Math.round(t3 - t2)} ms more`,
    );
  }, 60_000);

  afterAll(async () => {
    for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
    await env?.stop();
    console.log(`web e2e smoke: ${((performance.now() - started) / 1000).toFixed(1)} s in all`);
  });

  test("the list shows both matches, the fake one with a FAKE badge", async () => {
    const page = await open("/");
    const war = page.locator('[data-match="war"]');
    const fake = page.locator('[data-match="fake1"]');
    await war.waitFor();
    await fake.waitFor();
    expect(await fake.getByTitle(/^Fake models/).count()).toBe(1);
    expect(await war.getByTitle(/^Fake models/).count()).toBe(0);
    await domIsClean(page);
  }, 20_000);

  test("the war golden: map, leaderboard, blocs and the end; the betrayal; thoughts; moments", async () => {
    const page = await open("/m/war");
    await mapReady(page);
    // Arrival at the end of the finished match.
    await clockReads(page, "D6 18:33");
    expect(await page.locator("[data-map] [data-island]").count()).toBe(31);
    expect(await page.locator("[data-map] [data-city]").count()).toBe(42);
    const rows = page.locator("[data-testid=leaderboard] [data-player]");
    expect(await rows.count()).toBe(6);
    // The end line's ranking: the winners first, then by score; winner chips on p1 and p4.
    const order: string[] = [];
    const winners: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const row = rows.nth(i);
      const id = (await row.getAttribute("data-player")) ?? "?";
      order.push(id);
      if (((await row.textContent()) ?? "").includes("winner")) winners.push(id);
    }
    expect(order).toEqual(["p4", "p1", "p5", "p2", "p6", "p3"]);
    expect(winners).toEqual(["p4", "p1"]);
    const rule = (await page.getByTestId("rule").textContent()) ?? "";
    expect(rule).toContain("16 of the 43 city slots, 2 of them taken by conquest");
    expect(await page.getByLabel("16 of 16 cities").count()).toBeGreaterThanOrEqual(1);
    expect(await page.getByLabel("2 of 2 cities taken by conquest").count()).toBe(1);
    // The end: p1 and p4 win by domination (the end card and the story strip), and by how much.
    const end = page.locator('[data-k="end"]').last();
    await end.waitFor();
    expect((await end.textContent()) ?? "").toMatch(/p1 and .*p4 win by domination/);
    const story = (await page.getByTestId("story").textContent()) ?? "";
    expect(story).toContain("win by domination");
    expect(story).toMatch(
      /held 16 of the 16 cities a win needs, 2 of 2 taken, for 24 h; next: .*with 16, 1 taken/,
    );
    await domIsClean(page);

    // D4 12:51: the betrayal card with its outcome and its context.
    await seekWithKeys(page, BETRAYAL_SEEK);
    await clockReads(page, "D4 12:51");
    const betrayal = page.locator('[data-k="betrayal"]').last();
    await betrayal.waitFor();
    expect((await betrayal.textContent()) ?? "").toMatch(/p2 betrayed its ally .*p3 at .*c18/);
    expect((await betrayal.getByTestId("betrayal-outcome").textContent()) ?? "").toMatch(
      /The attack failed: .*p3 held .*c18/,
    );
    const said = betrayal.getByRole("region", { name: "What they said before" });
    expect(await said.locator("li").count()).toBeGreaterThanOrEqual(1);
    const thinking = betrayal.getByRole("region", { name: "What they were thinking" });
    expect(await thinking.locator("li").count()).toBeGreaterThanOrEqual(1);

    // D4 08:57: each message opens its sender's thought of the turn it was sent in.
    await seekWithKeys(page, MESSAGES_SEEK);
    await clockReads(page, "D4 08:57");
    for (const [text, thought, turn] of [
      ["we remain friends", "opportunist D4 08:56:32: message p3; attack c18 from c2", 48],
      ["Please send support to c18", "turtle D4 08:56:32: recruit c18 max hoplite", 50],
    ] as const) {
      const card = page.locator('[data-k="message"]').filter({ hasText: text }).last();
      const toggle = card.getByRole("button", { name: /was thinking when it wrote this/ });
      await toggle.click();
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      const panel = page.locator(`[id="${(await toggle.getAttribute("aria-controls")) ?? ""}"]`);
      await panel.getByText(new RegExp(`^Turn ${turn}, ended`)).waitFor();
      expect((await panel.textContent()) ?? "").toContain(thought);
    }

    // "Next key moment" moves the clock.
    const before = await clock(page);
    await page.getByRole("button", { name: "Next key moment" }).click();
    for (const until = performance.now() + 5_000; (await clock(page)) === before;) {
      if (performance.now() > until) break;
      await Bun.sleep(50);
    }
    expect(await clock(page)).not.toBe(before);
    await domIsClean(page);
  }, 40_000);

  test("?start=1 opens a finished match at its first second", async () => {
    const page = await open("/m/war?start=1");
    await mapReady(page);
    await clockReads(page, "D1 00:00");
    await domIsClean(page);
  }, 20_000);

  test("hostile player text is shown as text: no markup, script, link or handler", async () => {
    const page = await open("/m/hostile");
    await mapReady(page);
    // Thoughts: p1's thought and its reasoning.
    await page.getByRole("tab", { name: "Thoughts" }).click();
    const thoughts = page.getByTestId("thoughts");
    await thoughts.getByText(HOSTILE.img, { exact: false }).first().waitFor();
    await thoughts
      .getByRole("button", { name: /^Reasoning/ })
      .first()
      .click();
    await thoughts.getByText(`${HOSTILE.script} reasoning`, { exact: false }).first().waitFor();
    await domIsClean(page);
    // The dossier: profile and notebook.
    await page.locator("[data-testid=leaderboard] [data-player=p1] button").first().click();
    const sheet = page.getByTestId("player-sheet");
    await sheet.waitFor();
    await sheet.getByText(`${HOSTILE.img} goal`, { exact: false }).waitFor();
    await sheet.getByText(HOSTILE.script, { exact: false }).first().waitFor();
    await sheet.getByText(HOSTILE.attr.trim(), { exact: false }).first().waitFor();
    const text = (await sheet.textContent()) ?? "";
    expect(text).toContain(HOSTILE.js);
    expect(text).toContain(HOSTILE.url);
    // Hovering what an attribute payload would have hooked.
    await sheet.getByText(HOSTILE.attr.trim(), { exact: false }).first().hover();
    await domIsClean(page);
  }, 20_000);

  test("a match followed live while its log is written, to its end", async () => {
    const { fakeDir, root, url, rescan } = current();
    const live = join(root, "runs", "live1");
    mkdirSync(live, { recursive: true });
    copyFileSync(join(fakeDir, "seats.json"), join(live, "seats.json"));
    const lines = readFileSync(join(fakeDir, "match.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const first = 400;
    writeFileSync(join(live, "match.jsonl"), `${lines.slice(0, first).join("\n")}\n`);
    rescan();
    for (const end = performance.now() + 10_000; ;) {
      const res = await fetch(`${url}/api/matches/live1`);
      if (res.ok && JSON.stringify(await res.json()).includes('"status":"live"')) break;
      if (performance.now() > end) throw new Error("live1 was not live in 10 s");
      await Bun.sleep(50);
    }
    const page = await open("/m/live1");
    await mapReady(page);
    await page.getByRole("timer", { name: "Game time" }).waitFor();
    // Following: the timeline says LIVE while the lines arrive.
    await page.getByText("LIVE", { exact: true }).waitFor();
    for (let at = first; at < lines.length; at += 120) {
      appendFileSync(join(live, "match.jsonl"), `${lines.slice(at, at + 120).join("\n")}\n`);
      await Bun.sleep(60);
    }
    // The end line arrived: the match is over, at its last line's time.
    await page
      .getByTestId("story")
      .getByText(/The match is over/)
      .waitFor({ timeout: 15_000 });
    await clockReads(page, "D2 00:00");
    const latest: unknown = await (await fetch(`${url}/api/matches/live1/latest`)).json();
    const players = isObject(latest) && isObject(latest.players) ? latest.players : {};
    const want = Object.values(players)
      .filter(isObject)
      .toSorted((a, b) => Number(a.rank) - Number(b.rank))
      .map((p) => String(p.id));
    const rows = page.locator("[data-testid=leaderboard] [data-player]");
    await rows.first().waitFor();
    const got: string[] = [];
    for (let i = 0; i < (await rows.count()); i += 1) {
      got.push((await rows.nth(i).getAttribute("data-player")) ?? "?");
    }
    expect(got).toEqual(want);
    await domIsClean(page);
  }, 30_000);

  test("a fake run's thought expands its reasoning", async () => {
    const page = await open("/m/fake1");
    await mapReady(page);
    await page.getByRole("tab", { name: "Thoughts" }).click();
    const thoughts = page.getByTestId("thoughts");
    await thoughts
      .getByRole("button", { name: /^Reasoning/ })
      .first()
      .click();
    await thoughts
      .getByText(/^Fake reasoning: /)
      .first()
      .waitFor();
    await domIsClean(page);
  }, 20_000);

  test("a phone screenshot (390 × 844)", async () => {
    const page = await open("/m/war", { width: 390, height: 844 });
    await mapReady(page);
    await page.getByRole("tab", { name: "Feed" }).click();
    // Kept after the run, for a look: $PERFIDIA_E2E_SHOTS, else a new temporary directory.
    const dir =
      process.env.PERFIDIA_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "perfidia-web-e2e-shots-"));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "war-390x844.png");
    await page.screenshot({ path });
    expect(statSync(path).size).toBeGreaterThan(10_000);
    console.log(`web e2e phone screenshot: ${path} (${statSync(path).size} bytes)`);
  }, 20_000);

  test("no console errors in any page", () => {
    expect(errors).toEqual([]);
  });
});
