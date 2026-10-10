import { expect, test } from "bun:test";
import fc from "fast-check";
import { PackageNameSchema, PROTOCOL_PACKAGE } from "./index.ts";

test("protocol placeholder validates its own package name", () => {
  expect(PackageNameSchema.parse(PROTOCOL_PACKAGE)).toBe("@perfidia/protocol");
});

test("names outside the @perfidia scope are rejected", () => {
  fc.assert(
    fc.property(fc.string(), (name) => {
      fc.pre(!name.startsWith("@perfidia/"));
      expect(PackageNameSchema.safeParse(name).success).toBe(false);
    }),
  );
});
