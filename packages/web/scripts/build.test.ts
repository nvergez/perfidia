import { describe, expect, test } from "bun:test";
import { repoRelativeSources } from "./build.ts";

// The public source maps never record the builder's absolute path (docs/phase3.md §15).

describe("source map sources", () => {
  test("are relative to the repository root, wherever the build was written", () => {
    const repo = "/home/u/perfidia";
    expect(
      repoRelativeSources(
        [
          "../../../../../../home/u/perfidia/packages/protocol/src/ids.ts",
          "../src/main.tsx",
          "/home/u/perfidia/node_modules/react/index.js",
        ],
        "/home/u/perfidia/packages/web/dist",
        repo,
      ),
    ).toEqual([
      "packages/protocol/src/ids.ts",
      "packages/web/src/main.tsx",
      "node_modules/react/index.js",
    ]);
    expect(
      repoRelativeSources(["../../../home/u/perfidia/packages/web/src/app.tsx"], "/tmp/a/b", repo),
    ).toEqual(["packages/web/src/app.tsx"]);
  });

  test("a source outside the repository keeps only its file name", () => {
    expect(repoRelativeSources(["../../secret/x.ts"], "/tmp/a/b", "/home/u/perfidia")).toEqual([
      "external/x.ts",
    ]);
  });
});
