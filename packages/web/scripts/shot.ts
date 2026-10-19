// oxlint-disable no-await-in-loop -- one page and one viewport after the other, on purpose
import { chromium, type Page } from "playwright-core";

// Screenshots of the running app for development and review (not a test): opens a URL in headless
// Chromium (the pre-installed Playwright browsers, `PLAYWRIGHT_BROWSERS_PATH`), optionally waits for
// a selector, clicks, presses keys, and writes a PNG per viewport. Every console error and page
// error is printed, and the exit code is 1 when there was one.
//   bun packages/web/scripts/shot.ts --url http://127.0.0.1:8201/m/war --out /tmp/war \
//     [--size 1440x900 --size 390x844] [--wait '[data-map]'] [--click 'text=Start watching']
//     [--press Space] [--after-ms 1500] [--full]
// Writes <out>-1440x900.png, <out>-390x844.png.

interface Options {
  readonly url: string;
  readonly out: string;
  readonly sizes: readonly { readonly w: number; readonly h: number }[];
  readonly wait: readonly string[];
  readonly clicks: readonly string[];
  readonly press: readonly string[];
  readonly afterMs: number;
  readonly full: boolean;
  readonly seen: boolean;
}

function parse(argv: readonly string[]): Options {
  const many = (flag: string): string[] =>
    argv.flatMap((a, i) => (a === flag && argv[i + 1] !== undefined ? [argv[i + 1] ?? ""] : []));
  const one = (flag: string): string | undefined => many(flag)[0];
  const url = one("--url");
  const out = one("--out");
  if (url === undefined || out === undefined) {
    throw new Error(
      "usage: shot.ts --url <url> --out <path prefix> [--size WxH]… [--wait sel]… [--click sel]… [--press key]… [--after-ms n] [--full] [--first-visit]",
    );
  }
  const sizes = (many("--size").length === 0 ? ["1440x900", "390x844"] : many("--size")).map(
    (s) => {
      const [w, h] = s.split("x").map(Number);
      if (w === undefined || h === undefined || !Number.isInteger(w) || !Number.isInteger(h)) {
        throw new Error(`--size ${s}: expected WxH`);
      }
      return { w, h };
    },
  );
  return {
    url,
    out,
    sizes,
    wait: many("--wait"),
    clicks: many("--click"),
    press: many("--press"),
    afterMs: Number(one("--after-ms") ?? "800"),
    full: argv.includes("--full"),
    seen: !argv.includes("--first-visit"),
  };
}

async function shoot(page: Page, o: Options, w: number, h: number): Promise<string> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(o.url, { waitUntil: "networkidle" });
  for (const sel of o.wait) await page.waitForSelector(sel, { timeout: 15_000 });
  for (const sel of o.clicks) await page.click(sel, { timeout: 5_000 });
  for (const key of o.press) await page.keyboard.press(key);
  await page.waitForTimeout(o.afterMs);
  const path = `${o.out}-${w}x${h}.png`;
  await page.screenshot({ path, fullPage: o.full });
  return path;
}

const o = parse(process.argv.slice(2));
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
try {
  for (const { w, h } of o.sizes) {
    const context = await browser.newContext({ viewport: { width: w, height: h } });
    if (o.seen) {
      // A returning viewer: "How to watch" stays closed unless --first-visit.
      await context.addInitScript(() => {
        try {
          window.localStorage.setItem("perfidia.howToWatch.seen", "1");
        } catch {
          // Storage blocked: the overlay shows.
        }
      });
    }
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    try {
      const path = await shoot(page, o, w, h);
      process.stdout.write(`${path}\n`);
    } catch (e) {
      errors.push(`shot ${w}x${h}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      const path = `${o.out}-${w}x${h}-failed.png`;
      await page.screenshot({ path }).catch(() => undefined);
      process.stdout.write(`${path}\n`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
for (const e of errors) process.stderr.write(`${e}\n`);
process.exit(errors.length > 0 ? 1 : 0);
