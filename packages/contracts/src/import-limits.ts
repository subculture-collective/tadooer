/** Shared browser, HTTP and parser budgets for full task-backup imports. */
export const superProductivityImportLimits = {
  bytes: 16 * 1024 * 1024,
  label: "16 MiB",
  records: 50_000,
  issues: 100_000,
} as const;
