import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  automationCalendarBridgeResourceSchema,
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  baikalStatusResponseSchema,
  calendarBridgeMappingPreviewResponseSchema,
  calendarBridgeMappingSchema,
  calendarBridgeOverviewResponseSchema,
  calendarBridgeReviewResponseSchema,
  createAutomationTokenResponseSchema,
  googleConnectorStatusResponseSchema,
} from "@suite/contracts";
import { googleBridgeScope } from "@suite/google-calendar";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  calDavCollectionPath,
  createFakeCalDav,
  createFakeGoogleCalendar,
  vevent,
} from "./calendar-bridge/fakes.ts";
import { startSuiteServer } from "./server.ts";

// Calendar bridge controls (issue #48, ADR 0044): owner overview, creation
// preview, review with both versions, declined deletions and the assistant's
// scoped, revision-bound review operations. Providers are fakes.

const hh = (hour: number): string => String(hour).padStart(2, "0");
const timed = (summary: string, hour: number) => ({
  summary,
  start: { dateTime: `2026-10-01T${hh(hour)}:00:00Z`, timeZone: "UTC" },
  end: { dateTime: `2026-10-01T${hh(hour + 1)}:00:00Z`, timeZone: "UTC" },
});

describe("calendar bridge controls", () => {
  it("previews, summarizes, reviews and lets a scoped assistant decide", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const oauthPath = join(directory, "google-oauth.json");
      const google = createFakeGoogleCalendar();
      const baikal = createFakeCalDav();
      const server = await startSuiteServer(
        {
          host: "127.0.0.1",
          port: 0,
          databasePath: join(directory, "suite.sqlite"),
          webRoot: join(directory, "web"),
          baikalEndpoint: "http://baikal.test/dav.php/",
          credentialKeyPath: join(directory, "credential.key"),
          googleOAuthConfigPath: oauthPath,
          secureCookies: false,
          build: { version: "test", revision: "bridge", builtAt: null },
        },
        {
          googleFetch: google.fetch,
          connectorFetch: baikal.fetch,
          disableNotificationTimer: true,
        },
      );
      const bodies: string[] = [];
      try {
        await writeFile(
          oauthPath,
          JSON.stringify({
            clientId: "client.apps.googleusercontent.com",
            clientSecret: "client-secret",
            redirectUri: `${server.baseUrl}/api/connectors/google/callback`,
          }),
          { mode: 0o600 },
        );
        await chmod(oauthPath, 0o600);
        const json = { "Content-Type": "application/json" };
        await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: { Origin: server.baseUrl, ...json },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { Origin: server.baseUrl, ...json },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const { csrfToken } = (await login.json()) as { csrfToken: string };
        const call = async (
          path: string,
          method = "GET",
          body?: unknown,
          headers: Record<string, string> = {},
        ): Promise<{ status: number; body: unknown }> => {
          const response = await fetch(`${server.baseUrl}${path}`, {
            method,
            redirect: "manual",
            headers: {
              Origin: server.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": csrfToken,
              ...(body === undefined ? {} : json),
              ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const text = await response.text();
          bodies.push(text);
          return {
            status: response.status,
            body: text === "" ? null : (JSON.parse(text) as unknown),
          };
        };
        const connectGoogle = async (access: "read" | "write") => {
          const authorization = await call(
            "/api/connectors/google/authorize",
            "POST",
            { access },
          );
          const state = new URL(
            (authorization.body as { authorizationUrl: string })
              .authorizationUrl,
          ).searchParams.get("state");
          const callback = await fetch(
            `${server.baseUrl}/api/connectors/google/callback?state=${encodeURIComponent(state ?? "")}&code=code`,
            { redirect: "manual" },
          );
          expect(callback.status).toBe(303);
        };

        const baikalCalendarId =
          baikalStatusResponseSchema.parse(
            (
              await call("/api/connectors/baikal", "PUT", {
                username: "alice",
                password: "secret",
              })
            ).body,
          ).calendars[0]?.id ?? "";
        await connectGoogle("read");
        const googleCalendarId =
          googleConnectorStatusResponseSchema.parse(
            (await call("/api/connectors/google")).body,
          ).calendars[0]?.id ?? "";
        const request = {
          googleCalendarId,
          baikalCalendarId,
          direction: "two_way",
          initialSync: "copy_existing",
        };
        const preview = async (body: unknown) => {
          const answer = await call(
            "/api/calendar-bridge/mappings/preview",
            "POST",
            body,
          );
          expect(answer.status).toBe(200);
          return calendarBridgeMappingPreviewResponseSchema.parse(answer.body);
        };

        // Without write consent the preview names the refusal and writes nothing.
        expect((await preview(request)).refusals).toEqual(["consent-required"]);
        expect(
          (
            await call("/api/calendar-bridge/mappings/preview", "POST", {
              ...request,
              initialSync: "everything",
            })
          ).status,
        ).toBe(400);
        google.grantScopes = [googleBridgeScope];
        await connectGoogle("write");
        google.userCreate("evtone", timed("Planning review", 9));
        expect(
          (await call("/api/connectors/google/sync", "POST", {})).status,
        ).toBe(200);
        const copying = await preview(request);
        expect(copying.refusals).toEqual([]);
        expect(copying.copies).toMatchObject([
          {
            from: "google",
            to: "baikal",
            existing: 1,
            copied: 1,
            sample: [{ summary: "Planning review" }],
          },
          { from: "baikal", to: "google" },
        ]);
        expect(
          (await preview({ ...request, initialSync: "new_only" })).copies[0],
        ).toMatchObject({ existing: 1, copied: 0 });
        expect(
          (await preview({ ...request, direction: "google_to_baikal" })).copies,
        ).toHaveLength(1);
        expect(baikal.writes).toEqual([]);
        expect(google.writes).toEqual([]);

        const mapping = calendarBridgeMappingSchema.parse(
          (
            (await call("/api/calendar-bridge/mappings", "POST", request))
              .body as { mapping: unknown }
          ).mapping,
        );
        expect((await preview(request)).refusals).toEqual(["calendar-in-use"]);
        const overview = async () =>
          calendarBridgeOverviewResponseSchema.parse(
            (await call("/api/calendar-bridge/overview")).body,
          ).mappings[0];
        expect(await overview()).toMatchObject({
          googleCalendarName: "Primary",
          baikalCalendarName: "Work",
          state: "not-run",
          stale: false,
          attention: ["not-run"],
        });
        const base = `/api/calendar-bridge/mappings/${mapping.id}`;
        const run = async () => {
          const answer = await call(`${base}/run`, "POST");
          expect(answer.status).toBe(200);
        };
        await run();
        expect(await overview()).toMatchObject({
          state: "ok",
          attention: [],
          counts: { links: 1, active: 1, pendingWrites: 0, conflicts: 0 },
        });

        // A concurrent edit keeps both versions for review.
        const baikalName = (uid: string): string => {
          for (const [href, resource] of baikal.resources)
            if (resource.rawIcs.includes(`UID:${uid}`))
              return href.slice(calDavCollectionPath.length);
          throw new Error(`no Baikal copy of ${uid}`);
        };
        google.userUpdate("evtone", timed("Google edit", 9));
        baikal.userPut(
          baikalName("evtone@google.com"),
          vevent({
            uid: "evtone@google.com",
            summary: "Baikal edit",
            start: "20261001T090000Z",
            end: "20261001T100000Z",
          }),
        );
        await run();
        expect(await overview()).toMatchObject({
          state: "needs-review",
          attention: ["conflicts"],
          counts: { conflicts: 1 },
        });
        const review = calendarBridgeReviewResponseSchema.parse(
          (await call(`${base}/review`)).body,
        );
        const conflict = review.conflicts[0];
        if (conflict === undefined) throw new Error("conflict missing");
        expect(conflict).toMatchObject({
          reason: "concurrent-change",
          google: {
            kind: "present",
            summary: "Google edit",
            start: "2026-10-01T09:00:00.000Z",
          },
          baikal: { kind: "present", summary: "Baikal edit" },
        });
        expect(JSON.stringify(review)).not.toContain("BEGIN:VCALENDAR");
        // The owner's resolve can be bound to the reviewed link revision.
        expect(
          (
            await call(
              `${base}/conflicts/${conflict.id}/resolve`,
              "POST",
              { keep: "google" },
              { "If-Match": `"${String(conflict.linkRevision + 1)}"` },
            )
          ).status,
        ).toBe(412);

        // Assistant: a read token sees status; only the review scope decides.
        const issue = async (scopes: readonly string[]) =>
          createAutomationTokenResponseSchema.parse(
            (
              await call("/api/automation/tokens", "POST", {
                label: `Bridge ${String(scopes.length)}`,
                scopes,
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              })
            ).body,
          ).token;
        const reviewer = await issue([
          "calendar_bridge:read",
          "calendar_bridge:review",
        ]);
        const reader = await issue(["calendar_bridge:read"]);
        const automation = async (
          token: string,
          path: string,
          method: "GET" | "POST",
          body?: unknown,
        ) => {
          const response = await fetch(`${server.baseUrl}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(body === undefined ? {} : json),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const text = await response.text();
          bodies.push(text);
          return { status: response.status, body: JSON.parse(text) as unknown };
        };
        const resource = automationCalendarBridgeResourceSchema.parse(
          (
            await automation(
              reader,
              `/api/automation/v1/resources/calendar-bridge?mappingId=${mapping.id}`,
              "GET",
            )
          ).body,
        );
        expect(resource.mappings).toHaveLength(1);
        expect(resource.review?.conflicts[0]?.baikal.summary).toBe(
          "Baikal edit",
        );
        expect(
          (
            await automation(
              reader,
              `/api/automation/v1/resources/calendar-bridge?mappingId=${randomUUID()}`,
              "GET",
            )
          ).status,
        ).toBe(404);
        const previewTool = (
          token: string,
          operation: string,
          input: unknown,
        ) =>
          automation(token, "/api/automation/v1/previews", "POST", {
            operation,
            input,
          });
        const resolveInput = {
          mappingId: mapping.id,
          conflictId: conflict.id,
          keep: "google",
          expectedLinkRevision: conflict.linkRevision,
        };
        expect(
          (
            await previewTool(
              reader,
              "calendar_bridge.resolve_conflict",
              resolveInput,
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await previewTool(reviewer, "calendar_bridge.resolve_conflict", {
              ...resolveInput,
              expectedLinkRevision: conflict.linkRevision + 1,
            })
          ).status,
        ).toBe(412);
        const confirm = async (token: string, previewId: string) => {
          const answer = await automation(
            token,
            `/api/automation/v1/previews/${previewId}/confirm`,
            "POST",
            { idempotencyKey: randomUUID() },
          );
          expect(answer.status).toBe(200);
          return automationConfirmationResponseSchema.parse(answer.body);
        };
        const resolvePreview = automationPreviewResponseSchema.parse(
          (
            await previewTool(
              reviewer,
              "calendar_bridge.resolve_conflict",
              resolveInput,
            )
          ).body,
        ).preview;
        expect(resolvePreview.confirmation).toMatchObject({
          policy: "consequential",
          category: "destructive_replacement",
        });
        expect(resolvePreview.summary).toContain("Google edit");
        expect(resolvePreview.summary).toContain("Baikal edit");
        expect(
          resolvePreview.affected.map(({ entityKind }) => entityKind),
        ).toEqual([
          "calendar_bridge_mapping",
          "calendar_bridge_link",
          "calendar_bridge_conflict",
        ]);
        expect(
          baikal.writes.filter(({ method }) => method === "PUT"),
        ).toHaveLength(1);
        expect(
          (await confirm(reviewer, resolvePreview.id)).result,
        ).toMatchObject({
          operation: { target: "baikal", reason: "resolution" },
        });
        await run();
        expect(
          baikal.resources.get(
            `${calDavCollectionPath}${baikalName("evtone@google.com")}`,
          )?.rawIcs,
        ).toContain("SUMMARY:Google edit");

        // Three deletions: the owner keeps one copy, the assistant keeps one
        // and approves one.
        for (const [index, id] of ["evtkeep", "evtassist", "evtgone"].entries())
          google.userCreate(id, timed(`Event ${id}`, 11 + index));
        await run();
        for (const id of ["evtkeep", "evtassist", "evtgone"])
          google.userDelete(id);
        await run();
        expect(await overview()).toMatchObject({
          state: "needs-review",
          attention: ["deletions-awaiting-approval"],
          counts: { pendingDeletions: 3 },
        });
        const blocked = calendarBridgeReviewResponseSchema.parse(
          (await call(`${base}/review`)).body,
        ).blocked;
        const find = (title: string) => {
          const entry = blocked.find((item) => item.title === title);
          if (entry === undefined) throw new Error(`${title} missing`);
          expect(entry).toMatchObject({
            reason: "deletion-approval",
            deletedOn: "google",
            approved: false,
          });
          return entry;
        };
        const kept = find("Event evtkeep");
        const declinePath = `${base}/links/${kept.linkId}/decline-deletion`;
        expect((await call(declinePath, "POST")).status).toBe(428);
        expect(
          await call(declinePath, "POST", undefined, {
            "If-Match": `"${String(kept.linkRevision)}"`,
          }),
        ).toMatchObject({
          status: 200,
          body: {
            link: { status: "excluded", statusReason: "deletion-declined" },
          },
        });
        expect(
          (
            await call(declinePath, "POST", undefined, {
              "If-Match": `"${String(kept.linkRevision + 1)}"`,
            })
          ).status,
        ).toBe(409);

        const decide = async (title: string, decision: "approve" | "keep") => {
          const entry = find(title);
          const answer = await previewTool(
            reviewer,
            "calendar_bridge.decide_deletion",
            {
              mappingId: mapping.id,
              linkId: entry.linkId,
              expectedRevision: entry.linkRevision,
              decision,
            },
          );
          expect(answer.status).toBe(201);
          return automationPreviewResponseSchema.parse(answer.body).preview;
        };
        const keepPreview = await decide("Event evtassist", "keep");
        expect(keepPreview.confirmation.policy).toBe("ordinary");
        expect(keepPreview.summary).toContain("nothing is written");
        expect((await confirm(reviewer, keepPreview.id)).result).toMatchObject({
          link: { status: "excluded" },
        });
        const approvePreview = await decide("Event evtgone", "approve");
        expect(approvePreview.confirmation).toMatchObject({
          policy: "consequential",
          category: "deletion",
        });
        expect(
          (await confirm(reviewer, approvePreview.id)).result,
        ).toMatchObject({ link: { deletionApproval: { side: "google" } } });
        await run();
        const baikalText = [...baikal.resources.values()]
          .map(({ rawIcs }) => rawIcs)
          .join("\n");
        expect(baikalText).toContain("UID:evtkeep@google.com");
        expect(baikalText).toContain("UID:evtassist@google.com");
        expect(baikalText).not.toContain("UID:evtgone@google.com");
        expect(await overview()).toMatchObject({
          state: "ok",
          counts: { pendingDeletions: 0, excluded: 2, tombstoned: 1 },
        });

        for (const body of bodies) {
          expect(body).not.toContain("bridge-refresh-secret");
          expect(body).not.toContain("bridge-access");
          expect(body).not.toContain('secret"');
        }
      } finally {
        await server.close();
      }
    });
  });
});
