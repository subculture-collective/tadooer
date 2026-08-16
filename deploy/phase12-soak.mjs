#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";

const onceKinds = [
  "two_browser_profiles",
  "baikal_projection",
  "google_projection",
  "focus_break_lifecycle",
  "ntfy_lead",
  "ntfy_at_start",
  "restart_recovery",
  "isolated_restore",
  "candidate_upgrade",
  "immutable_rollback",
  "forward_recovery",
  "auth_boundary",
  "no_duplicate_calendar",
  "no_duplicate_notifications",
  "super_productivity_parallel",
];
const allowedKinds = new Set([
  ...onceKinds,
  "daily_health",
  "daily_backup",
  "defect",
]);

const atomicWrite = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

export const parseSoak = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Soak ledger must be an object");
  const ledger = value;
  if (
    ledger.schemaVersion !== 1 ||
    ledger.publicOrigin !== "https://tadooer.subcult.tv" ||
    typeof ledger.startedAt !== "string" ||
    !Number.isFinite(Date.parse(ledger.startedAt)) ||
    typeof ledger.candidate !== "object" ||
    ledger.candidate === null ||
    typeof ledger.candidate.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(
      ledger.candidate.version,
    ) ||
    typeof ledger.candidate.revision !== "string" ||
    !/^[0-9a-f]{7,64}$/.test(ledger.candidate.revision) ||
    typeof ledger.candidate.imageDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(ledger.candidate.imageDigest) ||
    !Array.isArray(ledger.observations)
  )
    throw new Error("Soak ledger is invalid");
  const observations = ledger.observations.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !allowedKinds.has(item.kind) ||
      !["pass", "fail"].includes(item.status) ||
      typeof item.at !== "string" ||
      !Number.isFinite(Date.parse(item.at)) ||
      (item.note !== undefined &&
        (typeof item.note !== "string" || item.note.length > 500)) ||
      (item.kind === "defect" && !["P0", "P1", "P2"].includes(item.severity))
    )
      throw new Error("Soak observation is invalid");
    return {
      kind: item.kind,
      status: item.status,
      at: new Date(item.at).toISOString(),
      ...(item.note === undefined ? {} : { note: item.note }),
      ...(item.kind === "defect" ? { severity: item.severity } : {}),
    };
  });
  return {
    schemaVersion: 1,
    publicOrigin: ledger.publicOrigin,
    candidate: {
      version: ledger.candidate.version,
      revision: ledger.candidate.revision,
      imageDigest: ledger.candidate.imageDigest,
    },
    startedAt: new Date(ledger.startedAt).toISOString(),
    observations,
  };
};

export const startSoak = async (path, candidate, startedAt) => {
  const ledger = parseSoak({
    schemaVersion: 1,
    publicOrigin: "https://tadooer.subcult.tv",
    candidate,
    startedAt,
    observations: [],
  });
  await atomicWrite(path, ledger);
  return ledger;
};

export const recordSoak = async (path, observation) => {
  const ledger = parseSoak(JSON.parse(await readFile(path, "utf8")));
  const updated = parseSoak({
    ...ledger,
    observations: [...ledger.observations, observation],
  });
  await atomicWrite(path, updated);
  return updated;
};

export const qualifySoak = (ledgerValue, qualifiedAt, signedOffBy) => {
  const ledger = parseSoak(ledgerValue);
  const end = Date.parse(qualifiedAt);
  const start = Date.parse(ledger.startedAt);
  if (!Number.isFinite(end) || end - start < 7 * 24 * 60 * 60 * 1000)
    throw new Error("Seven full soak days have not elapsed");
  if (
    ledger.observations.some((item) => {
      const observedAt = Date.parse(item.at);
      return observedAt < start || observedAt > end;
    })
  )
    throw new Error("Soak evidence falls outside the qualification window");
  if (typeof signedOffBy !== "string" || signedOffBy.trim().length < 3)
    throw new Error("A human sign-off identity is required");
  const passedKinds = new Set(
    ledger.observations
      .filter((item) => item.status === "pass")
      .map((item) => item.kind),
  );
  const missing = onceKinds.filter((kind) => !passedKinds.has(kind));
  if (missing.length > 0)
    throw new Error(`Missing soak evidence: ${missing.join(", ")}`);
  if (
    ledger.observations.some(
      (item) =>
        item.status === "fail" &&
        (item.kind !== "defect" || ["P0", "P1"].includes(item.severity)),
    )
  )
    throw new Error("The soak contains a blocking failure");
  for (let day = 0; day < 7; day += 1) {
    const from = start + day * 24 * 60 * 60 * 1000;
    const to = from + 24 * 60 * 60 * 1000;
    for (const kind of ["daily_health", "daily_backup"])
      if (
        !ledger.observations.some(
          (item) =>
            item.kind === kind &&
            item.status === "pass" &&
            Date.parse(item.at) >= from &&
            Date.parse(item.at) < to,
        )
      )
        throw new Error(
          `Missing ${kind} evidence for soak day ${String(day + 1)}`,
        );
  }
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify(ledger))
    .digest("hex");
  return {
    schemaVersion: 1,
    version: "1.0.0",
    revision: ledger.candidate.revision,
    imageDigest: ledger.candidate.imageDigest,
    desktopArtifact: "Productivity Suite-linux-x64",
    qualifiedAt: new Date(qualifiedAt).toISOString(),
    signOff: {
      signedOffBy: signedOffBy.trim(),
      soakStartedAt: ledger.startedAt,
      evidenceSha256: evidenceHash,
      cutoverRecommendation: "review_after_parallel_soak",
      legacyAction: "none",
    },
  };
};

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const [command, path, ...args] = process.argv.slice(2);
  if (command === "start" && path && args.length === 4) {
    const [version, revision, imageDigest, startedAt] = args;
    await startSoak(path, { version, revision, imageDigest }, startedAt);
    console.log(JSON.stringify({ status: "started", path }));
  } else if (command === "record" && path && args.length >= 3) {
    const [kind, status, at, ...noteParts] = args;
    await recordSoak(path, {
      kind,
      status,
      at,
      ...(kind === "defect" ? { severity: noteParts.shift() } : {}),
      ...(noteParts.length === 0 ? {} : { note: noteParts.join(" ") }),
    });
    console.log(JSON.stringify({ status: "recorded", kind }));
  } else if (command === "qualify" && path && args.length === 3) {
    const [outputPath, qualifiedAt, signedOffBy] = args;
    const ledger = JSON.parse(await readFile(path, "utf8"));
    await atomicWrite(
      outputPath,
      qualifySoak(ledger, qualifiedAt, signedOffBy),
    );
    console.log(JSON.stringify({ status: "qualified", outputPath }));
  } else {
    throw new Error(
      "Usage: phase12-soak.mjs start <ledger> <version> <revision> <digest> <at> | record <ledger> <kind> <pass|fail> <at> [severity] [note] | qualify <ledger> <manifest> <at> <signed-off-by>",
    );
  }
}
