import { URL } from "node:url";

export const suiteOrigin = (raw) => {
  try {
    const url = new URL(raw);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return undefined;
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback)
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
};

export const allowedNavigation = (target, origin) => {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
};

export const allowedExternalOAuth = (target) => {
  try {
    const url = new URL(target);
    return (
      url.origin === "https://accounts.google.com" &&
      url.pathname === "/o/oauth2/v2/auth" &&
      url.username === "" &&
      url.password === "" &&
      url.searchParams.get("response_type") === "code" &&
      (url.searchParams.get("client_id")?.length ?? 0) > 4 &&
      (url.searchParams.get("redirect_uri")?.length ?? 0) > 0 &&
      (url.searchParams.get("state")?.length ?? 0) >= 32
    );
  } catch {
    return false;
  }
};
