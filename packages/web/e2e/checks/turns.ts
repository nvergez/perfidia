// Pass C checks of the turn detail (C1) and the live reasoning (C3): agent T's file
// (docs/phase3.md §16.4, §16.7). Registered inside the smoke test's `describe` by `smoke.test.ts`;
// the environment, `open` and the DOM checks come from `../kit.ts`. One page of the fake run: a
// thought opens its turn's sheet (a chunk loaded on demand) with the turn's wake, rounds and tool
// calls with their verdicts, ending and cost (simulated prices: a fake model), its deep link in
// the URL; the previous turn is a click away; Escape closes it with the focus back on the opener
// and the link gone; the same page then follows a deep link to a bot's turn, which has no model
// calls. The live per-round reasoning needs a run written while it is watched: its data shaping
// is unit-tested (`thoughts/live-rounds.test.ts`), its view was checked by hand (§16.7).

import { expect, test } from "bun:test";
import { current, domIsClean, focused, mapReady, open } from "../kit.ts";

export function turnChecks(): void {
  test("C1: a thought opens its turn detail: rounds, verdicts, cost; a deep link; Escape", async () => {
    const t0 = performance.now();
    const page = await open("/m/fake1");
    await mapReady(page);
    await page.getByRole("tab", { name: "Thoughts" }).click();
    const thoughts = page.getByTestId("thoughts");
    const button = thoughts.locator("[data-open-turn]").first();
    const which = (await button.getAttribute("data-open-turn")) ?? "";
    const [seat = "", turn = ""] = which.split(":");
    await button.click();
    const sheet = page.getByTestId("turn-sheet");
    await sheet.locator('[data-turn-state="closed"]').waitFor();
    expect((await sheet.textContent()) ?? "").toContain(`${seat} · turn ${turn}`);
    expect(new URL(page.url()).searchParams.get("turn")).toBe(`${seat}.${turn}`);
    // The wake, each round's reasoning and tool calls with their verdicts, the ending, the cost.
    await sheet
      .getByTestId("turn-wake")
      .getByText(/Woke at D\d/)
      .waitFor();
    const rounds = sheet.getByTestId("turn-rounds");
    await rounds
      .getByText(/^Fake reasoning: /)
      .first()
      .waitFor();
    expect(await rounds.locator("[data-round]").count()).toBeGreaterThanOrEqual(1);
    expect(await rounds.locator('[data-verdict="ok"]').count()).toBeGreaterThanOrEqual(1);
    expect((await rounds.textContent()) ?? "").toMatch(
      /\d+ rounds? · \d+ tool calls?: \d+ accepted/,
    );
    expect((await sheet.getByTestId("turn-ending").textContent()) ?? "").toMatch(/It |The /);
    const costs = (await sheet.getByTestId("turn-costs").textContent()) ?? "";
    expect(costs).toMatch(/\$\d+\.\d\d · [\d,]+ tokens/);
    expect(costs).toContain("Simulated prices");
    // The previous turn, in place (a click event: no wait for the sheet's opening slide to end).
    if (Number(turn) > 1) {
      await sheet.getByRole("button", { name: `Turn ${Number(turn) - 1}` }).dispatchEvent("click");
      await sheet.getByText(`${seat} · turn ${Number(turn) - 1}`).waitFor();
      expect(new URL(page.url()).searchParams.get("turn")).toBe(`${seat}.${Number(turn) - 1}`);
    }
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    expect(await focused(page)).toBe(`button[data-open-turn=${which}]`);
    expect(new URL(page.url()).searchParams.has("turn")).toBe(false);
    await domIsClean(page);
    // A deep link to a bot's turn (p5, a scripted bot in a fake run): no model calls to show.
    await page.goto(`${current().url}/m/fake1?turn=p5.2`);
    await sheet.locator('[data-turn-state="closed"]').waitFor();
    await sheet.getByTestId("turn-bot").waitFor();
    expect(await sheet.getByTestId("turn-costs").count()).toBe(0);
    expect((await sheet.textContent()) ?? "").toContain("p5 · turn 2");
    await domIsClean(page);
    console.log(`web e2e turn detail checks: ${Math.round(performance.now() - t0)} ms`);
  }, 20_000);
}
