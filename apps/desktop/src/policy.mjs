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
