import { z } from "zod";

// Owner data export and restore (issue #93, ADR 0034). The document is a
// copy of the owner's rows in every included SQLite table; secrets, sessions,
// connector credentials and encrypted subscription addresses are excluded by
// the persistence inventory and listed under `excludedTables`.

export const dataExportFormat = "tadooer.data-export";
export const dataExportVersion = 1;

/** Browser and HTTP budget for a restore upload. */
export const dataRestoreLimits = {
  bytes: 64 * 1024 * 1024,
  label: "64 MiB",
} as const;

export const dataRestoreModeSchema = z.enum(["empty-only", "replace"]);
export type DataRestoreMode = z.infer<typeof dataRestoreModeSchema>;

const cellSchema = z.union([z.string(), z.number(), z.null()]);
export const dataExportRowSchema = z.record(z.string(), cellSchema);
export type DataExportRow = z.infer<typeof dataExportRowSchema>;

export const dataExportSourceSchema = z
  .object({
    instanceId: z.string().min(1),
    migrationCount: z.number().int().nonnegative(),
    appVersion: z.string().nullable(),
    appRevision: z.string().nullable(),
  })
  .strict();

export const dataExportOwnerSchema = z
  .object({
    id: z.string().min(1),
    username: z.string().min(1),
    displayName: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const dataExportDocumentSchema = z
  .object({
    format: z.literal(dataExportFormat),
    version: z.literal(dataExportVersion),
    exportedAt: z.string(),
    source: dataExportSourceSchema,
    owner: dataExportOwnerSchema,
    tables: z.record(z.string(), z.array(dataExportRowSchema)),
    excludedTables: z.array(z.string()),
  })
  .strict();
export type DataExportDocument = z.infer<typeof dataExportDocumentSchema>;

export const dataTableCountSchema = z
  .object({ table: z.string(), rows: z.number().int().nonnegative() })
  .strict();

export const dataRestoreIssueSchema = z
  .object({
    code: z.enum([
      "NEWER_SCHEMA",
      "UNKNOWN_TABLE",
      "UNKNOWN_COLUMN",
      "EXCLUDED_TABLE",
    ]),
    detail: z.string().min(1),
  })
  .strict();
export type DataRestoreIssue = z.infer<typeof dataRestoreIssueSchema>;

export const dataRestorePreviewSchema = z
  .object({
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    exportedAt: z.string(),
    source: dataExportSourceSchema,
    owner: dataExportOwnerSchema,
    /** The export owner id equals the signed-in owner id. */
    sameOwner: z.boolean(),
    /** The export came from this installation. */
    sameInstance: z.boolean(),
    counts: z.array(dataTableCountSchema),
    totalRows: z.number().int().nonnegative(),
    target: z
      .object({
        counts: z.array(dataTableCountSchema),
        totalRows: z.number().int().nonnegative(),
        /** No content rows exist for the signed-in owner. */
        empty: z.boolean(),
      })
      .strict(),
    issues: z.array(dataRestoreIssueSchema),
    canApply: z.boolean(),
  })
  .strict();
export type DataRestorePreview = z.infer<typeof dataRestorePreviewSchema>;

export const dataRestoreApplyResponseSchema = z
  .object({
    mode: dataRestoreModeSchema,
    restored: z.array(dataTableCountSchema),
    totalRows: z.number().int().nonnegative(),
    deletedRows: z.number().int().nonnegative(),
    restoredAt: z.string(),
  })
  .strict();
export type DataRestoreApplyResponse = z.infer<
  typeof dataRestoreApplyResponseSchema
>;
