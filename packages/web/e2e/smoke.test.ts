// The end-to-end smoke test of the spectator web app (phase-3 design §6.1 "End-to-end smoke"):
// headless Chromium (playwright-core, the pre-installed Playwright browsers) against an in-process
// spectator server that serves a fresh build of the app, the war golden and a fake arena run
// generated here. Opt-in: `bun run test:e2e` (PERFIDIA_E2E=1); skipped with a printed reason
// otherwise, or when Chromium is not installed. Budget: about 20 s.

// oxlint-disable no-await-in-loop -- browser steps follow each other on purpose
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
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
  // A returning viewer; storage blocked: the overlay would show.
  await context.addInitScript({
    content: 'try { localStorage.setItem("perfidia.howToWatch.seen", "1"); } catch {}',
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
// tsconfig.e2e.json): what would show HTML made from strings, scripts or links out of the app.
const DIRTY_DOM = `(() => {
  const out = [];
  if (document.documentElement.outerHTML.includes("dangerouslySetInnerHTML")) {
    out.push("dangerouslySetInnerHTML");
  }
  for (const el of document.querySelectorAll("*")) {
    for (const a of el.getAttributeNames()) if (/^on/i.test(a)) out.push(el.tagName + " " + a);
  }
  for (const el of document.querySelectorAll("iframe, object, embed")) out.push(el.tagName);
  for (const s of document.querySelectorAll("script")) {
    if (s.src === "" || s.textContent !== "") out.push("inline script");
  }
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (!href.startsWith("/")) out.push("link " + href);
  }
  return out;
})()`;

/** No HTML made from strings: no inline handlers, scripts, frames or links out of the app. */
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
        port: 0,
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
    renameSync(join(stage, "fake1"), join(runs, "fake1"));
    s.rescan();
    const browser = await chromium.launch({ headless: true });
    env = {
      url: s.url,
      browser,
      root,
      stop: async () => {
        await browser.close();
        await s.stop();
        rmSync(root, { recursive: true, force: true });
      },
    };
    // Both matches folded and ended.
    for (const end = performance.now() + 15_000; ;) {
      const res = await fetch(`${s.url}/api/matches`);
      const list: unknown = await res.json();
      const ended = Array.isArray(list)
        ? list.filter((m: unknown) => JSON.stringify(m).includes('"status":"ended"')).length
        : 0;
      if (ended === 2) break;
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
    expect(await page.locator("[data-testid=leaderboard] [data-player]").count()).toBe(6);
    const rule = (await page.getByTestId("rule").textContent()) ?? "";
    expect(rule).toContain("16 of the 43 city slots, 2 of them taken by conquest");
    expect(await page.getByLabel("16 of 16 cities").count()).toBeGreaterThanOrEqual(1);
    expect(await page.getByLabel("2 of 2 cities taken by conquest").count()).toBe(1);
    // The end: p1 and p4 win by domination (the end card and the story strip).
    const end = page.locator('[data-k="end"]').last();
    await end.waitFor();
    expect((await end.textContent()) ?? "").toMatch(/p1 and .*p4 win by domination/);
    expect((await page.getByTestId("story").textContent()) ?? "").toContain("win by domination");
    await domIsClean(page);

    // D4 12:51: the betrayal card with its context.
    await seekWithKeys(page, BETRAYAL_SEEK);
    await clockReads(page, "D4 12:51");
    const betrayal = page.locator('[data-k="betrayal"]').last();
    await betrayal.waitFor();
    expect((await betrayal.textContent()) ?? "").toMatch(/p2 betrayed its ally .*p3 at .*c18/);
    const said = betrayal.getByRole("region", { name: "What they said before" });
    expect(await said.locator("li").count()).toBeGreaterThanOrEqual(1);
    const thinking = betrayal.getByRole("region", { name: "What they were thinking" });
    expect(await thinking.locator("li").count()).toBeGreaterThanOrEqual(1);

    // A message card opens its sender's thought of the same turn.
    const toggle = page
      .locator('[data-k="message"]')
      .last()
      .getByRole("button", { name: /was thinking when it wrote this/ });
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = page.locator(`[id="${(await toggle.getAttribute("aria-controls")) ?? ""}"]`);
    await panel.getByText(/^Turn \d+, ended/).waitFor();

    // "Next key moment" moves the clock.
    const before = await clock(page);
    await page.getByRole("button", { name: "Next key moment" }).click();
    for (const until = performance.now() + 5_000; (await clock(page)) === before;) {
      if (performance.now() > until) break;
      await Bun.sleep(50);
    }
    expect(await clock(page)).not.toBe(before);
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
