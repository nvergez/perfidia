import { z } from "zod";

// Placeholder until the real protocol schemas land.
export const PROTOCOL_PACKAGE = "@perfidia/protocol";

export const PackageNameSchema = z.string().startsWith("@perfidia/");
export type PackageName = z.infer<typeof PackageNameSchema>;
