import { resolve } from "node:path";
import { isIP } from "node:net";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly webRoot: string;
  readonly baikalEndpoint: string;
  readonly credentialKeyPath: string;
  readonly googleOAuthConfigPath?: string;
  readonly ntfyPublisherConfigPath?: string;
  readonly secureCookies: boolean;
  readonly publicOrigin?: string;
  readonly trustedProxyCidrs?: readonly string[];
  readonly build: {
    readonly version: string;
    readonly revision: string;
    readonly builtAt: string | null;
  };
}

const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value ?? ""}`);
  }
  return port;
};

const optionalIsoDate = (value: string | undefined): string | null => {
  if (value === undefined || value === "") {
    return null;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new Error("BUILD_DATE must be an ISO-8601 timestamp");
  }
  return new Date(value).toISOString();
};

const parseBoolean = (name: string, value: string | undefined): boolean => {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
};

const parseBaikalEndpoint = (value: string | undefined): string => {
  const endpoint = new URL(value ?? "http://baikal/dav.php/");
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("BAIKAL_ENDPOINT is invalid");
  }
  return endpoint.href;
};

const parsePublicOrigin = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  const origin = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  if (
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && loopback)) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  )
    throw new Error("SUITE_PUBLIC_ORIGIN must be an HTTPS origin");
  return origin.origin;
};

const parseTrustedProxyCidrs = (value: string | undefined): readonly string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      const [address, prefix, extra] = item.split("/");
      if (
        address === undefined ||
        extra !== undefined ||
        !(
          (isIP(address) === 4 && prefix === "32") ||
          (isIP(address) === 6 && prefix === "128")
        )
      )
        throw new Error(
          "SUITE_TRUSTED_PROXY_CIDRS accepts only explicit /32 or /128 hosts",
        );
      return item;
    });

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig => {
  const publicOrigin = parsePublicOrigin(environment.SUITE_PUBLIC_ORIGIN);
  return {
    host: environment.HOST ?? "0.0.0.0",
    port: parsePort(environment.PORT),
    databasePath: resolve(
      environment.SUITE_DATABASE_PATH ?? "./data/suite.sqlite",
    ),
    webRoot: resolve(environment.SUITE_WEB_ROOT ?? "./apps/web/dist"),
    baikalEndpoint: parseBaikalEndpoint(environment.BAIKAL_ENDPOINT),
    credentialKeyPath: resolve(
      environment.SUITE_CREDENTIAL_KEY_PATH ?? "./data/credential.key",
    ),
    ...(environment.GOOGLE_OAUTH_CONFIG_PATH === undefined ||
    environment.GOOGLE_OAUTH_CONFIG_PATH === ""
      ? {}
      : {
          googleOAuthConfigPath: resolve(environment.GOOGLE_OAUTH_CONFIG_PATH),
        }),
    ...(environment.NTFY_PUBLISHER_CONFIG_PATH === undefined ||
    environment.NTFY_PUBLISHER_CONFIG_PATH === ""
      ? {}
      : {
          ntfyPublisherConfigPath: resolve(
            environment.NTFY_PUBLISHER_CONFIG_PATH,
          ),
        }),
    secureCookies: parseBoolean(
      "SUITE_SECURE_COOKIES",
      environment.SUITE_SECURE_COOKIES,
    ),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    trustedProxyCidrs: parseTrustedProxyCidrs(
      environment.SUITE_TRUSTED_PROXY_CIDRS,
    ),
    build: {
      version: environment.SUITE_VERSION ?? "0.0.0-dev",
      revision: environment.SUITE_REVISION ?? "development",
      builtAt: optionalIsoDate(environment.SUITE_BUILD_DATE),
    },
  };
};
