import { classifyServerAddress, suiteBuildResponse } from "./policy.mjs";

const maximumBuildBytes = 16 * 1024;

const reasonMessages = {
  invalid: "That is not a valid address.",
  credentials: "The address must not contain a user name or password.",
  path: "Enter only the server address, without a path, query or fragment.",
  scheme: "Only https:// addresses are supported.",
  "insecure-http":
    "Plain http:// is only accepted for this computer or a private network address. Use https://.",
  "private-lan-consent":
    "This is a private network address without encryption. Confirm below to use it.",
  unreachable: "The server did not answer.",
  "not-suite": "The address answered, but it is not a Tadooer server.",
};

export const serverCheckMessage = (reason) =>
  reasonMessages[reason] ?? reasonMessages.invalid;

/**
 * Validates an address and asks the server who it is.
 *
 * `fetchImplementation` is injected (Electron's `net.fetch` in the shell, a
 * fake in tests). The request carries no cookie and follows no redirect: a
 * server that redirects `/api/build` elsewhere is not the configured origin.
 *
 * Resolves to `{ ok: true, origin, transport, version }` or
 * `{ ok: false, reason }`.
 */
export const checkServer = async (address, options) => {
  const { allowPrivateLanHttp, fetchImplementation, signal } = options;
  const classified = classifyServerAddress(address, { allowPrivateLanHttp });
  if (!classified.ok) return classified;
  let response;
  try {
    response = await fetchImplementation(`${classified.origin}/api/build`, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status !== 200) return { ok: false, reason: "not-suite" };
  let build;
  try {
    const text = await response.text();
    if (text.length > maximumBuildBytes)
      return { ok: false, reason: "not-suite" };
    build = suiteBuildResponse(JSON.parse(text));
  } catch {
    return { ok: false, reason: "not-suite" };
  }
  if (build === undefined) return { ok: false, reason: "not-suite" };
  return {
    ok: true,
    origin: classified.origin,
    transport: classified.transport,
    version: build.version,
  };
};
