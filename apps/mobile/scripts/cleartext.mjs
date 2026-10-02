import { privateLanHost } from "@suite/shell-policy";
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Writes the Android network security configuration (ADR 0049).
 *
 * Android fixes its plaintext-HTTP rule when the app is built and has no
 * address ranges, only exact hosts. The committed file therefore allows
 * plaintext for the phone's own loopback address and nothing else. An owner
 * whose server has a private address and no HTTPS names that address here,
 * builds, and still has to tick the consent box on the setup page.
 *
 *   node scripts/cleartext.mjs                 print the current hosts
 *   node scripts/cleartext.mjs 10.0.0.50       allow these private addresses
 *   node scripts/cleartext.mjs --reset         back to the committed default
 *   node scripts/cleartext.mjs --trust-user-ca [addresses]
 *                                              also trust certificate
 *                                              authorities the owner
 *                                              installed on the phone
 */

export const networkSecurityConfigPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "android",
  "app",
  "src",
  "main",
  "res",
  "xml",
  "network_security_config.xml",
);

export const loopbackHost = "127.0.0.1";

/** A private IPv4 literal in canonical form, the only thing accepted. */
export const cleartextHostAllowed = (host) =>
  typeof host === "string" &&
  /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(host) &&
  privateLanHost(host);

export const renderNetworkSecurityConfig = ({
  hosts = [],
  trustUserCertificates = false,
} = {}) => {
  for (const host of hosts)
    if (!cleartextHostAllowed(host))
      throw new Error(
        `${String(host)} is not a private IPv4 address (10/8, 172.16/12, 192.168/16, 100.64/10). Plaintext HTTP is not allowed for anything else.`,
      );
  const domains = [loopbackHost, ...new Set(hosts)]
    .map((host) => `        <domain includeSubdomains="false">${host}</domain>`)
    .join("\n");
  const anchors = trustUserCertificates
    ? [
        '    <base-config cleartextTrafficPermitted="false">',
        "        <trust-anchors>",
        '            <certificates src="system" />',
        '            <certificates src="user" />',
        "        </trust-anchors>",
        "    </base-config>",
      ].join("\n")
    : '    <base-config cleartextTrafficPermitted="false" />';
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by apps/mobile/scripts/cleartext.mjs (ADR 0049). Plaintext HTTP
     is refused everywhere except the exact hosts listed below. -->
<network-security-config>
${anchors}
    <domain-config cleartextTrafficPermitted="true">
${domains}
    </domain-config>
</network-security-config>
`;
};

/** The hosts and the trust setting of an existing configuration text. */
export const parseNetworkSecurityConfig = (xml) => ({
  hosts: Array.from(
    xml.matchAll(/<domain includeSubdomains="false">([^<]+)<\/domain>/g),
    (match) => match[1],
  ).filter((host) => host !== loopbackHost),
  trustUserCertificates: xml.includes('<certificates src="user" />'),
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parameters = process.argv.slice(2);
  if (parameters.length === 0) {
    const current = parseNetworkSecurityConfig(
      readFileSync(networkSecurityConfigPath, "utf8"),
    );
    console.log(
      `Plaintext HTTP allowed for: ${[loopbackHost, ...current.hosts].join(", ")}`,
    );
    console.log(
      `Owner-installed certificate authorities trusted: ${current.trustUserCertificates ? "yes" : "no"}`,
    );
  } else {
    const reset = parameters.includes("--reset");
    const trustUserCertificates =
      !reset && parameters.includes("--trust-user-ca");
    const hosts = reset
      ? []
      : parameters.filter((parameter) => !parameter.startsWith("--"));
    try {
      writeFileSync(
        networkSecurityConfigPath,
        renderNetworkSecurityConfig({ hosts, trustUserCertificates }),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    console.log(
      `Wrote ${networkSecurityConfigPath}. Rebuild the app for it to take effect.`,
    );
  }
}
