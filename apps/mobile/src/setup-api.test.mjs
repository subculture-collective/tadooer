import { describe, expect, it, vi } from "vitest";
import {
  createSetupApi,
  nativeFetch,
  setupMessage,
  setupNotice,
} from "./setup-api.mjs";

const buildBody = { service: "productivity-suite", version: "1.4.0" };

const fakes = ({
  response = { status: 200, data: buildBody },
  permitted = true,
  state = { currentOrigin: null, unreachable: false, webViewSupported: true },
  setServer = () => Promise.resolve(),
} = {}) => {
  const shell = {
    state: vi.fn(() => Promise.resolve(state)),
    setServer: vi.fn(setServer),
    cancel: vi.fn(() => Promise.resolve()),
    cleartextPermitted: vi.fn(() => Promise.resolve({ permitted })),
  };
  const http = {
    get: vi.fn(() =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response),
    ),
  };
  return { shell, http, api: createSetupApi({ shell, http }) };
};

describe("mobile setup page calls", () => {
  it("reports the stored server and whether it failed to load", async () => {
    const { api } = fakes({
      state: {
        currentOrigin: "https://tasks.example.org",
        unreachable: true,
        webViewSupported: true,
      },
    });
    await expect(api.state()).resolves.toEqual({
      currentOrigin: "https://tasks.example.org",
      unreachable: true,
      webViewSupported: true,
    });
    const empty = fakes({ state: { currentOrigin: 5 } });
    await expect(empty.api.state()).resolves.toEqual({
      currentOrigin: null,
      unreachable: false,
      webViewSupported: true,
    });
  });

  it("checks /api/build without cookies or redirects, then stores the origin", async () => {
    const { api, shell, http } = fakes();
    await expect(api.connect(" tasks.example.org ", false)).resolves.toEqual({
      ok: true,
      origin: "https://tasks.example.org",
      version: "1.4.0",
    });
    expect(http.get).toHaveBeenCalledWith({
      url: "https://tasks.example.org/api/build",
      headers: { accept: "application/json" },
      disableRedirects: true,
      responseType: "text",
      connectTimeout: 8000,
      readTimeout: 8000,
    });
    expect(shell.setServer).toHaveBeenCalledWith({
      origin: "https://tasks.example.org",
      allowPrivateLanHttp: false,
    });
    // HTTPS needs no question about plaintext.
    expect(shell.cleartextPermitted).not.toHaveBeenCalled();
  });

  it("refuses an address before any request is made", async () => {
    const { api, shell, http } = fakes();
    for (const [address, reason] of [
      ["", "invalid"],
      ["https://user:pw@tasks.example.org", "credentials"],
      ["https://tasks.example.org/app", "path"],
      ["ftp://tasks.example.org", "scheme"],
      ["http://tasks.example.org", "insecure-http"],
      ["http://10.0.0.50:8080", "private-lan-consent"],
      ["https://localhost", "localhost-reserved"],
      ["http://localhost:8080", "localhost-reserved"],
    ]) {
      const result = await api.connect(address, false);
      expect(result, address).toMatchObject({ ok: false, reason });
      expect(result.message.length, address).toBeGreaterThan(10);
    }
    await expect(api.connect(undefined, false)).resolves.toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(http.get).not.toHaveBeenCalled();
    expect(shell.setServer).not.toHaveBeenCalled();
  });

  it("accepts a private address only with consent and a build that allows it", async () => {
    const allowed = fakes();
    await expect(
      allowed.api.connect("http://10.0.0.50:8080", true),
    ).resolves.toMatchObject({ ok: true, origin: "http://10.0.0.50:8080" });
    expect(allowed.shell.cleartextPermitted).toHaveBeenCalledWith({
      host: "10.0.0.50",
    });
    expect(allowed.shell.setServer).toHaveBeenCalledWith({
      origin: "http://10.0.0.50:8080",
      allowPrivateLanHttp: true,
    });

    const notBuilt = fakes({ permitted: false });
    await expect(
      notBuilt.api.connect("http://10.0.0.50:8080", true),
    ).resolves.toMatchObject({ ok: false, reason: "cleartext-build" });
    expect(notBuilt.http.get).not.toHaveBeenCalled();
    expect(notBuilt.shell.setServer).not.toHaveBeenCalled();

    // Loopback HTTP needs no consent, but the build still decides.
    const loopback = fakes();
    await expect(
      loopback.api.connect("http://127.0.0.1:8080", false),
    ).resolves.toMatchObject({ ok: true });
    expect(loopback.shell.setServer).toHaveBeenCalledWith({
      origin: "http://127.0.0.1:8080",
      allowPrivateLanHttp: false,
    });
  });

  it("stores nothing when the server is not a Suite server", async () => {
    for (const [response, reason] of [
      [new Error("timeout"), "unreachable"],
      [{ status: 302, data: "" }, "unreachable"],
      [{ status: 404, data: "Not found" }, "not-suite"],
      [{ status: 200, data: "<html>" }, "not-suite"],
      [{ status: 200, data: { service: "other", version: "1" } }, "not-suite"],
      [{ status: 200, data: "x".repeat(20_000) }, "not-suite"],
      [{ status: "200", data: null }, "not-suite"],
    ]) {
      const { api, shell } = fakes({ response });
      await expect(
        api.connect("https://tasks.example.org", false),
        JSON.stringify(reason),
      ).resolves.toMatchObject({ ok: false, reason });
      expect(shell.setServer).not.toHaveBeenCalled();
    }
  });

  it("reports a refusal from the native side", async () => {
    const { api } = fakes({
      setServer: () => Promise.reject(new Error("refused")),
    });
    await expect(
      api.connect("https://tasks.example.org", false),
    ).resolves.toEqual({
      ok: false,
      reason: "refused",
      message: setupMessage("refused"),
    });
  });

  it("returns to the stored server on cancel", async () => {
    const { api, shell } = fakes();
    await expect(api.cancel()).resolves.toBeNull();
    expect(shell.cancel).toHaveBeenCalledOnce();
  });

  it("hands the body to the shared check as text", async () => {
    const parsed = nativeFetch({
      get: () => Promise.resolve({ status: 200, data: buildBody }),
    });
    const response = await parsed("https://tasks.example.org/api/build");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(JSON.stringify(buildBody));
    const text = nativeFetch({
      get: () => Promise.resolve({ status: 200, data: "plain" }),
    });
    await expect((await text("x")).text()).resolves.toBe("plain");
    await expect(
      nativeFetch({ get: () => Promise.resolve({ status: 301 }) })("x"),
    ).rejects.toThrow();
    await expect(
      nativeFetch({ get: () => Promise.resolve(undefined) })("x"),
    ).rejects.toThrow();
  });

  it("names the native side's reason when it gives one", async () => {
    const { api } = fakes({
      setServer: () =>
        Promise.reject(
          Object.assign(new Error("old"), { code: "webview-outdated" }),
        ),
    });
    await expect(
      api.connect("https://tasks.example.org", false),
    ).resolves.toMatchObject({ ok: false, reason: "webview-outdated" });
    const unknown = fakes({
      setServer: () =>
        Promise.reject(Object.assign(new Error("x"), { code: "toString" })),
    });
    await expect(
      unknown.api.connect("https://tasks.example.org", false),
    ).resolves.toMatchObject({ ok: false, reason: "refused" });
  });

  it("refuses an IPv6 literal other than loopback", async () => {
    const { api, http } = fakes();
    await expect(
      api.connect("https://[2001:db8::1]", false),
    ).resolves.toMatchObject({ ok: false, reason: "ipv6-literal" });
    await expect(
      api.connect("http://[fd00::1]:8080", true),
    ).resolves.toMatchObject({ ok: false, reason: "ipv6-literal" });
    expect(http.get).not.toHaveBeenCalled();
    await expect(
      api.connect("http://[::1]:8080", false),
    ).resolves.toMatchObject({ ok: true });
  });

  it("describes an unreachable server or an old WebView and nothing else", () => {
    expect(
      setupNotice({
        currentOrigin: "https://tasks.example.org",
        unreachable: true,
        webViewSupported: true,
      }),
    ).toEqual({
      message:
        "https://tasks.example.org did not load. Check the connection and try again, or enter another address.",
      cancelLabel: "Try again",
    });
    expect(
      setupNotice({
        currentOrigin: "https://tasks.example.org",
        unreachable: true,
        webViewSupported: false,
      }),
    ).toEqual({ message: setupMessage("webview-outdated") });
    expect(
      setupNotice({
        currentOrigin: "https://tasks.example.org",
        unreachable: false,
      }),
    ).toBeUndefined();
    expect(
      setupNotice({ currentOrigin: null, unreachable: true }),
    ).toBeUndefined();
    expect(setupNotice(undefined)).toBeUndefined();
  });
});
