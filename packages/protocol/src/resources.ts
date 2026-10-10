import { z } from "zod";
import { UnitIdSchema } from "./ids.ts";
import { safeRecord } from "./json.ts";

/** The three resources of the brief, in canonical order. */
export const RESOURCE_IDS = ["wood", "stone", "gold"] as const;
export const ResourceIdSchema = z.enum(RESOURCE_IDS);
export type ResourceId = z.infer<typeof ResourceIdSchema>;

const Amount = z.int().nonnegative();

/**
 * An amount of each resource. Whole units in costs, cargo, views and events; resource-seconds
 * (whole × `resourceScale`) in `City.stock` (§4.2, §4.3).
 */
export const ResSchema = z.strictObject({ wood: Amount, stone: Amount, gold: Amount });
export type Res = z.infer<typeof ResSchema>;

/** Unit counts by unit id. Zero entries are omitted, so every count is ≥ 1. */
export const UnitCountsSchema = safeRecord(UnitIdSchema, z.int().positive());
export type UnitCounts = z.infer<typeof UnitCountsSchema>;
