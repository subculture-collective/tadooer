import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  automationTokenSecretSchema,
  idempotencyKeySchema,
} from "@suite/contracts";

export interface QuickAddConfig {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly notes: string;
  readonly structured?: boolean;
}

const usage =
  "Usage: suite-quick-add --url <Suite URL> --token-file <mode-0600 file> --idempotency-key <stable key> [--notes <text>] [--structured] <title>";

const fail = (message: string): never => {
  throw new Error(`${message}\n${usage}`);
};

const baseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("--url must be a valid absolute URL");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && loopback.has(url.hostname))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return fail(
      "--url must be HTTPS (or loopback HTTP) with no credentials, path, query, or fragment",
    );
  }
  return url.origin;
};

export const parseQuickAddConfig = (
  argv: readonly string[],
): QuickAddConfig => {
  let url: string | undefined;
  let tokenFile: string | undefined;
  let idempotencyKey: string | undefined;
  let notes = "";
  let structured = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--structured") {
      structured = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") throw new Error(usage);
    if (
      argument === "--url" ||
      argument === "--token-file" ||
      argument === "--idempotency-key" ||
      argument === "--notes"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        return fail(`${argument} requires a value`);
      index += 1;
      if (argument === "--url") url = value;
      else if (argument === "--token-file") tokenFile = value;
      else if (argument === "--idempotency-key") idempotencyKey = value;
      else notes = value;
      continue;
    }
    if (argument.startsWith("--")) return fail(`Unknown option: ${argument}`);
    positional.push(argument);
  }

  if (url === undefined) return fail("--url is required");
  if (tokenFile === undefined) return fail("--token-file is required");
  if (idempotencyKey === undefined)
    return fail("--idempotency-key is required");
  const title = positional[0];
  if (positional.length !== 1 || title === undefined || title.trim() === "")
    return fail("Exactly one non-empty task title is required");
  if (!idempotencyKeySchema.safeParse(idempotencyKey).success)
    return fail(
      "--idempotency-key must be a valid stable Suite idempotency key",
    );

  return {
    baseUrl: baseUrl(url),
    tokenFile: resolve(tokenFile),
    idempotencyKey,
    title: title.trim(),
    notes,
    ...(structured ? { structured: true } : {}),
  };
};

/** Reads one explicitly configured, owner-only Suite automation credential. */
export const readAutomationTokenFile = (path: string): string => {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("--token-file must be a regular file, not a symlink");
  if ((metadata.mode & 0o777) !== 0o600)
    throw new Error("--token-file must have mode 0600");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    throw new Error("--token-file must be owned by the current user");
  const token = readFileSync(path, "utf8").trim();
  if (!automationTokenSecretSchema.safeParse(token).success)
    throw new Error(
      "--token-file does not contain a valid Suite automation token",
    );
  return token;
};
