import type {
  BaikalConnectorRecord,
  CalendarEventProjectionRecord,
  CalendarWriteOperationRecord,
  CalendarWriteReservationResult,
  GoogleCalendarSyncRecord,
  GoogleConnectorRecord,
  OwnedCalendarRecord,
  PlanningPreferencesRecord,
  TaskCalendarBlockRecord,
} from "./index.js";

// Contracts for the adapters instantiated by SuiteDatabase. Transaction-spanning
// mutations remain on SuiteDatabase until an extraction preserves their authority.

export interface CredentialStore {
  getBaikalConnector(ownerId: string): BaikalConnectorRecord | undefined;
  upsertBaikalConnector(
    record: BaikalConnectorRecord & { readonly updatedAt: string },
  ): void;
  deleteBaikalConnector(ownerId: string): void;
  upsertGoogleConnector(record: GoogleConnectorRecord): void;
  getGoogleConnector(ownerId: string): GoogleConnectorRecord | undefined;
  deleteGoogleConnector(ownerId: string): boolean;
  upsertGoogleCalendarSync(record: GoogleCalendarSyncRecord): void;
  listGoogleCalendarSync(ownerId: string): readonly GoogleCalendarSyncRecord[];
  clearGoogleCalendarSync(ownerId: string): void;
}

export interface PlanningPreferencesStore {
  getPlanningPreferences(ownerId: string): PlanningPreferencesRecord;
  upsertPlanningPreferences(
    ownerId: string,
    record: PlanningPreferencesRecord,
  ): PlanningPreferencesRecord;
}

export interface CalendarProjectionStore {
  listProjectedEvents(
    ownerId: string,
    from: string,
    to: string,
  ): readonly CalendarEventProjectionRecord[];

  listOwnedCalendars(ownerId: string): readonly OwnedCalendarRecord[];

  upsertProjectionBatch(
    records: readonly Omit<
      CalendarEventProjectionRecord,
      "ownerId" | "providerKind" | "providerDisplayLabel" | "calendarName"
    >[],
  ): void;

  reserveCalendarWrite(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly expectedTaskRevision: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly providerId: string;
    readonly calendarHref: string;
    readonly href: string;
    readonly uid: string;
    readonly now: string;
  }): CalendarWriteReservationResult;

  completeCalendarWrite(operationId: string): void;

  getCalendarWrite(
    ownerId: string,
    operationId: string,
  ): CalendarWriteOperationRecord | undefined;

  listTaskCalendarBlocks(
    ownerId: string,
    taskId: string,
  ): readonly TaskCalendarBlockRecord[];

  deleteTaskCalendarBlock(ownerId: string, blockId: string): void;

  listPublishedCalendarRaw(
    ownerId: string,
    calendarId: string,
  ): readonly string[];
}
