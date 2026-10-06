import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";
import { HostedOAuthService } from "./hosted-oauth.ts";

const challenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

describe("hosted MCP OAuth", () => {
  it("binds codes and tokens to PKCE, client, resource and scope, rotates refresh tokens, and revokes reuse", async () => {
    await withTemporaryDirectory(async (directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const clientsPath = join(directory, "clients.json");
      await writeFile(
        clientsPath,
        JSON.stringify([
          {
            id: "assistant-a",
            name: "Assistant A",
            redirectUris: ["https://assistant-a.example/callback"],
          },
          {
            id: "assistant-b",
            name: "Assistant B",
            redirectUris: ["https://assistant-b.example/callback"],
          },
        ]),
      );
      await chmod(clientsPath, 0o600);
      database.createOwner({
        id: "00000000-0000-4000-8000-000000000001",
        username: "owner",
        displayName: "Owner",
        passwordHash: "not-used-by-this-test",
        createdAt: "2026-10-05T00:00:00.000Z",
      });

      const now = "2026-10-05T00:00:00.000Z";
      let serial = 0;
      const random = (): string =>
        Buffer.alloc(32, ++serial).toString("base64url");
      const oauth = new HostedOAuthService(
        database,
        "https://tadooer.example",
        "https://tadooer.example/mcp",
        clientsPath,
        () => now,
        random,
      );
      const verifier = "v".repeat(43);
      const state = "s".repeat(32);

      try {
        const pending = oauth.createConsentRequest(
          "00000000-0000-4000-8000-000000000001",
          {
            responseType: "code",
            clientId: "assistant-a",
            redirectUri: "https://assistant-a.example/callback",
            state,
            codeChallenge: challenge(verifier),
            codeChallengeMethod: "S256",
            resource: "https://tadooer.example/mcp",
            scope: "tasks:read tasks:write",
          },
        );
        expect(pending).toBeDefined();
        if (pending === undefined) throw new Error("Consent request missing");
        const approved = oauth.consent({
          ownerId: "00000000-0000-4000-8000-000000000001",
          requestId: pending.id,
          requestProof: pending.requestProof,
          state,
          approved: true,
        });
        expect(approved?.code).toBeDefined();
        if (approved?.code === undefined) throw new Error("Code missing");

        expect(
          oauth.exchangeCode({
            code: approved.code,
            clientId: "assistant-b",
            redirectUri: "https://assistant-b.example/callback",
            resource: "https://tadooer.example/mcp",
            codeVerifier: verifier,
          }),
        ).toBeUndefined();
        expect(
          oauth.exchangeCode({
            code: approved.code,
            clientId: "assistant-a",
            redirectUri: "https://assistant-a.example/callback",
            resource: "https://other.example/mcp",
            codeVerifier: verifier,
          }),
        ).toBeUndefined();
        expect(
          oauth.exchangeCode({
            code: approved.code,
            clientId: "assistant-a",
            redirectUri: "https://assistant-a.example/callback",
            resource: "https://tadooer.example/mcp",
            codeVerifier: "x".repeat(43),
          }),
        ).toBeUndefined();

        const tokens = oauth.exchangeCode({
          code: approved.code,
          clientId: "assistant-a",
          redirectUri: "https://assistant-a.example/callback",
          resource: "https://tadooer.example/mcp",
          codeVerifier: verifier,
        });
        expect(tokens).toBeDefined();
        if (tokens === undefined) throw new Error("Tokens missing");
        expect(
          oauth.authenticateAccess(tokens.accessToken, "tasks:read"),
        ).toBeDefined();
        expect(
          oauth.authenticateAccess(tokens.accessToken, "notes:read"),
        ).toBeUndefined();
        expect(
          oauth.exchangeCode({
            code: approved.code,
            clientId: "assistant-a",
            redirectUri: "https://assistant-a.example/callback",
            resource: "https://tadooer.example/mcp",
            codeVerifier: verifier,
          }),
        ).toBeUndefined();

        const rotated = oauth.refresh({
          refreshToken: tokens.refreshToken,
          clientId: "assistant-a",
          resource: "https://tadooer.example/mcp",
          scope: "tasks:read",
        });
        expect(rotated).toBeDefined();
        if (rotated === undefined) throw new Error("Rotation missing");
        expect(
          oauth.authenticateAccess(rotated.accessToken, "tasks:read"),
        ).toBeDefined();
        expect(
          oauth.authenticateAccess(rotated.accessToken, "tasks:write"),
        ).toBeUndefined();

        expect(
          oauth.refresh({
            refreshToken: tokens.refreshToken,
            clientId: "assistant-a",
            resource: "https://tadooer.example/mcp",
          }),
        ).toBeUndefined();
        expect(
          oauth.authenticateAccess(rotated.accessToken, "tasks:read"),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    });
  });

  it("rejects expired authorization codes", async () => {
    await withTemporaryDirectory(async (directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const clientsPath = join(directory, "clients.json");
      await writeFile(
        clientsPath,
        JSON.stringify([
          {
            id: "assistant-a",
            name: "Assistant A",
            redirectUris: ["https://assistant-a.example/callback"],
          },
        ]),
      );
      await chmod(clientsPath, 0o600);
      database.createOwner({
        id: "00000000-0000-4000-8000-000000000001",
        username: "owner",
        displayName: "Owner",
        passwordHash: "not-used-by-this-test",
        createdAt: "2026-10-05T00:00:00.000Z",
      });
      let now = "2026-10-05T00:00:00.000Z";
      let serial = 0;
      const oauth = new HostedOAuthService(
        database,
        "https://tadooer.example",
        "https://tadooer.example/mcp",
        clientsPath,
        () => now,
        () => Buffer.alloc(32, ++serial).toString("base64url"),
      );
      const verifier = "v".repeat(43);
      try {
        const pending = oauth.createConsentRequest(
          "00000000-0000-4000-8000-000000000001",
          {
            responseType: "code",
            clientId: "assistant-a",
            redirectUri: "https://assistant-a.example/callback",
            state: "s".repeat(32),
            codeChallenge: challenge(verifier),
            codeChallengeMethod: "S256",
            resource: "https://tadooer.example/mcp",
            scope: "tasks:read",
          },
        );
        if (pending === undefined) throw new Error("Consent request missing");
        const approved = oauth.consent({
          ownerId: "00000000-0000-4000-8000-000000000001",
          requestId: pending.id,
          requestProof: pending.requestProof,
          state: "s".repeat(32),
          approved: true,
        });
        if (approved?.code === undefined) throw new Error("Code missing");
        now = "2026-10-05T00:01:01.000Z";
        expect(
          oauth.exchangeCode({
            code: approved.code,
            clientId: "assistant-a",
            redirectUri: "https://assistant-a.example/callback",
            resource: "https://tadooer.example/mcp",
            codeVerifier: verifier,
          }),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    });
  });
});
