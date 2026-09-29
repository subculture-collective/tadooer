import { join } from "node:path";
import { expect } from "vitest";
import {
  SuiteDatabase,
  type CalendarBridgeDirectionName,
  type CalendarBridgeInitialSync,
} from "@suite/persistence";
import { runBridgeOnce } from "./engine.ts";
import {
  calDavCollectionPath,
  createFakeCalDav,
  createFakeGoogleCalendar,
  type FakeCalDav,
  type FakeGoogleCalendar,
} from "./fakes.ts";
import { createCalDavBridgeSide, createGoogleBridgeSide } from "./providers.ts";

/**
 * Test harness for bridge passes against the fake providers (ADR 0041,
 * ADR 0042): one owner, one mapping, a reopenable database.
 */
export const owner = "11111111-1111-4111-8111-111111111111";
export const now = "2026-09-25T12:00:00.000Z";

export interface Harness {
  readonly google: FakeGoogleCalendar;
  readonly baikal: FakeCalDav;
  database: SuiteDatabase;
  readonly mappingId: string;
  run(): ReturnType<typeof runBridgeOnce>;
  reopen(): void;
  links(): ReturnType<SuiteDatabase["calendarBridge"]["listLinks"]>;
  writes(): number;
}

export const harness = (
  directory: string,
  options: {
    readonly direction?: CalendarBridgeDirectionName;
    readonly initialSync?: CalendarBridgeInitialSync;
  } = {},
): Harness => {
  const path = join(directory, "suite.sqlite");
  const google = createFakeGoogleCalendar();
  const baikal = createFakeCalDav();
  let database = SuiteDatabase.open(path);
  database.createOwner({
    id: owner,
    username: "owner",
    displayName: "Owner",
    passwordHash: "hash",
    createdAt: now,
  });
  const googleProvider = database.ensureCalendarProvider(
    owner,
    "google",
    "google-connector",
    now,
  );
  const [googleCalendar] = database.putCalendarCollections(
    googleProvider.id,
    [
      {
        href: google.calendarId,
        displayName: "Primary",
        supportsEvents: true,
        supportsTodos: false,
      },
    ],
    now,
  );
  const baikalProvider = database.ensureCalendarProvider(
    owner,
    "baikal",
    "baikal-connector",
    now,
  );
  const [baikalCalendar] = database.putCalendarCollections(
    baikalProvider.id,
    [
      {
        href: calDavCollectionPath,
        displayName: "Work",
        supportsEvents: true,
        supportsTodos: false,
      },
    ],
    now,
  );
  const created = database.calendarBridge.createMapping({
    id: "22222222-2222-4222-8222-222222222222",
    ownerId: owner,
    googleCalendarId: googleCalendar?.id ?? "",
    baikalCalendarId: baikalCalendar?.id ?? "",
    direction: options.direction ?? "two_way",
    initialSync: options.initialSync ?? "copy_existing",
    now,
  });
  if (created.kind !== "created") throw new Error(created.kind);
  const h: Harness = {
    google,
    baikal,
    database,
    mappingId: created.mapping.id,
    run: () => {
      const mapping = h.database.calendarBridge.getMapping(owner, h.mappingId);
      if (mapping === undefined) throw new Error("mapping missing");
      return runBridgeOnce({
        store: h.database.calendarBridge,
        mapping,
        now,
        google: createGoogleBridgeSide({
          accessToken: "bridge-access",
          calendarId: google.calendarId,
          fetch: google.fetch,
        }),
        baikal: createCalDavBridgeSide({
          collectionUrl: new URL(`http://baikal.test${calDavCollectionPath}`),
          username: "alice",
          password: "secret",
          now,
          fetch: baikal.fetch,
        }),
      });
    },
    reopen: () => {
      h.database.close();
      database = SuiteDatabase.open(path);
      h.database = database;
    },
    links: () => h.database.calendarBridge.listLinks(h.mappingId),
    writes: () => google.writes.length + baikal.writes.length,
  };
  return h;
};

export const googleTimed = (summary: string, hour = 15) => ({
  summary,
  start: { dateTime: `2026-10-01T${String(hour)}:00:00Z`, timeZone: "UTC" },
  end: { dateTime: `2026-10-01T${String(hour + 1)}:00:00Z`, timeZone: "UTC" },
});

export const onlyBaikal = (h: Harness) => {
  expect(h.baikal.resources.size).toBe(1);
  const [entry] = [...h.baikal.resources.entries()];
  if (entry === undefined) throw new Error("no Baikal resource");
  return { href: entry[0], ...entry[1] };
};

export const approve = (h: Harness, linkId: string) => {
  const link = h.database.calendarBridge.getLink(linkId);
  const result = h.database.calendarBridge.approveDeletion({
    ownerId: owner,
    mappingId: h.mappingId,
    linkId,
    expectedRevision: link?.revision ?? 0,
    now,
  });
  expect(result.kind).toBe("approved");
};
