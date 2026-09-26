import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DataRestorePreview } from "@suite/contracts";
import {
  DataExportRestoreView,
  outcomeMessage,
  type DataExportRestoreViewProps,
} from "./DataExportRestore.tsx";

// Data export and restore card (issue #93, ADR 0034).
const preview: DataRestorePreview = {
  inputHash: "a".repeat(64),
  exportedAt: "2026-09-25T12:00:00.000Z",
  source: {
    instanceId: "00000000-0000-4000-8000-000000000001",
    migrationCount: 36,
    appVersion: "test",
    appRevision: "test",
  },
  owner: {
    id: "00000000-0000-4000-8000-000000000002",
    username: "organizer",
    displayName: "Organizer",
    createdAt: "2026-09-01T00:00:00.000Z",
  },
  sameOwner: false,
  sameInstance: false,
  counts: [
    { table: "tasks", rows: 12 },
    { table: "projects", rows: 2 },
  ],
  totalRows: 14,
  target: { counts: [], totalRows: 0, empty: true },
  issues: [],
  canApply: true,
};

const disabledButton = (label: string) =>
  new RegExp(`<button[^>]* disabled=""[^>]*>${label}</button>`);

const props = (
  overrides: Partial<DataExportRestoreViewProps> = {},
): DataExportRestoreViewProps => ({
  busy: false,
  online: true,
  exportError: null,
  fileName: null,
  preview: null,
  restoreError: null,
  outcome: null,
  approved: false,
  replaceChosen: false,
  onExport: vi.fn(),
  onChooseFile: vi.fn(),
  onPreview: vi.fn(),
  onApprove: vi.fn(),
  onChooseReplace: vi.fn(),
  onApply: vi.fn(),
  ...overrides,
});

describe("data export and restore card", () => {
  it("offers the download and disables preview until a file is chosen", () => {
    const html = renderToStaticMarkup(<DataExportRestoreView {...props()} />);
    expect(html).toContain("Download data export");
    expect(html).toContain("no passwords, sessions, assistant credentials");
    expect(html).toMatch(disabledButton("Preview restore"));
    expect(html).not.toContain("Restore export");
  });

  it("summarizes a preview into an empty account and gates apply on the confirmation", () => {
    const unconfirmed = renderToStaticMarkup(
      <DataExportRestoreView
        {...props({ fileName: "export.json", preview })}
      />,
    );
    expect(unconfirmed).toContain("12 tasks · 2 projects");
    expect(unconfirmed).toContain("another server");
    expect(unconfirmed).toContain("no data yet");
    expect(unconfirmed).not.toContain("Replace all existing data");
    expect(unconfirmed).toMatch(disabledButton("Restore export"));
    expect(unconfirmed).toContain("a".repeat(64));
    const confirmed = renderToStaticMarkup(
      <DataExportRestoreView
        {...props({ fileName: "export.json", preview, approved: true })}
      />,
    );
    expect(confirmed).toMatch(/<button[^>]*>Restore export<\/button>/);
    expect(confirmed).not.toMatch(disabledButton("Restore export"));
  });

  it("requires the explicit replace choice when the account already has data", () => {
    const populated: DataRestorePreview = {
      ...preview,
      sameInstance: true,
      target: {
        counts: [{ table: "tasks", rows: 3 }],
        totalRows: 3,
        empty: false,
      },
    };
    const approvedOnly = renderToStaticMarkup(
      <DataExportRestoreView
        {...props({
          fileName: "export.json",
          preview: populated,
          approved: true,
        })}
      />,
    );
    expect(approvedOnly).toContain("already has 3 rows");
    expect(approvedOnly).toContain("Replace all existing data");
    expect(approvedOnly).toMatch(disabledButton("Replace and restore"));
    const both = renderToStaticMarkup(
      <DataExportRestoreView
        {...props({
          fileName: "export.json",
          preview: populated,
          approved: true,
          replaceChosen: true,
        })}
      />,
    );
    expect(both).not.toMatch(disabledButton("Replace and restore"));
  });

  it("lists blocking issues instead of the apply controls", () => {
    const blocked = renderToStaticMarkup(
      <DataExportRestoreView
        {...props({
          fileName: "export.json",
          preview: {
            ...preview,
            canApply: false,
            issues: [
              { code: "NEWER_SCHEMA", detail: "Update the server first." },
            ],
          },
        })}
      />,
    );
    expect(blocked).toContain("Update the server first.");
    expect(blocked).not.toContain("Restore export");
    expect(blocked).not.toContain("I reviewed the preview");
  });

  it("describes the outcome", () => {
    expect(
      outcomeMessage({
        mode: "replace",
        restored: [],
        totalRows: 14,
        deletedRows: 3,
        restoredAt: "2026-09-25T13:00:00.000Z",
      }),
    ).toContain("Replaced 3 existing rows and restored 14 rows.");
    expect(
      outcomeMessage({
        mode: "empty-only",
        restored: [],
        totalRows: 14,
        deletedRows: 0,
        restoredAt: "2026-09-25T13:00:00.000Z",
      }),
    ).toContain("Restored 14 rows.");
  });
});
