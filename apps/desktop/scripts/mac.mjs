import { Buffer } from "node:buffer";
import { basename, join } from "node:path";
import { deepLinkScheme } from "../src/policy.mjs";

/**
 * What the macOS package is: identifiers, the `Info.plist` additions, the
 * `@electron/packager` options and the entitlements a later signing step
 * would use (ADR 0047, "macOS"). Everything here is pure; the scripts that
 * touch the disk are `package-mac.mjs` and `make-mac-assets.mjs`.
 */

/**
 * The bundle identifier. An owner choice: it names the app to Launch
 * Services, the login item list, the notification settings and, later, the
 * signing certificate and notarisation record. Changing it after release
 * makes macOS treat the app as a different one.
 */
export const macBundleId = "tv.subcult.tadooer";

export const macCategory = "public.app-category.productivity";

/**
 * One build per architecture. A universal build needs `lipo`, and
 * `@electron/universal` refuses to run anywhere but macOS, so it cannot be
 * produced on the Linux build host.
 */
export const macArchitectures = Object.freeze(["arm64", "x64"]);

/** Build inputs that stay outside the application bundle. */
export const macDirectoryName = "mac";
export const macIconFileName = "icon.icns";
export const macEntitlementsFileName = "entitlements.mac.plist";
export const macHelperEntitlementsFileName = "entitlements.mac.helper.plist";

const localNetworkReason =
  "Productivity Suite connects to the Suite server you chose when that server is on your local network.";

/**
 * The keys added to Electron's `Info.plist`.
 *
 * - `CFBundleURLTypes` registers `tadooer://` with Launch Services, so links
 *   reach the app through `open-url` without a runtime registration.
 * - `LSUIElement` is false: the app has a Dock icon and a menu bar, and the
 *   status item is an addition, not the only way in.
 * - `NSLocalNetworkUsageDescription` is the text of the local-network prompt
 *   macOS 15 shows before a connection to a private address.
 */
export const macInfoPlist = () => ({
  CFBundleURLTypes: [
    {
      CFBundleURLName: macBundleId,
      CFBundleTypeRole: "Viewer",
      CFBundleURLSchemes: [deepLinkScheme],
    },
  ],
  LSUIElement: false,
  NSLocalNetworkUsageDescription: localNetworkReason,
});

/**
 * Paths, relative to the desktop package, that never go into a bundle:
 * build output, dependencies (the preloads are bundled and the shell has no
 * runtime dependency), the build scripts, the macOS build inputs and tests.
 */
export const packageIgnore = Object.freeze([
  /(^|\/)(dist-packages|node_modules|scripts|mac)$/,
  /(^|\/)src\/.*test.*$/,
]);

/** Options for one `@electron/packager` run. Nothing is signed. */
export const macPackagerOptions = ({
  directory,
  outputDirectory,
  productName,
  arch,
}) => {
  if (!macArchitectures.includes(arch))
    throw new Error(`Unsupported macOS architecture: ${String(arch)}`);
  return {
    dir: directory,
    out: outputDirectory,
    name: productName,
    platform: "darwin",
    arch,
    overwrite: true,
    prune: false,
    ignore: [...packageIgnore],
    appBundleId: macBundleId,
    appCategoryType: macCategory,
    icon: join(directory, macDirectoryName, macIconFileName),
    extendInfo: macInfoPlist(),
  };
};

/**
 * Entitlements for a later Developer ID signature with the hardened runtime.
 *
 * - `cs.allow-jit` is what V8 needs under the hardened runtime.
 * - `network.client` only has an effect inside the App Sandbox, which a
 *   Developer ID build does not use; outside it outbound connections need no
 *   entitlement. It is listed so that a later sandbox decision starts from
 *   the one resource the shell uses.
 *
 * Nothing grants the camera, the microphone, location, contacts, Apple
 * Events or file access, and the hardened runtime denies what is not listed.
 */
export const macEntitlements = Object.freeze({
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.network.client": true,
});

/** The renderer, GPU and plugin helpers need the JIT and nothing else. */
export const macHelperEntitlements = Object.freeze({
  "com.apple.security.cs.allow-jit": true,
});

const refusedEntitlementPrefixes = [
  "com.apple.security.device.",
  "com.apple.security.files.",
  "com.apple.security.personal-information.",
  "com.apple.security.automation.",
  "com.apple.security.cs.disable-",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.get-task-allow",
];

/** Entitlement keys that would widen what the shell may reach. */
export const refusedEntitlements = (entitlements) =>
  Object.keys(entitlements).filter((key) =>
    refusedEntitlementPrefixes.some((prefix) => key.startsWith(prefix)),
  );

/**
 * Per-file options in the shape `@electron/osx-sign` takes as
 * `optionsForFile`: the hardened runtime everywhere, the main entitlements
 * for the application and the helper entitlements for everything inside it.
 * Unused until signing is implemented (`mac-sign.mjs`).
 */
export const macSignOptionsForFile = (filePath, { directory, productName }) => {
  const main = basename(filePath) === `${productName}.app`;
  return {
    hardenedRuntime: true,
    entitlements: join(
      directory,
      macDirectoryName,
      main ? macEntitlementsFileName : macHelperEntitlementsFileName,
    ),
  };
};

/**
 * The architecture of a Mach-O executable, from its first eight bytes:
 * `arm64`, `x64`, `universal` for a fat file, otherwise undefined.
 */
export const machOArchitecture = (data) => {
  if (!Buffer.isBuffer(data) || data.length < 8) return undefined;
  const magic = data.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) return "universal";
  // 64-bit little-endian Mach-O: magic 0xfeedfacf stored least byte first.
  if (magic !== 0xcffaedfe) return undefined;
  const cpu = data.readUInt32LE(4);
  if (cpu === 0x0100000c) return "arm64";
  if (cpu === 0x01000007) return "x64";
  return undefined;
};

/**
 * What kind of code signature a 64-bit Mach-O file carries, read from its
 * `LC_CODE_SIGNATURE` load command and the flags of its code directory:
 *
 * - `none`: no signature;
 * - `linker-adhoc`: the ad hoc signature the linker adds to every arm64
 *   binary. It covers the code only and names no one, but Apple silicon
 *   refuses to run arm64 code without at least this;
 * - `adhoc`: an ad hoc signature made with `codesign --sign -`;
 * - `identity`: a signature made with a certificate.
 *
 * Returns undefined for anything that is not a thin 64-bit Mach-O file.
 */
export const machOCodeSignature = (data) => {
  if (machOArchitecture(data) === undefined || data.length < 32)
    return undefined;
  if (data.readUInt32BE(0) !== 0xcffaedfe) return undefined;
  const commands = data.readUInt32LE(16);
  let offset = 32;
  for (let index = 0; index < commands; index += 1) {
    if (offset + 16 > data.length) return undefined;
    const command = data.readUInt32LE(offset);
    const size = data.readUInt32LE(offset + 4);
    if (size < 8) return undefined;
    if (command === 0x1d) {
      const start = data.readUInt32LE(offset + 8);
      const end = start + data.readUInt32LE(offset + 12);
      if (end > data.length || start + 12 > end) return undefined;
      // An embedded signature: a table of blobs, one of them the code
      // directory (magic 0xfade0c02) whose flags say how it was made.
      if (data.readUInt32BE(start) !== 0xfade0cc0) return undefined;
      const blobs = data.readUInt32BE(start + 8);
      for (let blob = 0; blob < blobs; blob += 1) {
        const entry = start + 12 + blob * 8;
        if (entry + 8 > end) return undefined;
        const directory = start + data.readUInt32BE(entry + 4);
        if (directory + 16 > end) return undefined;
        if (data.readUInt32BE(directory) !== 0xfade0c02) continue;
        const flags = data.readUInt32BE(directory + 12);
        if ((flags & 0x2) === 0) return "identity";
        return (flags & 0x20000) === 0 ? "adhoc" : "linker-adhoc";
      }
      return undefined;
    }
    offset += size;
  }
  return "none";
};

/**
 * The file paths inside an asar archive (`Resources/app.asar`), read from
 * its header: two length-prefixed "pickle" wrappers around a JSON tree whose
 * directories have a `files` object. Lets the build check what was packed
 * without a dependency on `@electron/asar`.
 */
export const asarFilePaths = (data) => {
  if (!Buffer.isBuffer(data) || data.length < 16 || data.readUInt32LE(0) !== 4)
    throw new Error("The file is not an asar archive");
  const length = data.readUInt32LE(12);
  if (16 + length > data.length)
    throw new Error("The asar header is longer than the file");
  const header = JSON.parse(data.toString("utf8", 16, 16 + length));
  const walk = (node, prefix) =>
    Object.entries(node.files ?? {}).flatMap(([name, child]) =>
      typeof child === "object" && child !== null && "files" in child
        ? walk(child, `${prefix}${name}/`)
        : [`${prefix}${name}`],
    );
  return walk(header, "").sort();
};

/** Files the shell cannot start without, and paths that must stay out. */
export const requiredApplicationFiles = Object.freeze([
  "package.json",
  "src/main.mjs",
  "src/shell.mjs",
  "src/platform.mjs",
  "src/setup/index.html",
  "dist/preload.cjs",
  "dist/setup-preload.cjs",
  "assets/trayTemplate.png",
  "assets/trayTemplate@2x.png",
]);

export const applicationFileProblems = (paths) => [
  ...requiredApplicationFiles
    .filter((file) => !paths.includes(file))
    .map((file) => `The application archive lacks ${file}`),
  ...paths
    .filter(
      (path) =>
        /^(scripts|mac|node_modules|dist-packages)\//.test(path) ||
        /\.test\./.test(path),
    )
    .map((path) => `The application archive should not contain ${path}`),
];

/**
 * Compares a packaged `Info.plist` with what the package is meant to be.
 * Returns one sentence per difference; an empty list means it matches.
 */
export const macInfoPlistProblems = (plist, { productName, version }) => {
  const problems = [];
  const expect = (key, expected) => {
    if (plist[key] !== expected)
      problems.push(
        `${key} is ${JSON.stringify(plist[key])}, expected ${JSON.stringify(expected)}`,
      );
  };
  expect("CFBundleIdentifier", macBundleId);
  expect("CFBundleName", productName);
  expect("CFBundleExecutable", productName);
  expect("CFBundleShortVersionString", version);
  expect("CFBundlePackageType", "APPL");
  expect("LSApplicationCategoryType", macCategory);
  expect("LSUIElement", false);
  expect("NSLocalNetworkUsageDescription", localNetworkReason);
  const schemes = Array.isArray(plist.CFBundleURLTypes)
    ? plist.CFBundleURLTypes.flatMap((type) =>
        Array.isArray(type?.CFBundleURLSchemes) ? type.CFBundleURLSchemes : [],
      )
    : [];
  if (schemes.length !== 1 || schemes[0] !== deepLinkScheme)
    problems.push(
      `CFBundleURLTypes registers ${JSON.stringify(schemes)}, expected only ${deepLinkScheme}`,
    );
  if (
    typeof plist.CFBundleIconFile !== "string" ||
    plist.CFBundleIconFile === ""
  )
    problems.push("CFBundleIconFile is missing");
  return problems;
};
