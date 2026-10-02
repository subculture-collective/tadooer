import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@suite/contracts";
import {
  confirmPassword,
  downloadDataExport,
  login,
  revokeAutomationToken,
  signOutOtherDevices,
} from "./api.ts";
import {
  registerReauthenticationPrompt,
  requestReauthentication,
} from "./reauthentication.ts";

// The recent-password prompt of a trusted device (ADR 0048).

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refusal = (): Response =>
  json(403, {
    code: "REAUTHENTICATION_REQUIRED",
    message: "Confirm your password to continue",
    requestId: "00000000-0000-4000-8000-000000000001",
  });

afterEach(() => vi.unstubAllGlobals());

describe("recent-password prompt", () => {
  it("prompts once and repeats the refused request", async () => {
    const answers = [refusal(), json(200, { signedOut: 2 })];
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      void path;
      void init;
      return Promise.resolve(answers.shift() ?? json(500, {}));
    });
    vi.stubGlobal("fetch", fetcher);
    const prompt = vi.fn(() => Promise.resolve(true));
    const unregister = registerReauthenticationPrompt(prompt);
    try {
      expect(await signOutOtherDevices("csrf-token")).toBe(2);
    } finally {
      unregister();
    }
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [first, second] = fetcher.mock.calls;
    expect(second?.[0]).toBe("/api/auth/devices/sign-out-others");
    expect(second?.[1]).toEqual(first?.[1]);
    expect(new Headers(second?.[1]?.headers).get("x-csrf-token")).toBe(
      "csrf-token",
    );
  });

  it("covers the export download and requests without a response body", async () => {
    const answers = [
      refusal(),
      new Response('{"format":"tadooer-export"}', {
        status: 200,
        headers: {
          "Content-Disposition":
            'attachment; filename="tadooer-export-2026-10-02.json"',
        },
      }),
      refusal(),
      new Response(null, { status: 204 }),
    ];
    const fetcher = vi.fn(() =>
      Promise.resolve(answers.shift() ?? json(500, {})),
    );
    vi.stubGlobal("fetch", fetcher);
    const unregister = registerReauthenticationPrompt(() =>
      Promise.resolve(true),
    );
    try {
      expect(await downloadDataExport()).toEqual({
        filename: "tadooer-export-2026-10-02.json",
        text: '{"format":"tadooer-export"}',
      });
      await revokeAutomationToken(
        "00000000-0000-4000-8000-000000000002",
        "csrf-token",
      );
    } finally {
      unregister();
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("returns the refusal when the owner declines or no prompt is mounted", async () => {
    const fetcher = vi.fn(() => Promise.resolve(refusal()));
    vi.stubGlobal("fetch", fetcher);
    await expect(signOutOtherDevices("csrf-token")).rejects.toMatchObject({
      status: 403,
      code: "REAUTHENTICATION_REQUIRED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const unregister = registerReauthenticationPrompt(() =>
      Promise.resolve(false),
    );
    try {
      await expect(signOutOtherDevices("csrf-token")).rejects.toBeInstanceOf(
        ApiRequestError,
      );
    } finally {
      unregister();
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not prompt for other refusals and shares one prompt between requests", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        json(403, {
          code: "INVALID_CREDENTIALS",
          message: "Incorrect password",
          requestId: "00000000-0000-4000-8000-000000000003",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    let release: (confirmed: boolean) => void = () => undefined;
    const prompt = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const unregister = registerReauthenticationPrompt(prompt);
    try {
      await expect(
        confirmPassword("wrong password", "csrf-token"),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      expect(prompt).not.toHaveBeenCalled();

      const first = requestReauthentication();
      const second = requestReauthentication();
      expect(prompt).toHaveBeenCalledTimes(1);
      release(true);
      expect(await Promise.all([first, second])).toEqual([true, true]);
    } finally {
      unregister();
    }
  });

  it("sends the trust choice with the sign-in", async () => {
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      void path;
      void init;
      return Promise.resolve(
        json(200, {
          owner: {
            id: "00000000-0000-4000-8000-000000000004",
            username: "owner",
            displayName: "Owner",
          },
          csrfToken: "c".repeat(43),
          expiresAt: "2027-03-31T08:00:00.000Z",
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    await login({ username: "owner", password: "secret", trustDevice: true });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        username: "owner",
        password: "secret",
        trustDevice: true,
      }),
    );
  });
});
