import { pluginDataLimits, validPluginId } from "@suite/contracts";
import type { FieldDisposition } from "./super-productivity-schema.ts";

/**
 * Super Productivity 19.1.0 plugin sections (issue #66, ADR 0026).
 *
 * `pluginUserData` is an array of `{ id, data }`: `id` is the plugin ID or
 * `pluginId:key`, and `data` is the plugin's string, stored as written or as
 * `GZ1:` gzip+base64. `pluginMetadata` is an array of `{ id, isEnabled }`.
 * Both are kept as inert records. The importer never decodes, parses or runs
 * the data, and its findings never repeat the data or the key.
 */
export const superProductivityPluginUserDataFields = {
  id: "applied",
  data: "applied",
} as const satisfies Record<string, FieldDisposition>;

export const superProductivityPluginMetadataFields = {
  id: "applied",
  isEnabled: "applied",
} as const satisfies Record<string, FieldDisposition>;

export interface SuperProductivityPluginDataEntry {
  readonly sourceId: string;
  readonly pluginId: string;
  readonly key: string | null;
  readonly data: string;
}

export interface SuperProductivityPluginMetadata {
  readonly pluginId: string;
  readonly enabled: boolean;
}

export interface SuperProductivityPlugins {
  readonly entries: readonly SuperProductivityPluginDataEntry[];
  readonly plugins: readonly SuperProductivityPluginMetadata[];
}

type Issue = (code: string, sourceId: string | null, detail: string) => void;

const object = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Splits a source entity ID at its first `:` as Super Productivity does. */
const splitSourceId = (
  sourceId: string,
): { pluginId: string; key: string | null } | undefined => {
  const index = sourceId.indexOf(":");
  const pluginId = index === -1 ? sourceId : sourceId.slice(0, index);
  const key = index === -1 ? null : sourceId.slice(index + 1);
  if (!validPluginId(pluginId)) return undefined;
  if (key !== null && (key === "" || key.length > pluginDataLimits.keyLength))
    return undefined;
  return { pluginId, key };
};

const bytes = (count: number) =>
  `${count.toLocaleString("en-US")} byte${count === 1 ? "" : "s"}`;

/**
 * Maps both plugin sections. A malformed section or entry blocks with
 * `plugin_data_invalid`; findings name the plugin ID and entry position only.
 */
export const mapPluginSections = (
  data: Readonly<Record<string, unknown>>,
  issue: Issue,
): SuperProductivityPlugins => {
  const entries: SuperProductivityPluginDataEntry[] = [];
  const plugins: SuperProductivityPluginMetadata[] = [];
  const invalid = (sourceId: string | null, detail: string) => {
    issue("plugin_data_invalid", sourceId, detail);
  };
  const list = (name: string): unknown[] => {
    const value = data[name];
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    invalid(null, `${name} must be a list of plugin records`);
    return [];
  };
  const unreviewed = (
    name: string,
    position: number,
    pluginId: string | null,
    record: Readonly<Record<string, unknown>>,
    fields: Readonly<Record<string, FieldDisposition>>,
  ) => {
    for (const field of Object.keys(record))
      if (!Object.hasOwn(fields, field))
        invalid(
          pluginId,
          `${name} entry ${String(position + 1)} has unreviewed field ${field.slice(0, 64)}`,
        );
  };

  const seenEntries = new Set<string>();
  list("pluginUserData").forEach((value, position) => {
    const label = `pluginUserData entry ${String(position + 1)}`;
    const record = object(value);
    if (record === undefined) {
      invalid(null, `${label} must be an object with id and data`);
      return;
    }
    const sourceId = typeof record.id === "string" ? record.id : undefined;
    const identity =
      sourceId === undefined ? undefined : splitSourceId(sourceId);
    const pluginId = identity?.pluginId ?? null;
    unreviewed(
      "pluginUserData",
      position,
      pluginId,
      record,
      superProductivityPluginUserDataFields,
    );
    if (sourceId === undefined || identity === undefined) {
      invalid(
        pluginId,
        `${label} needs a plugin ID without control characters, optionally followed by :key of at most ${String(pluginDataLimits.keyLength)} characters`,
      );
      return;
    }
    if (typeof record.data !== "string") {
      invalid(pluginId, `${label} data must be text`);
      return;
    }
    const size = Buffer.byteLength(record.data, "utf8");
    if (size > pluginDataLimits.dataBytes) {
      invalid(
        pluginId,
        `${label} holds ${bytes(size)}; the limit is ${pluginDataLimits.dataLabel}`,
      );
      return;
    }
    if (seenEntries.has(sourceId)) {
      invalid(pluginId, `${label} repeats an earlier entry's ID`);
      return;
    }
    seenEntries.add(sourceId);
    entries.push({
      sourceId,
      pluginId: identity.pluginId,
      key: identity.key,
      data: record.data,
    });
  });

  const seenPlugins = new Set<string>();
  list("pluginMetadata").forEach((value, position) => {
    const label = `pluginMetadata entry ${String(position + 1)}`;
    const record = object(value);
    if (record === undefined) {
      invalid(null, `${label} must be an object with id and isEnabled`);
      return;
    }
    const pluginId =
      typeof record.id === "string" && validPluginId(record.id)
        ? record.id
        : null;
    unreviewed(
      "pluginMetadata",
      position,
      pluginId,
      record,
      superProductivityPluginMetadataFields,
    );
    if (pluginId === null) {
      invalid(
        null,
        `${label} needs a plugin ID without : or control characters`,
      );
      return;
    }
    if (typeof record.isEnabled !== "boolean") {
      invalid(pluginId, `${label} isEnabled must be Boolean`);
      return;
    }
    if (seenPlugins.has(pluginId)) {
      invalid(pluginId, `${label} repeats an earlier plugin`);
      return;
    }
    seenPlugins.add(pluginId);
    plugins.push({ pluginId, enabled: record.isEnabled });
  });

  if (entries.length + plugins.length > 0) {
    const pluginCount = new Set([
      ...entries.map(({ pluginId }) => pluginId),
      ...plugins.map(({ pluginId }) => pluginId),
    ]).size;
    const total = entries.reduce(
      (sum, { data }) => sum + Buffer.byteLength(data, "utf8"),
      0,
    );
    issue(
      "plugin_data_preserved",
      null,
      `${String(entries.length)} plugin data entr${entries.length === 1 ? "y" : "ies"} (${bytes(total)}) and ${String(plugins.length)} plugin metadata record${plugins.length === 1 ? "" : "s"} from ${String(pluginCount)} plugin${pluginCount === 1 ? "" : "s"} are kept as inert records. Plugin code is not imported or run.`,
    );
  }
  return { entries, plugins };
};
