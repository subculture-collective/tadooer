import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { dataExportExcludedTables, SuiteDatabase } from "./index.ts";

/** Trusted-device session storage (ADR 0048, issue #115). */

const at = (minutes: number): string =>
  new Date(
    Date.parse("2026-10-02T08:00:00.000Z") + minutes * 60_000,
  ).toISOString();
const far = "2027-03-31T08:00:00.000Z";

const open = (directory: string): SuiteDatabase => {
  const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
  database.createOwner({
    id: "owner-1",
    username: "owner",
    displayName: "Owner",
    passwordHash: "not-a-real-hash",
    createdAt: at(0),
  });
  return database;
};

const trusted = (
  database: SuiteDatabase,
  tokenHash: string,
  deviceId: string,
  label = "Laptop",
): void => {
  database.createSession({
    tokenHash,
    ownerId: "owner-1",
    csrfHash: `${tokenHash}-csrf`,
    issuedAt: at(0),
    idleExpiresAt: far,
    absoluteExpiresAt: far,
    revokedAt: null,
    device: { id: deviceId, label, addressFamily: "ipv4" },
  });
};

const retiredCount = (directory: string): number => {
  const raw = new DatabaseSync(join(directory, "suite.sqlite"), {
    readOnly: true,
  });
  try {
    const row = raw
      .prepare("SELECT COUNT(*) AS count FROM web_session_retired_tokens")
      .get() as { count: number };
    return row.count;
  } finally {
    raw.close();
  }
};

describe("trusted-device session storage", () => {
  it("keeps an ordinary session free of device state", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        database.createSession({
          tokenHash: "browser",
          ownerId: "owner-1",
          csrfHash: "browser-csrf",
          issuedAt: at(0),
          idleExpiresAt: at(30),
          absoluteExpiresAt: at(720),
          revokedAt: null,
        });
        database.refreshSession("browser", at(5), at(35));
        expect(database.findSession("browser")).toEqual({
          tokenHash: "browser",
          ownerId: "owner-1",
          csrfHash: "browser-csrf",
          issuedAt: at(0),
          lastSeenAt: at(5),
          idleExpiresAt: at(35),
          absoluteExpiresAt: at(720),
          revokedAt: null,
          deviceId: null,
          deviceLabel: null,
          lastAddressFamily: null,
          tokenRotatedAt: null,
          nextTokenHash: null,
          nextIssuedAt: null,
          passwordConfirmedAt: null,
          revokedReason: null,
        });
        expect(database.deviceSessions.listDevices("owner-1", at(6))).toEqual(
          [],
        );
        expect(database.revokeSession("browser", at(6))).toBe(true);
        expect(database.findSession("browser")?.revokedReason).toBe(
          "signed-out",
        );
        // As before ADR 0048: a revoked or expired session is removed.
        database.deleteExpiredSessions(at(7));
        expect(database.findSession("browser")).toBeUndefined();
      } finally {
        database.close();
      }
    });
  });

  it("persists a device, its outstanding successor and its retired tokens across a restart", async () => {
    await withTemporaryDirectory((directory) => {
      let database = open(directory);
      try {
        trusted(database, "token-1", "device-1");
        const store = database.deviceSessions;
        expect(store.findByDevice("device-1")).toMatchObject({
          tokenHash: "token-1",
          deviceLabel: "Laptop",
          lastAddressFamily: "ipv4",
          tokenRotatedAt: at(0),
          passwordConfirmedAt: at(0),
          nextTokenHash: null,
        });

        store.issueNextToken("device-1", "token-2", at(1440));
        database.refreshSession("token-1", at(1441), far, "ipv6");
        expect(store.confirmPassword("token-1", at(1442))).toBe(true);
        database.close();

        database = SuiteDatabase.open(join(directory, "suite.sqlite"));
        const reopened = database.deviceSessions;
        // The current token is still the one the device is known to hold.
        expect(reopened.findByToken("token-1")).toMatchObject({
          deviceId: "device-1",
          nextTokenHash: "token-2",
          nextIssuedAt: at(1440),
          lastSeenAt: at(1441),
          lastAddressFamily: "ipv6",
          passwordConfirmedAt: at(1442),
        });
        expect(reopened.findByNextToken("token-2")?.deviceId).toBe("device-1");
        expect(reopened.findRetiredToken("token-1")).toBeUndefined();

        // The device presents the successor.
        expect(reopened.promoteNextToken("token-2", at(1450))).toBe(true);
        expect(reopened.promoteNextToken("token-2", at(1451))).toBe(false);
        expect(reopened.findByToken("token-1")).toBeUndefined();
        expect(reopened.findByToken("token-2")).toMatchObject({
          deviceId: "device-1",
          tokenRotatedAt: at(1440),
          nextTokenHash: null,
          nextIssuedAt: null,
          csrfHash: "token-1-csrf",
        });
        expect(reopened.findRetiredToken("token-1")).toEqual({
          deviceId: "device-1",
          retiredAt: at(1450),
        });

        // A successor that was never presented is retired by the next one.
        reopened.issueNextToken("device-1", "token-3", at(2900));
        reopened.issueNextToken("device-1", "token-4", at(2960));
        expect(reopened.findRetiredToken("token-3")).toEqual({
          deviceId: "device-1",
          retiredAt: at(2960),
        });
        expect(reopened.findByNextToken("token-4")?.tokenHash).toBe("token-2");
      } finally {
        database.close();
      }
    });
  });

  it("renames and revokes devices of the owner only", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        trusted(database, "token-a", "device-a", "Laptop");
        trusted(database, "token-b", "device-b", "Phone");
        const store = database.deviceSessions;
        expect(store.renameDevice("someone-else", "device-b", "Mine")).toBe(
          false,
        );
        expect(store.renameDevice("owner-1", "device-b", "Pixel")).toBe(true);
        expect(
          store.revokeDevice("someone-else", "device-b", at(1), "signed-out"),
        ).toBe(false);
        expect(
          store
            .listDevices("owner-1", at(1))
            .map(({ deviceLabel }) => deviceLabel),
        ).toEqual(["Laptop", "Pixel"]);
        expect(
          store.revokeDevice("owner-1", "device-b", at(2), "revoked-by-owner"),
        ).toBe(true);
        expect(store.findByDevice("device-b")).toMatchObject({
          revokedAt: at(2),
          revokedReason: "revoked-by-owner",
        });
        expect(store.renameDevice("owner-1", "device-b", "Gone")).toBe(false);
        expect(store.listDevices("owner-1", at(3))).toHaveLength(1);
        expect(store.revokeOthers("owner-1", "token-a", at(3))).toBe(0);
        // A device past its idle expiry is not listed either.
        expect(store.listDevices("owner-1", far)).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it("removes dead sessions with their retired tokens and keeps a token-reuse record for its retention", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        const store = database.deviceSessions;
        for (const name of ["a", "b", "c"]) {
          trusted(database, `token-${name}`, `device-${name}`);
          store.issueNextToken(`device-${name}`, `next-${name}`, at(1));
          expect(store.promoteNextToken(`next-${name}`, at(2))).toBe(true);
        }
        expect(retiredCount(directory)).toBe(3);
        expect(store.revoke("next-a", at(3), "revoked-by-owner")).toBe(true);
        expect(store.revoke("next-b", at(3), "token-reuse")).toBe(true);

        // Device a is removed at once. Device b is the security record and
        // stays until the retention cutoff passes its revocation.
        database.deleteExpiredSessions(at(10), at(0));
        expect(store.findByDevice("device-a")).toBeUndefined();
        expect(
          store
            .listTokenReuseRevocations("owner-1", at(0))
            .map(({ deviceId, revokedAt }) => [deviceId, revokedAt]),
        ).toEqual([["device-b", at(3)]]);
        expect(store.listTokenReuseRevocations("owner-1", at(3))).toEqual([]);
        expect(store.findByDevice("device-c")?.revokedAt).toBeNull();
        expect(retiredCount(directory)).toBe(2);

        database.deleteExpiredSessions(at(11), at(3));
        expect(store.findByDevice("device-b")).toBeUndefined();
        expect(retiredCount(directory)).toBe(1);

        // Device c passes its expiry.
        database.deleteExpiredSessions(far, at(3));
        expect(store.findByDevice("device-c")).toBeUndefined();
        expect(retiredCount(directory)).toBe(0);
      } finally {
        database.close();
      }
    });
  });

  it("keeps devices, tokens and security records out of the owner export", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        trusted(database, "token-digest-1", "device-1", "Laptop of the owner");
        database.deviceSessions.issueNextToken(
          "device-1",
          "token-digest-2",
          at(1),
        );
        database.deviceSessions.promoteNextToken("token-digest-2", at(2));
        database.deviceSessions.revoke("token-digest-2", at(3), "token-reuse");
        expect(dataExportExcludedTables).toEqual(
          expect.arrayContaining([
            "web_sessions",
            "web_session_retired_tokens",
          ]),
        );
        const document = database.dataExport.export("owner-1", at(4), {
          appVersion: "test",
          appRevision: "test",
        });
        expect(document.tables).not.toHaveProperty("web_sessions");
        expect(document.tables).not.toHaveProperty(
          "web_session_retired_tokens",
        );
        const text = JSON.stringify(document);
        for (const secret of [
          "token-digest-1",
          "token-digest-2",
          "device-1",
          "Laptop of the owner",
          "token-reuse",
        ])
          expect(text, secret).not.toContain(secret);
      } finally {
        database.close();
      }
    });
  });
});
