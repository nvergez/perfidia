// Phase 4 Pass 3 checks of the web (agent G; docs/phase4.md "Pass 3: web as built"). Registered
// inside the smoke test's `describe` by `smoke.test.ts`; the environment, `open` and the DOM checks
// come from `../kit.ts`. The fake run plays the cross-provider lineup `budget-mix` (Haiku, GPT-6
// Luna, Gemini 3.8 Flash, GLM-5.3 Flash on OpenRouter), and both servers serve the model
// statistics of it and its hostile copy (two matches: too few for a claim; the copy's operator
// strings carry bidi and zero-width characters and markup, and once cleaned they name the same
// models):
// - `/models` (a chunk loaded on demand) says "Too few matches: N more needed (power now …)" with
//   N and the power from the route, and shows no ranking, rating, rank or win; every model is
//   listed by name, each fake as "Fake for <model>"; a model's link opens its page, whose seats
//   link to the match; on the server that publishes no costs, no dollar figure appears;
// - the GLM seat's turn detail labels each round's reasoning "Raw chain of thought" (never a
//   summary), its dossier's model block calls it a rehearsal standing in for GLM-5.3 Flash (Z.AI
//   via OpenRouter) with its effort in OpenRouter's terms, and the Thoughts column's toggles say
//   "Reasoning (raw chain of thought)" for it and "Reasoning (summary)" for the Claude seat.
// The model block's cut at the playhead is checked in `dossier.ts` (C2), its cleaned operator
// strings in the smoke test's hostile run (review fixes, docs/phase4.md §55).

import { expect, test } from "bun:test";
import { MatchMetaSchema, ModelsResponseSchema, type SeatInfo } from "@perfidia/protocol/spectator";
import { current, domIsClean, open } from "../kit.ts";

/** The power as the page prints it (two decimals). */
const power = (p: number): string => (Math.round(p * 100) / 100).toFixed(2);

function seatOf(seats: readonly SeatInfo[], model: string): string {
  const s = seats.find((x) => x.model?.model === model);
  if (s === undefined) throw new Error(`the fake run has no ${model} seat`);
  return s.seat;
}

export function modelsChecks(): void {
  test("Pass 3: /models: too few matches, no ranking; a model's page; no costs when withheld", async () => {
    const t0 = performance.now();
    const { url, privateUrl } = current();
    const data = ModelsResponseSchema.parse(await (await fetch(`${url}/api/models`)).json());
    expect(data.claims.state).toBe("too_few_matches");
    expect(data.ratings).toBeNull();
    expect(data.matches.map((m) => m.match)).toEqual(["fake1", "hostile"]);
    // The hostile copy's lineup, cleaned, is the run's.
    expect(data.matches.map((m) => m.lineup)).toEqual(["budget-mix", "budget-mix"]);
    const page = await open("/models");
    const claims = page.getByTestId("claims");
    await claims.waitFor();
    expect(await claims.getAttribute("data-claims")).toBe("too_few_matches");
    expect(await page.getByTestId("claims-headline").textContent()).toBe(
      `Too few matches: ${data.claims.more} more needed (power now ${power(data.claims.power)}).`,
    );
    // No ranking below the threshold: no ratings, no rank or win column, models by name.
    expect(await page.getByTestId("ratings").count()).toBe(0);
    const table = page.getByTestId("models-table");
    const head = (await table.locator("thead").textContent()) ?? "";
    expect(head).toContain("Cost per match");
    expect(head).not.toMatch(/Mean rank|Wins/);
    expect(await table.locator("tbody [data-model]").count()).toBe(data.models.length);
    const names = await table.locator("tbody [data-model] th a").allTextContents();
    expect(names).toEqual([
      "Fake for Claude Haiku 5.5",
      "Fake for Gemini 3.8 Flash",
      "Fake for GLM-5.3 Flash (Z.AI via OpenRouter)",
      "Fake for GPT-6 Luna",
      "Conqueror (bot, version 3)",
      "Opportunist (bot, version 3)",
    ]);
    await page.getByTestId("rehearsal-note").waitFor();
    await domIsClean(page);
    // A model's page, through its link (no page load): its seat links to the match.
    const glm = data.models.find((m) => m.model?.model === "z-ai/glm-5.3-flash");
    expect(glm).toBeDefined();
    await table.locator(`[data-model="${glm?.id ?? ""}"] th a`).click();
    const detail = page.getByTestId("model-detail");
    await detail.waitFor();
    expect(await detail.getAttribute("data-model")).toBe(glm?.id ?? "");
    expect(new URL(page.url()).pathname).toBe(`/models/${glm?.id ?? ""}`);
    expect(await detail.locator('header [data-reasoning-kind="raw"]').count()).toBe(1);
    expect(await detail.getByTestId("model-seats").locator('a[href="/m/fake1"]').count()).toBe(1);
    expect((await detail.getByTestId("claims").textContent()) ?? "").toContain("Too few matches");
    expect(await detail.getByTestId("model-rating").count()).toBe(0);
    await domIsClean(page);
    // The server that publishes no costs: the same page, no dollar figure.
    const quiet = await open("/models", undefined, { base: privateUrl });
    await quiet.getByTestId("claims").waitFor();
    await quiet.getByText("Costs not published on this server.").waitFor();
    const quietTable = (await quiet.getByTestId("models-table").textContent()) ?? "";
    expect(quietTable).not.toContain("$");
    expect(quietTable).not.toContain("Cost per match");
    await domIsClean(quiet);
    console.log(`web e2e models checks: ${Math.round(performance.now() - t0)} ms`);
  }, 20_000);

  test("Pass 3: reasoning kinds and the dossier's model block on the cross-provider run", async () => {
    const t0 = performance.now();
    const { url } = current();
    const meta = MatchMetaSchema.parse(await (await fetch(`${url}/api/matches/fake1`)).json());
    const glm = seatOf(meta.seats, "z-ai/glm-5.3-flash");
    const haiku = seatOf(meta.seats, "claude-haiku-5-5");
    // The GLM seat's turn 2: each round's reasoning is labelled raw, never a summary.
    const page = await open(`/m/fake1?turn=${glm}.2`);
    const sheet = page.getByTestId("turn-sheet");
    await sheet.locator('[data-turn-state="closed"]').waitFor();
    const rounds = sheet.getByTestId("turn-rounds");
    await rounds.locator('[data-reasoning-kind="raw"]').first().waitFor();
    expect(await rounds.locator('[data-reasoning-kind="summary"]').count()).toBe(0);
    expect(await rounds.locator("[data-reasoning-kind]").count()).toBe(
      await rounds.getByRole("button", { name: /^Reasoning/ }).count(),
    );
    // Its dossier: the model block calls it a rehearsal of GLM-5.3 Flash, in OpenRouter's terms.
    await sheet.getByTestId("turn-dossier").dispatchEvent("click");
    const block = page.getByTestId("player-sheet").getByTestId("model-block");
    await block.locator("[data-testid=model-whole], [data-testid=model-later]").first().waitFor();
    if ((await block.getByTestId("model-later").count()) > 0) {
      await block.getByRole("button", { name: "Show the whole match's figures" }).click();
    }
    await block.getByTestId("model-whole").waitFor();
    const text = (await block.textContent()) ?? "";
    for (const want of [
      "Rehearsal",
      "stands in for GLM-5.3 Flash (Z.AI via OpenRouter)",
      "reasoning effort low",
      "Raw chain of thought",
      "budget-mix",
    ]) {
      expect([want, text.includes(want)]).toEqual([want, true]);
    }
    expect((await block.getByTestId("model-spend").textContent()) ?? "").toMatch(
      /^\$\d+\.\d{2,4}.*\(simulated prices\)$/,
    );
    await page.keyboard.press("Escape");
    await page.getByTestId("player-sheet").waitFor({ state: "detached" });
    // The Thoughts column: each toggle says what the seat's reasoning is.
    await page.getByRole("tab", { name: "Thoughts" }).click();
    const thoughts = page.getByTestId("thoughts");
    await thoughts
      .locator(`[data-seat=${glm}]`)
      .getByRole("button", { name: "Reasoning (raw chain of thought)" })
      .first()
      .waitFor();
    await thoughts
      .locator(`[data-seat=${haiku}]`)
      .getByRole("button", { name: "Reasoning (summary)" })
      .first()
      .waitFor();
    await domIsClean(page);
    console.log(`web e2e reasoning-kind checks: ${Math.round(performance.now() - t0)} ms`);
  }, 20_000);
}
