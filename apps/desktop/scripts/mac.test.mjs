import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deepLinkScheme } from "../src/policy.mjs";
import { desktopDirectory } from "./artifact.mjs";
import { icnsImageTypes, pngHeader, readIcns, writeIcns } from "./icns.mjs";
import {
  afterPackage,
  missingSigningVariables,
  signingRequested,
} from "./mac-sign.mjs";
import {
  applicationFileProblems,
  asarFilePaths,
  macArchitectures,
  macBundleId,
  macCategory,
  macEntitlements,
  macEntitlementsFileName,
  macHelperEntitlements,
  macHelperEntitlementsFileName,
  machOArchitecture,
  machOCodeSignature,
  macInfoPlist,
  macInfoPlistProblems,
  macPackagerOptions,
  macSignOptionsForFile,
  packageIgnore,
  refusedEntitlements,
  requiredApplicationFiles,
} from "./mac.mjs";
import { buildPlist, parsePlist } from "./plist.mjs";

const macFile = (name) => join(desktopDirectory, "mac", name);

/** A PNG header for a square image; enough for the icon writer. */
const png = (pixels) => {
  const data = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "latin1");
  data.writeUInt32BE(pixels, 16);
  data.writeUInt32BE(pixels, 20);
  data.writeUInt8(8, 24);
  data.writeUInt8(6, 25);
  return data;
};

describe("property lists", () => {
  it("writes the document Apple's tools expect", () => {
    expect(buildPlist({ "com.example.flag": true })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "  <dict>",
        "    <key>com.example.flag</key>",
        "    <true/>",
        "  </dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
  });

  it("round-trips every supported value", () => {
    const value = {
      text: 'a <b> & "c"',
      yes: true,
      no: false,
      count: 42,
      negative: -7,
      list: ["one", { nested: [] }],
      empty: {},
    };
    expect(parsePlist(buildPlist(value))).toEqual(value);
  });

  it("writes the URL scheme fragment of the Info.plist", () => {
    const xml = buildPlist(macInfoPlist());
    expect(xml).toContain("<key>CFBundleURLSchemes</key>");
    expect(xml).toContain(`<string>${deepLinkScheme}</string>`);
    expect(xml).toMatch(/<key>LSUIElement<\/key>\s*<false\/>/);
    expect(parsePlist(xml)).toEqual(macInfoPlist());
  });

  it("reads the forms other writers produce", () => {
    expect(
      parsePlist(
        `<?xml version="1.0"?><!-- note --><plist version="1.0"><dict>
           <key>a</key><string></string>
           <key>b</key><true></true>
           <key>c</key><integer> 5 </integer>
           <key>d</key><string>x &amp; y &lt;z&gt;</string>
           <key>e</key><array/>
           <key>f</key><real>1.5</real>
         </dict></plist>`,
      ),
    ).toEqual({ a: "", b: true, c: 5, d: "x & y <z>", e: [], f: "1.5" });
  });

  it("keeps a hostile key as plain data", () => {
    const parsed = parsePlist(
      '<plist version="1.0"><dict><key>__proto__</key><string>x</string></dict></plist>',
    );
    expect(Object.keys(parsed)).toEqual(["__proto__"]);
    expect({}.x).toBeUndefined();
  });

  it("rejects what it cannot represent or read", () => {
    expect(() => buildPlist({ ratio: 1.5 })).toThrow("integer");
    expect(() => buildPlist({ nothing: null })).toThrow("Unsupported");
    expect(() => parsePlist("<dict/>")).toThrow("not a property list");
    expect(() =>
      parsePlist(
        '<plist version="1.0"><dict><string>x</string></dict></plist>',
      ),
    ).toThrow("no key");
    expect(() =>
      parsePlist('<plist version="1.0"><dict><key>a</key></dict></plist>'),
    ).toThrow();
    expect(() => parsePlist('<plist version="1.0"><dict>')).toThrow("early");
    expect(() =>
      parsePlist('<plist version="1.0"><integer>x</integer></plist>'),
    ).toThrow("malformed");
    expect(() => parsePlist(Buffer.from("bplist00"))).toThrow("text");
  });
});

describe("icns", () => {
  const images = icnsImageTypes.map(({ type, pixels }) => ({
    type,
    data: png(pixels),
  }));

  it("round-trips the images and records the total length", () => {
    const file = writeIcns(images);
    expect(file.toString("latin1", 0, 4)).toBe("icns");
    expect(file.readUInt32BE(4)).toBe(file.length);
    const read = readIcns(file);
    expect(read.map(({ type }) => type)).toEqual(
      icnsImageTypes.map(({ type }) => type),
    );
    for (const [index, { data }] of read.entries())
      expect(data.equals(images[index].data)).toBe(true);
  });

  it("refuses an image of the wrong size, type or format", () => {
    expect(() => writeIcns([{ type: "ic07", data: png(64) }])).toThrow(
      "128 pixel",
    );
    expect(() => writeIcns([{ type: "nope", data: png(16) }])).toThrow(
      "Unknown",
    );
    expect(() =>
      writeIcns([{ type: "ic07", data: Buffer.from("not a png") }]),
    ).toThrow("not a PNG");
    expect(() =>
      writeIcns([
        { type: "ic07", data: png(128) },
        { type: "ic07", data: png(128) },
      ]),
    ).toThrow("Duplicate");
    expect(() => writeIcns([])).toThrow("at least one");
  });

  it("refuses a damaged file", () => {
    const file = writeIcns(images);
    expect(() => readIcns(file.subarray(0, file.length - 1))).toThrow(
      "recorded length",
    );
    expect(() => readIcns(Buffer.from("PNG file, not an icon"))).toThrow(
      "not an icns",
    );
    const broken = Buffer.from(file);
    broken.writeUInt32BE(file.length, 12);
    expect(() => readIcns(broken)).toThrow("impossible length");
    const short = Buffer.from(file);
    short.writeUInt32BE(4, 12);
    expect(() => readIcns(short)).toThrow("impossible length");
  });

  it("parses the committed application icon", async () => {
    const read = readIcns(await readFile(macFile("icon.icns")));
    expect(read.map(({ type }) => type)).toEqual(
      icnsImageTypes.map(({ type }) => type),
    );
    for (const [index, { data }] of read.entries()) {
      const header = pngHeader(data);
      expect(header.width).toBe(icnsImageTypes[index].pixels);
      expect(header.height).toBe(icnsImageTypes[index].pixels);
      // RGBA: the icon has a transparent margin.
      expect(header.colorType).toBe(6);
    }
  });

  it.each([
    ["trayTemplate.png", 16],
    ["trayTemplate@2x.png", 32],
  ])("has the menu-bar template image %s", async (name, pixels) => {
    const header = pngHeader(
      await readFile(join(desktopDirectory, "assets", name)),
    );
    expect(header.width).toBe(pixels);
    expect(header.height).toBe(pixels);
    // A template image is drawn from its alpha channel.
    expect([4, 6]).toContain(header.colorType);
  });
});

describe("macOS package", () => {
  const options = macPackagerOptions({
    directory: "/work/desktop",
    outputDirectory: "/work/desktop/dist-packages",
    productName: "Productivity Suite",
    arch: "arm64",
  });

  it("builds one unsigned bundle per architecture", () => {
    expect(macArchitectures).toEqual(["arm64", "x64"]);
    expect(options).toMatchObject({
      dir: "/work/desktop",
      out: "/work/desktop/dist-packages",
      name: "Productivity Suite",
      platform: "darwin",
      arch: "arm64",
      appBundleId: "tv.subcult.tadooer",
      appCategoryType: "public.app-category.productivity",
      icon: "/work/desktop/mac/icon.icns",
    });
    expect(options).not.toHaveProperty("osxSign");
    expect(options).not.toHaveProperty("osxNotarize");
    expect(() =>
      macPackagerOptions({
        directory: "/work/desktop",
        outputDirectory: "/out",
        productName: "Productivity Suite",
        arch: "universal",
      }),
    ).toThrow("Unsupported");
  });

  it("registers only the tadooer scheme and keeps the Dock icon", () => {
    expect(options.extendInfo.CFBundleURLTypes).toEqual([
      {
        CFBundleURLName: macBundleId,
        CFBundleTypeRole: "Viewer",
        CFBundleURLSchemes: ["tadooer"],
      },
    ]);
    expect(deepLinkScheme).toBe("tadooer");
    expect(options.extendInfo.LSUIElement).toBe(false);
    expect(options.extendInfo.NSLocalNetworkUsageDescription).toContain(
      "local network",
    );
  });

  it("keeps build inputs and tests out of the bundle", () => {
    const ignored = (path) => packageIgnore.some((rule) => rule.test(path));
    for (const path of [
      "/scripts",
      "/mac",
      "/node_modules",
      "/dist-packages",
      "/src/policy.test.mjs",
      "/src/platform.test.mjs",
    ])
      expect(ignored(path)).toBe(true);
    for (const path of [
      "/src/main.mjs",
      "/src/platform.mjs",
      "/src/setup/index.html",
      "/dist/preload.cjs",
      "/assets/trayTemplate@2x.png",
      "/package.json",
    ])
      expect(ignored(path)).toBe(false);
  });

  it("accepts the Info.plist it asked for", () => {
    const plist = {
      CFBundleIdentifier: macBundleId,
      CFBundleName: "Productivity Suite",
      CFBundleExecutable: "Productivity Suite",
      CFBundleShortVersionString: "0.1.0",
      CFBundlePackageType: "APPL",
      CFBundleIconFile: "electron.icns",
      LSApplicationCategoryType: macCategory,
      ...macInfoPlist(),
    };
    const context = { productName: "Productivity Suite", version: "0.1.0" };
    expect(macInfoPlistProblems(plist, context)).toEqual([]);
    expect(
      macInfoPlistProblems(parsePlist(buildPlist(plist)), context),
    ).toEqual([]);
  });

  it("names each difference in an Info.plist", () => {
    const problems = macInfoPlistProblems(
      {
        CFBundleIdentifier: "com.electron.productivity-suite",
        CFBundleName: "Productivity Suite",
        CFBundleExecutable: "Productivity Suite",
        CFBundleShortVersionString: "0.0.9",
        CFBundlePackageType: "APPL",
        LSUIElement: true,
        CFBundleURLTypes: [{ CFBundleURLSchemes: ["tadooer", "https"] }],
      },
      { productName: "Productivity Suite", version: "0.1.0" },
    );
    expect(problems.join("\n")).toContain("CFBundleIdentifier");
    expect(problems.join("\n")).toContain("CFBundleShortVersionString");
    expect(problems.join("\n")).toContain("LSUIElement");
    expect(problems.join("\n")).toContain("LSApplicationCategoryType");
    expect(problems.join("\n")).toContain("CFBundleURLTypes");
    expect(problems.join("\n")).toContain("CFBundleIconFile");
    expect(problems.join("\n")).not.toContain("CFBundleName");
  });
});

describe("Mach-O inspection", () => {
  /** A 64-bit little-endian Mach-O with one optional signature blob. */
  const machO = (cpu, flags) => {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(cpu, 4);
    header.writeUInt32LE(2, 12);
    const segment = Buffer.alloc(24);
    segment.writeUInt32LE(0x19, 0);
    segment.writeUInt32LE(24, 4);
    if (flags === undefined) {
      header.writeUInt32LE(1, 16);
      return Buffer.concat([header, segment]);
    }
    const directory = Buffer.alloc(44);
    directory.writeUInt32BE(0xfade0c02, 0);
    directory.writeUInt32BE(44, 4);
    directory.writeUInt32BE(flags, 12);
    const table = Buffer.alloc(20);
    table.writeUInt32BE(0xfade0cc0, 0);
    table.writeUInt32BE(20 + directory.length, 4);
    table.writeUInt32BE(1, 8);
    table.writeUInt32BE(0, 12);
    table.writeUInt32BE(20, 16);
    const command = Buffer.alloc(16);
    command.writeUInt32LE(0x1d, 0);
    command.writeUInt32LE(16, 4);
    command.writeUInt32LE(32 + 24 + 16, 8);
    command.writeUInt32LE(table.length + directory.length, 12);
    header.writeUInt32LE(2, 16);
    return Buffer.concat([header, segment, command, table, directory]);
  };
  const arm64 = 0x0100000c;
  const x64 = 0x01000007;

  it("reads the architecture", () => {
    expect(machOArchitecture(machO(arm64))).toBe("arm64");
    expect(machOArchitecture(machO(x64))).toBe("x64");
    expect(machOArchitecture(Buffer.from("cafebabe00000002", "hex"))).toBe(
      "universal",
    );
    expect(machOArchitecture(Buffer.from("\x7fELF\x02\x01\x01\x00"))).toBe(
      undefined,
    );
    expect(machOArchitecture(Buffer.alloc(4))).toBeUndefined();
    expect(machOArchitecture("not a buffer")).toBeUndefined();
  });

  it("tells the kinds of code signature apart", () => {
    expect(machOCodeSignature(machO(x64))).toBe("none");
    expect(machOCodeSignature(machO(arm64, 0x20002))).toBe("linker-adhoc");
    expect(machOCodeSignature(machO(arm64, 0x2))).toBe("adhoc");
    expect(machOCodeSignature(machO(arm64, 0x10000))).toBe("identity");
  });

  it("gives no answer for a truncated or foreign file", () => {
    const signed = machO(arm64, 0x20002);
    expect(
      machOCodeSignature(signed.subarray(0, signed.length - 30)),
    ).toBeUndefined();
    expect(machOCodeSignature(signed.subarray(0, 40))).toBeUndefined();
    expect(
      machOCodeSignature(Buffer.from("cafebabe00000002", "hex")),
    ).toBeUndefined();
    expect(machOCodeSignature(Buffer.alloc(64))).toBeUndefined();
  });
});

describe("packed application files", () => {
  const asar = (tree) => {
    const json = Buffer.from(JSON.stringify(tree), "utf8");
    const header = Buffer.alloc(16);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(json.length + 8, 4);
    header.writeUInt32LE(json.length + 4, 8);
    header.writeUInt32LE(json.length, 12);
    return Buffer.concat([header, json, Buffer.from("file contents")]);
  };
  const file = { size: 1, offset: "0" };

  it("lists the files of an asar archive", () => {
    expect(
      asarFilePaths(
        asar({
          files: {
            src: { files: { "main.mjs": file, setup: { files: { a: file } } } },
            "package.json": file,
            empty: { files: {} },
          },
        }),
      ),
    ).toEqual(["package.json", "src/main.mjs", "src/setup/a"]);
  });

  it("refuses a file that is not an archive", () => {
    expect(() => asarFilePaths(Buffer.from("not an archive at all"))).toThrow(
      "not an asar",
    );
    const truncated = asar({ files: {} });
    truncated.writeUInt32LE(10_000, 12);
    expect(() => asarFilePaths(truncated)).toThrow("longer than the file");
  });

  it("requires the shell's files and refuses build inputs", () => {
    expect(applicationFileProblems([...requiredApplicationFiles])).toEqual([]);
    expect(
      applicationFileProblems(
        requiredApplicationFiles.filter((path) => path !== "dist/preload.cjs"),
      ),
    ).toEqual(["The application archive lacks dist/preload.cjs"]);
    expect(
      applicationFileProblems([
        ...requiredApplicationFiles,
        "scripts/mac.mjs",
        "mac/icon.icns",
        "src/policy.test.mjs",
      ]),
    ).toHaveLength(3);
  });
});

describe("entitlements", () => {
  it("allows the JIT and outbound connections and nothing else", () => {
    expect(macEntitlements).toEqual({
      "com.apple.security.cs.allow-jit": true,
      "com.apple.security.network.client": true,
    });
    expect(macHelperEntitlements).toEqual({
      "com.apple.security.cs.allow-jit": true,
    });
    expect(refusedEntitlements(macEntitlements)).toEqual([]);
    expect(refusedEntitlements(macHelperEntitlements)).toEqual([]);
  });

  it("recognises entitlements that would widen access", () => {
    const widening = {
      "com.apple.security.device.camera": true,
      "com.apple.security.device.audio-input": true,
      "com.apple.security.files.user-selected.read-write": true,
      "com.apple.security.files.downloads.read-only": true,
      "com.apple.security.personal-information.location": true,
      "com.apple.security.automation.apple-events": true,
      "com.apple.security.cs.disable-library-validation": true,
      "com.apple.security.cs.allow-unsigned-executable-memory": true,
      "com.apple.security.cs.allow-dyld-environment-variables": true,
      "com.apple.security.get-task-allow": true,
    };
    expect(refusedEntitlements(widening)).toEqual(Object.keys(widening));
  });

  it.each([
    [macEntitlementsFileName, macEntitlements],
    [macHelperEntitlementsFileName, macHelperEntitlements],
  ])("has %s committed as generated", async (name, entitlements) => {
    const text = await readFile(macFile(name), "utf8");
    // Regenerate with `pnpm --filter @suite/desktop assets:mac`.
    expect(text).toBe(buildPlist(entitlements));
    expect(refusedEntitlements(parsePlist(text))).toEqual([]);
  });

  it("plans the hardened runtime for every signed file", () => {
    const context = {
      directory: "/work/desktop",
      productName: "Productivity Suite",
    };
    expect(
      macSignOptionsForFile("/out/Productivity Suite.app", context),
    ).toEqual({
      hardenedRuntime: true,
      entitlements: "/work/desktop/mac/entitlements.mac.plist",
    });
    expect(
      macSignOptionsForFile(
        "/out/Productivity Suite.app/Contents/Frameworks/Productivity Suite Helper (Renderer).app",
        context,
      ),
    ).toEqual({
      hardenedRuntime: true,
      entitlements: "/work/desktop/mac/entitlements.mac.helper.plist",
    });
  });
});

describe("signing hook", () => {
  const bundle = { appPath: "/out/Productivity Suite.app" };
  const identity = {
    SUITE_MAC_SIGN: "1",
    SUITE_MAC_SIGN_IDENTITY: "Developer ID Application: Example (ABCDE12345)",
    APPLE_TEAM_ID: "ABCDE12345",
  };
  const apiKey = {
    APPLE_API_KEY: "/keys/AuthKey.p8",
    APPLE_API_KEY_ID: "KEYID12345",
    APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
  };

  it("does nothing for an unsigned build", () => {
    expect(afterPackage(bundle, {}, "linux")).toEqual({ signed: false });
    for (const value of ["", "0", "false", "no"]) {
      expect(signingRequested({ SUITE_MAC_SIGN: value })).toBe(false);
      expect(afterPackage(bundle, { SUITE_MAC_SIGN: value }, "darwin")).toEqual(
        { signed: false },
      );
    }
    expect(signingRequested({ SUITE_MAC_SIGN: "1" })).toBe(true);
  });

  it("names the missing variables and never a value", () => {
    expect(missingSigningVariables({})).toEqual([
      "SUITE_MAC_SIGN_IDENTITY",
      "APPLE_TEAM_ID",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
    ]);
    const partial = {
      ...identity,
      APPLE_API_KEY: "/keys/AuthKey.p8",
      APPLE_ID: "owner@example.test",
    };
    expect(missingSigningVariables(partial)).toEqual([
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
    ]);
    let message = "";
    try {
      afterPackage(bundle, partial, "darwin");
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("APPLE_API_KEY_ID, APPLE_API_ISSUER");
    expect(message).toContain("Unset it to build the unsigned package");
    for (const value of Object.values(partial))
      if (value !== "1") expect(message).not.toContain(value);
  });

  it("accepts either notarisation credential as complete", () => {
    expect(missingSigningVariables({ ...identity, ...apiKey })).toEqual([]);
    expect(
      missingSigningVariables({
        ...identity,
        APPLE_ID: "owner@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
      }),
    ).toEqual([]);
  });

  it("refuses to sign on a host without codesign", () => {
    expect(() =>
      afterPackage(bundle, { ...identity, ...apiKey }, "linux"),
    ).toThrow("signing needs macOS");
  });

  it("stops a build that asks for a signature it cannot make", () => {
    expect(() =>
      afterPackage(bundle, { ...identity, ...apiKey }, "darwin"),
    ).toThrow("not implemented");
  });
});
