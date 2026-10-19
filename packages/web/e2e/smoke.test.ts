// The end-to-end smoke test of the spectator web app (phase-3 design §6.1 "End-to-end smoke"):
// headless Chromium (playwright-core, the pre-installed Playwright browsers) against an in-process
// spectator server that serves a fresh build of the app, the war golden, a fake arena run generated
// here, a copy of it with hostile player text planted (markup, script, URLs, bidi; in messages and
// proposals too, re-hashed), and a run written line by line with its side files while a page
// follows it live (its reasoning round by round, Pass C's C3); a second server, over a copy of the
// fake run, publishes neither costs nor reasoning. Every page records CSP violations and console
// errors; the DOM is checked for HTML sinks. Opt-in: `bun run test:e2e`
// (PERFIDIA_E2E=1); skipped with a printed reason otherwise, or when Chromium is not installed. The
// server listens on `PERFIDIA_E2E_PORT` (default: any free port). Budget: 20 s. The helpers are in
// `kit.ts`; Pass C's checks in `checks/*.ts`, one file per feature (docs/phase3.md §16.4).

// oxlint-disable no-await-in-loop -- browser steps follow each other on purpose
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dossierChecks } from "./checks/dossier.ts";
import { turnChecks } from "./checks/turns.ts";
import {
  clock,
  clockReads,
  closeContexts,
  current,
  DAY,
  domIsClean,
  errors,
  focused,
  HOSTILE,
  HOUR,
  isObject,
  livePlan,
  mapReady,
  open,
  plantHostile,
  seekWithKeys,
  setEnv,
  skipReason,
  WAR_GOLDEN,
} from "./kit.ts";

/** D4 12:51, a few seconds after p2's attack on its ally p3 lands at c18 (the betrayal). */
const BETRAYAL_SEEK = 3 * DAY + 12 * HOUR + 51 * 60;
/** D4 08:57: just after p2's "we remain friends" to p3 and p3's call for help (D4 08:56:32). */
const MESSAGES_SEEK = 3 * DAY + 8 * HOUR + 57 * 60;

const reason = await skipReason();
if (reason !== null) console.log(`web e2e smoke skipped: ${reason}`);

let stopAll: (() => Promise<void>) | null = null;
/** The build's JavaScript, gzipped: the initial load (under its budget) and what loads on demand. */
let bundle = { initial: 0, lazy: 0, budget: 0 };
const started = performance.now();

/** The animation of the element `selector` finds (a string: no DOM library in this project). */
const animation = (selector: string): string =>
  `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).animationName`;

/** Waits until match `id` of the server at `url` is folded and ended. */
async function ended(url: string, id: string, ms = 15_000): Promise<void> {
  for (const end = performance.now() + ms; ;) {
    const res = await fetch(`${url}/api/matches/${id}`);
    if (res.ok && JSON.stringify(await res.json()).includes('"status":"ended"')) return;
    if (performance.now() > end) throw new Error(`${url}: ${id} did not end in ${ms} ms`);
    await Bun.sleep(50);
  }
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
    bundle = { initial: report.jsGzip, lazy: report.lazyJsGzip, budget: build.JS_BUDGET_GZ };
    const t1 = performance.now();
    const serve = (dir: string, cache: string, publish: boolean, port: number) =>
      server.startServer(
        {
          runs: dir,
          cache: join(root, cache),
          publish: null,
          host: "127.0.0.1",
          port,
          hosts: [],
          dev: false,
          webDist: dist,
          adapter: "elysia",
          trustProxy: null,
          origins: [],
          policy: { costs: publish, reasoning: publish },
          // The war golden, the fake run and its hostile copy fold side by side.
          workers: 3,
          limits: {
            ...server.DEFAULT_LIMITS,
            httpPerMinute: 100_000,
            httpBurst: 100_000,
          },
          timing: { ...server.DEFAULT_TIMING, pollMs: 50, rescanMs: 200 },
        },
        { warn: () => undefined },
      );
    // The war golden folds in a worker while the fake run is generated here.
    const s = serve(runs, "cache", true, Number(process.env.PERFIDIA_E2E_PORT ?? "0"));
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
    // The second server folds a copy of the fake run alone (its folds would slow the first's).
    const privateRuns = join(root, "runs-private");
    mkdirSync(privateRuns);
    cpSync(join(stage, "fake1"), join(privateRuns, "fake1"), { recursive: true });
    const p = serve(privateRuns, "cache-private", false, 0);
    const browser = await chromium.launch({ headless: true });
    // The fake runs folded and ended (the hostile copy still verifies: Level E holds); the war
    // golden folds on while the tests of the fake runs go first.
    await Promise.all([ended(s.url, "fake1"), ended(s.url, "hostile"), ended(p.url, "fake1")]);
    stopAll = async () => {
      await browser.close();
      await p.stop();
      await s.stop();
      rmSync(root, { recursive: true, force: true });
    };
    setEnv({
      url: s.url,
      privateUrl: p.url,
      browser,
      root,
      fakeDir: join(stage, "fake1"),
      rescan: () => s.rescan(),
      stop: () => stopAll?.() ?? Promise.resolve(),
    });
    const t3 = performance.now();
    console.log(
      `web e2e setup: build ${Math.round(t1 - t0)} ms (initial JS ${(report.jsGzip / 1024).toFixed(1)} KB gzipped, lazy ${(report.lazyJsGzip / 1024).toFixed(1)} KB), fake run and hostile copy ${Math.round(t2 - t1)} ms, folds ready ${Math.round(t3 - t2)} ms more`,
    );
  }, 60_000);

  afterAll(async () => {
    await closeContexts();
    await stopAll?.();
    console.log(`web e2e smoke: ${((performance.now() - started) / 1000).toFixed(1)} s in all`);
  });

  test("the initial load stays within its budget; Pass C loads on demand", () => {
    expect(bundle.initial).toBeGreaterThan(0);
    expect(bundle.initial).toBeLessThanOrEqual(bundle.budget);
    // The turn detail, the dossier extras and the live reasoning are among the lazy chunks.
    expect(bundle.lazy).toBeGreaterThan(40 * 1024);
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
    // Messages and proposals (re-hashed into the log: Level E still holds).
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await page.getByRole("tab", { name: "Feed" }).click();
    await page.getByRole("button", { name: "Diplomacy", exact: true }).click();
    const feed = page.getByTestId("feed");
    await feed
      .locator('[data-k="message"]')
      .filter({ hasText: `${HOSTILE.img} ${HOSTILE.js} ${HOSTILE.script}` })
      .first()
      .waitFor();
    await feed
      .locator('[data-k="proposal"]')
      .filter({ hasText: `${HOSTILE.attr} ${HOSTILE.url}` })
      .first()
      .waitFor();
    await domIsClean(page);
  }, 20_000);

  test("a server that publishes neither costs nor reasoning: the UI says so", async () => {
    const { privateUrl } = current();
    const meta: unknown = await (await fetch(`${privateUrl}/api/matches/fake1`)).json();
    expect(isObject(meta) ? meta.published : null).toEqual({ costs: false, reasoning: false });
    // A deep link to an agent's turn: its detail opens on arrival. The verdicts (from the log)
    // stay; reasoning and costs are one line each, with no empty box and no figure.
    const page = await open("/m/fake1?turn=p1.2", undefined, { base: privateUrl });
    const turnSheet = page.getByTestId("turn-sheet");
    await turnSheet.locator('[data-turn-state="closed"]').waitFor();
    const rounds = turnSheet.getByTestId("turn-rounds");
    await rounds.getByText("Reasoning not published for this match.").waitFor();
    expect(await rounds.locator('[data-verdict="ok"]').count()).toBeGreaterThanOrEqual(1);
    expect(await rounds.getByRole("button", { name: /^Reasoning/ }).count()).toBe(0);
    expect((await rounds.textContent()) ?? "").not.toMatch(/Fake reasoning|\$\d/);
    const costs = (await turnSheet.getByTestId("turn-costs").textContent()) ?? "";
    expect(costs).toContain("Costs not published for this match.");
    expect(costs).not.toMatch(/\$|\d tokens/);
    // Its seat's dossier, from the sheet (the sheet gives way): no spending either.
    await turnSheet.getByTestId("turn-dossier").dispatchEvent("click");
    const sheet = page.getByTestId("player-sheet");
    await sheet.getByText("Spending not published for this match.").waitFor();
    expect(await sheet.getByTestId("spend").count()).toBe(0);
    expect((await sheet.textContent()) ?? "").toContain("(p1)");
    await turnSheet.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    // The Thoughts column's reasoning.
    await page.getByRole("tab", { name: "Thoughts" }).click();
    const thoughts = page.getByTestId("thoughts");
    await thoughts
      .getByRole("button", { name: /^Reasoning/ })
      .first()
      .click();
    await thoughts.getByText("Reasoning not published for this match.").first().waitFor();
    await thoughts.getByText("Costs not published for this match.").first().waitFor();
    expect(await thoughts.getByText(/^Fake reasoning: /).count()).toBe(0);
    await domIsClean(page);
  }, 25_000);

  // Pass C (docs/phase3.md §16.4): one file of checks per feature agent.
  turnChecks();
  dossierChecks();

  test("the war golden: map, leaderboard, blocs, the end; thoughts; moments; the betrayal; dossiers", async () => {
    await ended(current().url, "war");
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
    // The dossiers at D4 12:51: the betrayal counted once on each side; score and cities hour by
    // hour up to the playhead (84 hourly points). The victim's dossier is a click away.
    await page.locator("[data-testid=leaderboard] [data-player=p2] button").first().click();
    const dossier = page.getByTestId("player-sheet");
    const record = dossier.getByTestId("seat-record");
    await record.filter({ hasText: "Betrayals committed1Betrayals suffered0" }).waitFor();
    const sparks = dossier.locator("[data-testid=hourly] svg path");
    expect(await sparks.count()).toBe(2);
    expect(((await sparks.first().getAttribute("d")) ?? "").match(/[ML]/g)?.length).toBe(84);
    // A click event: no wait for the sheet's opening slide to end.
    await record.locator("button[data-player=p3]").dispatchEvent("click");
    await record.filter({ hasText: "Betrayals committed0Betrayals suffered1" }).waitFor();
    expect((await dossier.textContent()) ?? "").toContain("Dossier of Turtle (bot) (p3)");

    await domIsClean(page);
  }, 40_000);

  test("?start=1 opens at the first second; the cities are one tab stop; focus comes back", async () => {
    const page = await open("/m/war?start=1");
    await mapReady(page);
    await clockReads(page, "D1 00:00");
    const stops = page.locator('[data-map] [data-city][tabindex="0"]');
    expect(await stops.count()).toBe(1);
    const first = (await stops.getAttribute("data-city")) ?? "";
    await stops.focus();
    await page.keyboard.press("ArrowRight");
    const next = await focused(page);
    expect(next).toMatch(/^g\[data-city=c\d+\]$/);
    expect(next).not.toBe(`g[data-city=${first}]`);
    // The tab stop followed the focus: still one, on the city the arrow moved to.
    expect(await stops.count()).toBe(1);
    expect(`g[data-city=${(await stops.getAttribute("data-city")) ?? ""}]`).toBe(next);
    await page.keyboard.press("Enter");
    const popover = page.getByTestId("city-popover");
    await popover.waitFor();
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached" });
    expect(await focused(page)).toBe(next);
    // The close button gives it back too.
    await page.keyboard.press("Enter");
    await popover.waitFor();
    await popover.getByRole("button", { name: "Close" }).click();
    await popover.waitFor({ state: "detached" });
    expect(await focused(page)).toBe(next);
    await domIsClean(page);
  }, 20_000);

  test("a match followed live, its reasoning round by round, to its end", async () => {
    const { fakeDir, root, url, rescan } = current();
    const live = join(root, "runs", "live1");
    mkdirSync(live, { recursive: true });
    copyFileSync(join(fakeDir, "seats.json"), join(live, "seats.json"));
    // The run's files as it writes them; an agent's turn of 3 rounds or more, opened after the
    // first 400 lines of the log, is followed round by round (C3).
    const plan = livePlan(fakeDir);
    let logLines = 0;
    const turnAt = plan.findIndex(
      (it) =>
        it.file === "match.jsonl" &&
        (logLines += 1) > 400 &&
        it.o.k === "turn" &&
        Number(it.o.rounds) >= 3 &&
        plan.some((x) => x.o.k === "reply" && x.o.seat === it.o.seat && x.o.turn === it.o.turn),
    );
    const target = plan[turnAt]?.o;
    expect(target).toBeDefined();
    const seat = String(target?.seat);
    const turn = Number(target?.turn);
    const reply = (round: number): number =>
      plan.findIndex(
        (x) => x.o.k === "reply" && x.o.seat === seat && x.o.turn === turn && x.o.round === round,
      );
    const lastReasoning = plan
      .slice(0, turnAt)
      .findLast((x) => x.o.k === "reply" && x.o.seat === seat && x.o.turn === turn)?.o.reasoning;
    let at = 0;
    const write = (to: number): void => {
      const by = new Map<string, string[]>();
      for (const it of plan.slice(at, to)) by.set(it.file, [...(by.get(it.file) ?? []), it.line]);
      for (const [file, lines] of by) appendFileSync(join(live, file), `${lines.join("\n")}\n`);
      at = to;
    };
    for (const f of ["match.jsonl", "llm_calls.jsonl", "replies.jsonl"]) {
      writeFileSync(join(live, f), "");
    }
    // Up to the turn's first reply; the run is found, live.
    write(reply(0) + 1);
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
    // The open turn's first round, sent on subscribe, in the Thoughts column; it fades in.
    await page.getByRole("tab", { name: "Thoughts" }).click();
    const block = page.locator(`[data-live-reasoning="${seat}:${turn}"]`);
    const live0 = `[data-live-reasoning="${seat}:${turn}"] [data-live-round="round:0"]`;
    const live1 = `[data-live-reasoning="${seat}:${turn}"] [data-live-round="round:1"]`;
    const round0 = page.locator(live0);
    await round0.waitFor();
    expect(String(await page.evaluate(animation(live0)))).toBe("enter");
    // The second round arrives on the socket before its calls reach the log: the column and the
    // leaderboard both say round 2. With reduced motion, it does not fade in.
    await page.emulateMedia({ reducedMotion: "reduce" });
    write(reply(1) + 1);
    const round1 = page.locator(live1);
    await round1.waitFor();
    expect(await block.locator("[data-live-round]").count()).toBe(2);
    expect(String(await page.evaluate(animation(live1)))).toBe("none");
    await page
      .locator(`[data-testid=leaderboard] [data-player=${seat}]`)
      .getByText("thinking… round 2")
      .waitFor();
    // The turn ends: the live block gives way to its thought, whose reasoning shows at once.
    write(turnAt + 1);
    await block.waitFor({ state: "detached" });
    const seatBlock = page.locator(`[data-seat=${seat}]`);
    await seatBlock.getByText(new RegExp(`^turn ${turn} · `)).waitFor();
    await seatBlock
      .getByRole("button", { name: /^Reasoning/ })
      .first()
      .click();
    const last = Array.isArray(lastReasoning) ? String(lastReasoning[0]) : "";
    expect(last).not.toBe("");
    await seatBlock.getByText(last).first().waitFor();
    // The rest of the run, in chunks.
    while (at < plan.length) {
      write(Math.min(plan.length, at + 150));
      await Bun.sleep(40);
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
