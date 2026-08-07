import { resolve } from "node:path";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly webRoot: string;
  readonly baikalEndpoint: string;
  readonly credentialKeyPath: string;
  readonly googleOAuthConfigPath?: string;
  readonly secureCookies: boolean;
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

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig => ({
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
    : { googleOAuthConfigPath: resolve(environment.GOOGLE_OAUTH_CONFIG_PATH) }),
  secureCookies: parseBoolean(
    "SUITE_SECURE_COOKIES",
    environment.SUITE_SECURE_COOKIES,
  ),
  build: {
    version: environment.SUITE_VERSION ?? "0.0.0-dev",
    revision: environment.SUITE_REVISION ?? "development",
    builtAt: optionalIsoDate(environment.SUITE_BUILD_DATE),
  },
});
