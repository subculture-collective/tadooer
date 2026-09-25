import { z } from "zod";

// Imported plugin data (issue #66, ADR 0026). Local copies avoid an import
// cycle with index.ts, which re-exports this file.
const id = z.uuid();
const revision = z.number().int().positive();
const timestamp = z.iso.datetime();

/**
 * Bounds for opaque plugin records. Super Productivity 19.1.0 caps one plugin
 * write at 256 KiB before compression and accepts stored values up to 1 MiB
 * characters on read; Tadooer keeps up to 1 MiB of UTF-8 per entry. Keys
 * follow the source limit of 256 characters.
 */
export const pluginDataLimits = {
  dataBytes: 1024 * 1024,
  dataLabel: "1 MiB",
  keyLength: 256,
  pluginIdLength: 200,
} as const;

/**
 * A plugin ID as Super Productivity writes it: nonempty, no `:` (the source
 * reserves it as the key delimiter) and no control characters.
 */
export const validPluginId = (value: string): boolean =>
  value.length > 0 &&
  value.length <= pluginDataLimits.pluginIdLength &&
  !Array.from({ length: value.length }, (_, index) =>
    value.charCodeAt(index),
  ).some((code) => code === 0x3a || code <= 0x1f || code === 0x7f);

export const pluginIdSchema = z
  .string()
  .refine(validPluginId, { message: "Plugin ID is invalid" });

/**
 * `gzip_base64` marks Super Productivity's `GZ1:` compressed form. Tadooer
 * reads only that prefix; it never decodes, parses or runs the data.
 */
export const pluginDataFormatSchema = z.enum(["text", "gzip_base64"]);

/** Listing record: size and identity only, never the data itself. */
export const pluginDataEntrySchema = z
  .object({
    id,
    pluginId: pluginIdSchema,
    /** Null for the plugin's unkeyed entry. */
    key: z.string().min(1).max(pluginDataLimits.keyLength).nullable(),
    byteLength: z.number().int().nonnegative().max(pluginDataLimits.dataBytes),
    format: pluginDataFormatSchema,
    source: z.literal("super_productivity"),
    revision,
    importedAt: timestamp,
  })
  .strict();

/** An imported plugin's enabled flag. Inert: nothing is loaded or run. */
export const pluginMetadataSchema = z
  .object({
    id,
    pluginId: pluginIdSchema,
    enabled: z.boolean(),
    source: z.literal("super_productivity"),
    revision,
    importedAt: timestamp,
  })
  .strict();

export const pluginDataListResponseSchema = z
  .object({
    plugins: z.array(pluginMetadataSchema),
    entries: z.array(pluginDataEntrySchema),
  })
  .strict();

/**
 * One entry with its opaque data, for the owner's download. The data is a
 * JSON string, so text that is not valid UTF-8 (for example a lone surrogate)
 * keeps its exact code units.
 */
export const pluginDataContentResponseSchema = z
  .object({
    entry: pluginDataEntrySchema,
    data: z.string(),
  })
  .strict();

export type PluginDataEntry = z.infer<typeof pluginDataEntrySchema>;
export type PluginMetadata = z.infer<typeof pluginMetadataSchema>;
export type PluginDataListResponse = z.infer<
  typeof pluginDataListResponseSchema
>;
export type PluginDataContentResponse = z.infer<
  typeof pluginDataContentResponseSchema
>;

/** Reads only the `GZ1:` prefix; never decodes the value. */
export const pluginDataFormat = (
  data: string,
): z.infer<typeof pluginDataFormatSchema> =>
  data.startsWith("GZ1:") ? "gzip_base64" : "text";

/**
 * The downloaded file is the Super Productivity `pluginUserData` entry,
 * `{ id, data }`, serialized as JSON. JSON escapes keep every code unit.
 */
export const pluginDataDownload = (
  entry: Pick<PluginDataEntry, "pluginId" | "key">,
  data: string,
): { readonly fileName: string; readonly text: string } => {
  const sourceId =
    entry.key === null ? entry.pluginId : `${entry.pluginId}:${entry.key}`;
  const safe = (value: string) =>
    value.replaceAll(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "entry";
  return {
    fileName: `plugin-data-${safe(entry.pluginId)}${entry.key === null ? "" : `-${safe(entry.key)}`}.json`,
    text: JSON.stringify({ id: sourceId, data }),
  };
};
