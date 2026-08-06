import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "@suite/persistence";
import {
  AuthService,
  hashPassword,
  LoginRateLimiter,
  passwordMeetsPolicy,
  verifyPassword,
} from "./auth.ts";

describe("owner authentication", () => {
  it("rate-limits the sixth failure and resets after the window", () => {
    const limiter = new LoginRateLimiter();
    for (let attempt = 0; attempt < 5; attempt += 1)
      limiter.failed("client", 0);
    expect(limiter.allows("client", 1)).toBe(false);
    expect(limiter.allows("client", 15 * 60 * 1000)).toBe(true);
  });

  it("hashes valid passwords and rejects weak passwords", async () => {
    expect(passwordMeetsPolicy("too short")).toBe(false);
    await expect(hashPassword("too short")).rejects.toThrow("policy");

    const encoded = await hashPassword(
      "correct horse battery staple",
      Buffer.alloc(16, 7),
    );
    expect(encoded).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(
      true,
    );
    expect(
      await verifyPassword("incorrect horse battery staple", encoded),
    ).toBe(false);
  });

  it("issues, authenticates, and revokes an opaque persisted session", async () => {
    await withTemporaryDirectory(async (directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const times = [
        "2026-08-05T00:00:00.000Z",
        "2026-08-05T00:01:00.000Z",
        "2026-08-05T00:02:00.000Z",
      ];
      const auth = new AuthService(
        database,
        () => times.shift() ?? "2026-08-05T00:03:00.000Z",
        () => "A".repeat(43),
      );
      expect(
        await auth.setup({
          username: "owner",
          displayName: "Suite Owner",
          password: "correct horse battery staple",
        }),
      ).toBe(true);
      const issued = await auth.login("owner", "correct horse battery staple");
      expect(issued).toBeDefined();
      if (issued === undefined) throw new Error("Expected a session");
      expect(issued.owner.username).toBe("owner");
      expect(issued.csrfToken).toBe("A".repeat(43));

      const request = {
        headers: { cookie: `suite_session=${issued.token}` },
      } as never;
      const authenticated = auth.authenticate(request, true);
      expect(authenticated).toBeDefined();
      if (authenticated === undefined)
        throw new Error("Expected authentication");
      expect(authenticated.owner.displayName).toBe("Suite Owner");
      expect(auth.csrfMatches(authenticated, issued.csrfToken)).toBe(true);

      auth.revoke(authenticated);
      expect(auth.authenticate(request, false)).toBeUndefined();
      database.close();
    });
  });
});
