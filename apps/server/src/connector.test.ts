import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "@suite/persistence";
import { BaikalConnectorService } from "./connector.ts";

const multistatus = (body: string): string =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;

const discoveryFetch: typeof fetch = (input) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const documents = new Map([
    [
      "http://baikal.test/dav.php/",
      multistatus(
        `<D:response><D:href>/dav.php/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav.php/principals/alice/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      ),
    ],
    [
      "http://baikal.test/dav.php/principals/alice/",
      multistatus(
        `<D:response><D:href>/dav.php/principals/alice/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/dav.php/calendars/alice/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      ),
    ],
    [
      "http://baikal.test/dav.php/calendars/alice/",
      multistatus(
        `<D:response><D:href>/dav.php/calendars/alice/default/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Default</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      ),
    ],
  ]);
  return Promise.resolve(
    new Response(documents.get(url) ?? "", {
      status: documents.has(url) ? 207 : 404,
      headers: { "Content-Type": "application/xml" },
    }),
  );
};

describe("BaikalConnectorService", () => {
  it("stores only authenticated ciphertext and fails closed under another key", async () => {
    await withTemporaryDirectory(async (directory) => {
      const databasePath = join(directory, "suite.sqlite");
      const keyPath = join(directory, "credential.key");
      const database = SuiteDatabase.open(databasePath);
      database.createOwner({
        id: "d1054acd-c04d-4bd8-a814-254b007154ba",
        username: "owner",
        displayName: "Owner",
        passwordHash: "not-used",
        createdAt: "2026-08-05T00:00:00.000Z",
      });
      const connector = new BaikalConnectorService(
        database,
        new URL("http://baikal.test/dav.php/"),
        keyPath,
        discoveryFetch,
      );

      const connected = await connector.connect(
        "d1054acd-c04d-4bd8-a814-254b007154ba",
        "alice",
        "dav-password-that-must-not-leak",
      );
      expect(connected).toMatchObject({
        ok: true,
        status: { connected: true, calendars: [{ displayName: "Default" }] },
      });
      expect((statSync(keyPath).mode & 0o777).toString(8)).toBe("600");
      database.close();

      expect(
        readFileSync(databasePath).includes("dav-password-that-must-not-leak"),
      ).toBe(false);

      const reopened = SuiteDatabase.open(databasePath);
      const restoredConnector = new BaikalConnectorService(
        reopened,
        new URL("http://baikal.test/dav.php/"),
        keyPath,
        discoveryFetch,
      );
      expect(
        await restoredConnector.status("d1054acd-c04d-4bd8-a814-254b007154ba"),
      ).toMatchObject({
        ok: true,
        status: { connected: true, username: "alice" },
      });

      const wrongKeyConnector = new BaikalConnectorService(
        reopened,
        new URL("http://baikal.test/dav.php/"),
        join(directory, "wrong.key"),
        discoveryFetch,
      );
      expect(
        await wrongKeyConnector.status("d1054acd-c04d-4bd8-a814-254b007154ba"),
      ).toEqual({
        ok: false,
        reason: "credential-unavailable",
      });
      reopened.close();
    });
  });
});
