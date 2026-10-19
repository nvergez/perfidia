// Pass C checks of the turn detail (C1): agent T's file, extended at integration (docs/phase3.md
// §16.4, §16.7, §16.9). Registered inside the smoke test's `describe` by `smoke.test.ts`; the
// environment, `open` and the DOM checks come from `../kit.ts`. One page of the fake run: a thought's
// reasoning expands in place (Pass B's check), then the thought opens its turn's sheet (a chunk loaded only then) with the turn's wake, rounds and tool calls
// with their verdicts, ending and cost (simulated prices: a fake model), its deep link in the URL;
// turn 2, then turn 1 from the keyboard, in place (the focus stays in the sheet's header); its
// "Dossier" takes its place (the link gone), and Escape there gives the focus back to the thought. The same page then opens, through the URL's history (no reload), an agent's turn with
// a refused call (✗ and its code) and a bot's turn, which has no model calls. The live per-round
// reasoning (C3) is checked by the smoke test's live run; a cold deep link by its private server.

import { expect, test } from "bun:test";
import { FeedPageSchema, type FeedItemOf } from "@perfidia/protocol/spectator";
import { current, domIsClean, focused, mapReady, open } from "../kit.ts";

/** Script files the page has loaded (the initial chunk, then each chunk loaded on demand). */
const CHUNKS = `performance.getEntriesByType("resource").filter((e) => /[/]chunk-[^/]*[.]js$/.test(e.name)).length`;

export function turnChecks(): void {
  test("C1: a thought's reasoning, then its turn detail: rounds, verdicts, cost; the URL; Escape", async () => {
    const t0 = performance.now();
    const page = await open("/m/fake1");
    await mapReady(page);
    await page.getByRole("tab", { name: "Thoughts" }).click();
    const thoughts = page.getByTestId("thoughts");
    // A thought's reasoning expands in place (Pass B), before its turn detail opens.
    await thoughts
      .getByRole("button", { name: /^Reasoning/ })
      .first()
      .click();
    await thoughts
      .getByText(/^Fake reasoning: /)
      .first()
      .waitFor();
    const button = thoughts.locator("[data-open-turn]").first();
    const which = (await button.getAttribute("data-open-turn")) ?? "";
    const [seat = "", turn = ""] = which.split(":");
    const loaded = Number(await page.evaluate(CHUNKS));
    await button.click();
    const sheet = page.getByTestId("turn-sheet");
    await sheet.locator('[data-turn-state="closed"]').waitFor();
    // The sheet takes the focus itself (Tab then walks it from the top).
    expect(await focused(page)).toBe("div[data-testid=turn-sheet]");
    // The sheet came in a chunk of its own, loaded on demand (not part of the initial load).
    expect(Number(await page.evaluate(CHUNKS))).toBeGreaterThan(loaded);
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
    // Turn 2 (through the URL's history), then the previous turn in place from the keyboard: the
    // URL follows, and the focus moves to "Turn 2" before "Turn 1" is disabled (it stays in the
    // sheet's header).
    await page.evaluate(
      `history.pushState(null, "", "/m/fake1?turn=${seat}.2"); dispatchEvent(new PopStateEvent("popstate"))`,
    );
    await sheet.getByText(`${seat} · turn 2`).waitFor();
    await sheet.getByRole("button", { name: "Turn 1", exact: true }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByText(`${seat} · turn 1`).waitFor();
    expect(new URL(page.url()).searchParams.get("turn")).toBe(`${seat}.1`);
    expect(String(await page.evaluate("document.activeElement?.textContent?.trim()"))).toBe(
      "Turn 2",
    );
    // "Dossier": the seat's dossier takes the sheet's place (the link goes); Escape then gives the
    // focus back along the chain of openers, to the thought's "Turn detail" (the sheet's "Dossier"
    // that opened the dossier is gone).
    await sheet.getByTestId("turn-dossier").dispatchEvent("click");
    const dossier = page.getByTestId("player-sheet");
    await dossier.getByText(`(${seat})`).first().waitFor();
    await sheet.waitFor({ state: "detached" });
    expect(new URL(page.url()).searchParams.has("turn")).toBe(false);
    await page.keyboard.press("Escape");
    await dossier.waitFor({ state: "detached" });
    expect(await focused(page)).toBe(`button[data-open-turn=${which}]`);
    await domIsClean(page);
    // A turn with a refused call (from the feed route), opened in place through the URL's history
    // (back and forward follow it): ✗ with the rejection's code beside the ✓.
    const res = await fetch(`${current().url}/api/matches/fake1/feed?kinds=turn&limit=200`);
    const refused = FeedPageSchema.parse(await res.json())
      .items.map((e) => e.item)
      .find((i): i is FeedItemOf<"turn"> => i.k === "turn" && i.llm && i.rejected.length > 0);
    if (refused === undefined)
      throw new Error("the fake run has no agent turn with a refused call");
    await page.evaluate(
      `history.pushState(null, "", "/m/fake1?turn=${refused.seat}.${refused.turn}"); dispatchEvent(new PopStateEvent("popstate"))`,
    );
    await sheet.getByText(`${refused.seat} · turn ${refused.turn}`).waitFor();
    const no = sheet.locator('[data-verdict="rejected"]').first();
    await no.waitFor();
    expect((await no.textContent()) ?? "").toContain(refused.rejected[0]?.code ?? "?");
    expect(await sheet.locator('[data-verdict="ok"]').count()).toBeGreaterThanOrEqual(1);
    expect((await sheet.getByTestId("turn-rounds").textContent()) ?? "").toMatch(
      /tool calls?: \d+ accepted, \d+ rejected \(refused: [A-Z_]+ ×\d+/,
    );
    // A bot's turn (p5, a scripted bot in a fake run), in place too: no model calls to show.
    await page.evaluate(
      `history.pushState(null, "", "/m/fake1?turn=p5.2"); dispatchEvent(new PopStateEvent("popstate"))`,
    );
    await sheet.getByText("p5 · turn 2").waitFor();
    await sheet.getByTestId("turn-bot").waitFor();
    expect(await sheet.getByTestId("turn-costs").count()).toBe(0);
    expect((await sheet.textContent()) ?? "").toContain("p5 · turn 2");
    await domIsClean(page);
    console.log(`web e2e turn detail checks: ${Math.round(performance.now() - t0)} ms`);
  }, 20_000);
}
