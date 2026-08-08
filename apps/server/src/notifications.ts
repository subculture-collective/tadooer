import { lstatSync, readFileSync } from "node:fs";

export interface NtfyPublisherConfig {
  readonly baseUrl: string;
  readonly topic: string;
  readonly token: string;
}

export type NotificationPublishResult =
  | { readonly kind: "delivered" }
  | { readonly kind: "retry"; readonly errorCode: string }
  | { readonly kind: "failed"; readonly errorCode: string }
  | { readonly kind: "uncertain"; readonly errorCode: string };

const isPrivateHttpTarget = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  !hostname.includes(".");

export const loadNtfyPublisherConfig = (
  path: string | undefined,
): NtfyPublisherConfig | undefined => {
  if (path === undefined) return undefined;
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  )
    throw new Error(
      "ntfy publisher configuration must be a current-user-owned mode-0600 regular file",
    );
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null)
    throw new Error("ntfy publisher configuration is invalid");
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    typeof candidate.baseUrl !== "string" ||
    typeof candidate.topic !== "string" ||
    typeof candidate.token !== "string"
  )
    throw new Error("ntfy publisher configuration is invalid");
  const base = new URL(candidate.baseUrl);
  if (
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && isPrivateHttpTarget(base.hostname))) ||
    base.username !== "" ||
    base.password !== "" ||
    (base.pathname !== "/" && base.pathname !== "") ||
    base.search !== "" ||
    base.hash !== "" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.topic) ||
    candidate.token.length < 20 ||
    candidate.token.length > 512
  )
    throw new Error("ntfy publisher configuration is invalid");
  return {
    baseUrl: base.origin,
    topic: candidate.topic,
    token: candidate.token,
  };
};

export class NtfyPublisher {
  constructor(
    readonly config: NtfyPublisherConfig,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  async publish(input: {
    readonly message: string;
    readonly click: string;
  }): Promise<NotificationPublishResult> {
    try {
      const response = await this.fetcher(
        `${this.config.baseUrl}/${encodeURIComponent(this.config.topic)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            Title: "Tadooer reminder",
            Tags: "calendar,white_check_mark",
            Click: input.click,
            "Content-Type": "text/plain; charset=utf-8",
          },
          body: input.message,
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.ok) return { kind: "delivered" };
      if (
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      )
        return {
          kind: "retry",
          errorCode: `NTFY_TRANSIENT_${String(response.status)}`,
        };
      return { kind: "failed", errorCode: "NTFY_REJECTED" };
    } catch {
      return { kind: "uncertain", errorCode: "NTFY_DELIVERY_UNCERTAIN" };
    }
  }
}
