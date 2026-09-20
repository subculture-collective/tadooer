import { readFile, lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { automationTokenSecretSchema } from "@suite/contracts";

export interface AdapterConfig {
  readonly baseUrl: URL;
  readonly token: string;
}

const usage =
  "Usage: suite-mcp --url <Suite URL> --token-file <owner-only file>";

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";

export const parseConfigArguments = (
  arguments_: readonly string[],
): {
  readonly url: URL;
  readonly tokenFile: string;
} => {
  if (arguments_.length !== 4) throw new Error(usage);

  let urlValue: string | undefined;
  let tokenFile: string | undefined;
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(usage);
    if (flag === "--url" && urlValue === undefined) urlValue = value;
    else if (flag === "--token-file" && tokenFile === undefined)
      tokenFile = value;
    else throw new Error(usage);
  }

  let url: URL;
  try {
    url = new URL(urlValue ?? "");
  } catch {
    throw new Error("Suite URL is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new Error("Suite URL is invalid");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Plain HTTP is allowed only for a loopback Suite URL");
  }
  if (tokenFile === undefined || tokenFile === "") throw new Error(usage);

  return { url, tokenFile: resolve(tokenFile) };
};

const readOwnerOnlyToken = async (tokenFile: string): Promise<string> => {
  const metadata = await lstat(tokenFile);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error("Token file must be a regular owner-only (0600) file");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error("Token file must be owned by the current user");
  }
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!automationTokenSecretSchema.safeParse(token).success) {
    throw new Error(
      "Token file does not contain a valid automation credential",
    );
  }
  return token;
};

export const loadConfig = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AdapterConfig> => {
  let effectiveArguments = arguments_;
  if (arguments_.length === 0) {
    const configPath =
      environment.TADOOER_MCP_CONFIG ??
      resolve(
        environment.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"),
        "tadooer",
        "mcp.json",
      );
    const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (
      typeof config !== "object" ||
      config === null ||
      !("url" in config) ||
      !("tokenFile" in config) ||
      typeof config.url !== "string" ||
      typeof config.tokenFile !== "string" ||
      !isAbsolute(config.tokenFile)
    )
      throw new Error(
        "MCP settings require a URL and an absolute token-file path",
      );
    effectiveArguments = [
      "--url",
      config.url,
      "--token-file",
      config.tokenFile,
    ];
  }
  const parsed = parseConfigArguments(effectiveArguments);
  return {
    baseUrl: parsed.url,
    token: await readOwnerOnlyToken(parsed.tokenFile),
  };
};

export const automationApiUrl = (baseUrl: URL, path: string): URL => {
  if (!path.startsWith("/"))
    throw new Error("Automation catalog path is invalid");
  const destination = new URL(path, baseUrl);
  if (
    destination.origin !== baseUrl.origin ||
    !destination.pathname.startsWith("/api/automation/v1")
  ) {
    throw new Error("Automation catalog path is outside the automation API");
  }
  return destination;
};

export const tokenFilePathForDisplay = (tokenFile: string): string =>
  isAbsolute(tokenFile) ? tokenFile : resolve(tokenFile);
