/**
 * The place where signing and notarisation would happen, and nothing more.
 *
 * Code signing was not decided (ADR 0047, "macOS"), so `package:mac` builds
 * unsigned bundles. `afterPackage` runs once per packaged bundle, before it
 * is zipped. It does nothing unless `SUITE_MAC_SIGN` asks for a signature,
 * and then it stops the build: with a list of the missing variables, with
 * the reason signing cannot run on this host, or with the statement that the
 * step is not written yet. It never builds an unsigned artifact for a build
 * that asked for a signed one.
 *
 * Only variable names appear here and in error messages, never values.
 * `docs/operations/desktop.md` lists the Apple prerequisites and the steps.
 */

export const signingVariables = Object.freeze({
  request: "SUITE_MAC_SIGN",
  /** `Developer ID Application: <name> (<team id>)`, as in the keychain. */
  identity: "SUITE_MAC_SIGN_IDENTITY",
  teamId: "APPLE_TEAM_ID",
  /** App Store Connect API key: the `.p8` path, its key ID and issuer. */
  apiKey: Object.freeze([
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ]),
  /** The alternative: an Apple ID with an app-specific password. */
  appleId: Object.freeze(["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"]),
});

const present = (environment, name) =>
  typeof environment[name] === "string" && environment[name] !== "";

export const signingRequested = (environment) => {
  const value = environment[signingVariables.request];
  return typeof value === "string" && !["", "0", "false", "no"].includes(value);
};

/**
 * Names of the variables a signed, notarised build would still need. The
 * notarisation credential is either the complete API key set or the complete
 * Apple ID set; when neither is complete, the API key names are reported.
 */
export const missingSigningVariables = (environment) => {
  const missing = [signingVariables.identity, signingVariables.teamId].filter(
    (name) => !present(environment, name),
  );
  const complete = (names) => names.every((name) => present(environment, name));
  if (!complete(signingVariables.apiKey) && !complete(signingVariables.appleId))
    missing.push(
      ...signingVariables.apiKey.filter((name) => !present(environment, name)),
    );
  return missing;
};

/**
 * Called for each packaged bundle before it is archived. Returns
 * `{ signed: false }` for an unsigned build and throws for a build that
 * asked for a signature.
 */
export const afterPackage = (bundle, environment, hostPlatform) => {
  if (!signingRequested(environment)) return { signed: false };
  const missing = missingSigningVariables(environment);
  if (missing.length > 0)
    throw new Error(
      `${signingVariables.request} is set, but these variables are missing: ${missing.join(", ")}. ` +
        "Unset it to build the unsigned package. See docs/operations/desktop.md, “Signing and notarising later”.",
    );
  if (hostPlatform !== "darwin")
    throw new Error(
      `${signingVariables.request} is set, but signing needs macOS: codesign and notarytool do not exist on ${hostPlatform}. ` +
        "Build the signed package on a Mac.",
    );
  throw new Error(
    `Signing ${bundle.appPath} is not implemented. Code signing and notarisation are an open owner decision (ADR 0047). ` +
      "The steps to add here are in docs/operations/desktop.md, “Signing and notarising later”.",
  );
};
