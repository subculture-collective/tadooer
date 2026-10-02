import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildWww } from "./build-www.mjs";

/**
 * Entry for the Android build commands (docs/operations/mobile.md).
 *
 *   doctor    check the JDK and the Android SDK, build nothing
 *   sync      build the bundled pages and copy them into the Android project
 *   debug     sync, then assemble a debug APK
 *   release   sync, then build a release bundle and a release APK
 *   test      run the Java unit tests
 *
 * `sync` needs neither the SDK nor a JDK. The other three stop here with a
 * message when the SDK or a suitable JDK is missing, before Gradle starts or
 * downloads anything.
 */

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
export const androidDirectory = join(packageDirectory, "android");

/**
 * Capacitor 8 compiles for Java 21. Gradle 8.14, which the project's wrapper
 * pins, does not run on a JDK newer than 24.
 */
export const supportedJdk = Object.freeze({ minimum: 21, maximum: 24 });

/** `sdk.dir` from a `local.properties` text, or undefined. */
export const sdkDirectoryFromProperties = (text) => {
  if (typeof text !== "string") return undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*sdk\.dir\s*[=:]\s*(.+?)\s*$/.exec(line);
    if (match !== null) return match[1].replaceAll("\\\\", "\\");
  }
  return undefined;
};

/**
 * Where the Android SDK is, by the rules Gradle itself uses: `sdk.dir` in
 * `android/local.properties`, then `ANDROID_HOME`, then the older
 * `ANDROID_SDK_ROOT`. Returns `{ path, source }` for the first one that names
 * an existing directory with a `platforms` directory, otherwise
 * `{ problem }` with the text to print.
 */
export const locateSdk = ({ environment, localProperties, exists }) => {
  const candidates = [
    [sdkDirectoryFromProperties(localProperties), "android/local.properties"],
    [environment.ANDROID_HOME, "ANDROID_HOME"],
    [environment.ANDROID_SDK_ROOT, "ANDROID_SDK_ROOT"],
  ].filter(([path]) => typeof path === "string" && path.trim() !== "");
  for (const [path, source] of candidates)
    if (exists(join(path, "platforms"))) return { path, source };
  const tried =
    candidates.length === 0
      ? "ANDROID_HOME is not set and android/local.properties has no sdk.dir."
      : candidates
          .map(
            ([path, source]) =>
              `${source} names ${path}, which has no platforms directory.`,
          )
          .join("\n");
  return {
    problem: [
      "The Android SDK was not found, so no APK can be built on this machine.",
      tried,
      "Install the SDK (Android Studio 2025.2.1 or newer, or the command-line",
      'tools with sdkmanager "platform-tools" "platforms;android-36"),',
      "then set ANDROID_HOME to its directory or write sdk.dir=<directory> to",
      "apps/mobile/android/local.properties. See docs/operations/mobile.md.",
    ].join("\n"),
  };
};

/** The major version in `java -version` output, or undefined. */
export const jdkMajorVersion = (versionOutput) => {
  if (typeof versionOutput !== "string") return undefined;
  const match = /version "(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (match === null) return undefined;
  const major = Number(match[1]);
  // "1.8.0_292" is Java 8.
  return major === 1 && match[2] !== undefined ? Number(match[2]) : major;
};

/** Undefined when the JDK can run the build, otherwise the text to print. */
export const jdkProblem = (versionOutput) => {
  const major = jdkMajorVersion(versionOutput);
  const wanted = `JDK ${String(supportedJdk.minimum)} is required (Capacitor 8 compiles for Java 21, and the pinned Gradle 8.14 does not run on a JDK newer than ${String(supportedJdk.maximum)}).`;
  if (major === undefined)
    return `No JDK was found. ${wanted} Install one and set JAVA_HOME.`;
  if (major < supportedJdk.minimum || major > supportedJdk.maximum)
    return `The JDK on this machine is version ${String(major)}. ${wanted} Point JAVA_HOME at a JDK 21.`;
  return undefined;
};

const javaVersionOutput = (environment) => {
  const java =
    typeof environment.JAVA_HOME === "string" && environment.JAVA_HOME !== ""
      ? join(environment.JAVA_HOME, "bin", "java")
      : "java";
  const result = spawnSync(java, ["-version"], { encoding: "utf8" });
  return result.status === 0 ? `${result.stderr}${result.stdout}` : undefined;
};

const readLocalProperties = () => {
  try {
    return readFileSync(join(androidDirectory, "local.properties"), "utf8");
  } catch {
    return undefined;
  }
};

/** The problems that stop a build, as printable text. Empty when ready. */
export const buildProblems = (environment = process.env) => {
  const problems = [];
  const sdk = locateSdk({
    environment,
    localProperties: readLocalProperties(),
    exists: existsSync,
  });
  if (sdk.problem !== undefined) problems.push(sdk.problem);
  const jdk = jdkProblem(javaVersionOutput(environment));
  if (jdk !== undefined) problems.push(jdk);
  return problems;
};

const run = (command, parameters, options) => {
  const result = spawnSync(command, parameters, {
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const sync = async () => {
  await buildWww();
  run("pnpm", ["exec", "cap", "sync", "android"], { cwd: packageDirectory });
};

const requireToolchain = () => {
  const problems = buildProblems();
  if (problems.length === 0) return;
  console.error(problems.join("\n\n"));
  process.exit(1);
};

const gradle = (...tasks) =>
  run(join(androidDirectory, "gradlew"), tasks, { cwd: androidDirectory });

const commands = {
  doctor: () => {
    requireToolchain();
    console.log("The Android SDK and a suitable JDK were found.");
  },
  sync,
  debug: async () => {
    requireToolchain();
    await sync();
    gradle("assembleDebug");
    console.log(
      "Debug APK: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
    );
  },
  release: async () => {
    requireToolchain();
    await sync();
    gradle("bundleRelease", "assembleRelease");
    console.log(
      [
        "Release bundle: apps/mobile/android/app/build/outputs/bundle/release/app-release.aab",
        "Release APK:    apps/mobile/android/app/build/outputs/apk/release/",
        "Without android/keystore.properties the outputs are unsigned.",
      ].join("\n"),
    );
  },
  test: () => {
    requireToolchain();
    gradle("testDebugUnitTest");
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = commands[process.argv[2]];
  if (command === undefined) {
    console.error(
      `Usage: node scripts/android.mjs <${Object.keys(commands).join("|")}>`,
    );
    process.exit(2);
  }
  await command();
}
