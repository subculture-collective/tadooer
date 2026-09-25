import {
  safeExternalUrl,
  taskAttachmentSourcePathMaxLength,
  taskAttachmentTextMaxLength,
  taskAttachmentTitleMaxLength,
  taskAttachmentsPerTask,
  urlHasCredentials,
} from "@suite/contracts";
import { populated } from "./super-productivity-schema.ts";

// Linked issues and attachments (issue #30, ADR 0021). Super Productivity
// 19.1.0: IssueFieldsForTask in task.model.ts, TaskAttachment in
// task-attachment.model.ts and IssueProvider in issue.model.ts.

type Source = Readonly<Record<string, unknown>>;
const object = (value: unknown): Source =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Source)
    : {};

export interface ImportedIssueLink {
  readonly providerKey: string | null;
  readonly providerSourceId: string | null;
  readonly providerRecorded: boolean;
  readonly issueId: string;
  readonly displayUrl: string | null;
  readonly lastUpdatedAt: string | null;
  readonly syncMetadata: Readonly<Record<string, unknown>>;
}

export interface ImportedAttachment {
  readonly kind: "link" | "note" | "file" | "image" | "command";
  readonly title: string;
  readonly url: string | null;
  readonly text: string | null;
  readonly sourcePath: string | null;
  readonly unavailableReason:
    "device_local" | "command_not_run" | "unsupported_address" | null;
}

/** Built-in and migrated provider keys in 19.1.0; `plugin:<id>` is also valid. */
export const superProductivityIssueProviderKeys = [
  "JIRA",
  "GITLAB",
  "CALDAV",
  "ICAL",
  "OPEN_PROJECT",
  "REDMINE",
  "NEXTCLOUD_DECK",
  "PLAINSPACE",
  "GITHUB",
  "CLICKUP",
  "GITEA",
  "LINEAR",
  "TRELLO",
  "AZURE_DEVOPS",
] as const;

/**
 * The only issueProvider fields the importer reads. Everything else in that
 * section (tokens, passwords, calendar URLs, user names) is configuration and
 * is never read, stored or logged.
 */
export const superProductivityIssueProviderReadFields = [
  "id",
  "issueProviderKey",
] as const;
/** Gitea plugin fields used to rebuild the public issue page address. */
export const superProductivityGiteaLinkFields = [
  "host",
  "repoFullname",
] as const;

/** Reviewed TaskAttachment fields. `id`, `icon` and `originalImgPath` stay in provenance. */
export const superProductivityAttachmentFields = {
  id: "retained",
  type: "applied",
  title: "applied",
  path: "applied",
  icon: "retained",
  originalImgPath: "retained",
} as const;

/** Last-synced provider state, kept as opaque provenance on the link. */
const syncMetadataFields = [
  "issueWasUpdated",
  "issueLastUpdated",
  "issueAttachmentNr",
  "issueTimeTracked",
  "issuePoints",
  "issueLastSyncedValues",
] as const;
const issueFields = [
  "issueId",
  "issueProviderId",
  "issueType",
  ...syncMetadataFields,
] as const;
export const superProductivityLinkFields: ReadonlySet<string> = new Set([
  "attachments",
  ...issueFields,
]);

const maxSyncMetadataBytes = 65_536;
const providerKeyPattern = /^(?:plugin:)?[A-Za-z0-9_.-]{1,93}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

type Problem = (detail: string) => void;

const isoTimestamp = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().length === 24
    ? date.toISOString()
    : undefined;
};

/**
 * Gitea issue page address from the provider's public host and repository.
 * Only built when both are unambiguous; the provider token is never read.
 */
const giteaIssueUrl = (provider: Source, issueId: string): string | null => {
  if (provider.issueProviderKey !== "GITEA" || !/^\d{1,12}$/.test(issueId))
    return null;
  const config = object(provider.pluginConfig);
  const host = config[superProductivityGiteaLinkFields[0]];
  const repository = config[superProductivityGiteaLinkFields[1]];
  if (typeof host !== "string" || typeof repository !== "string") return null;
  if (!repositoryPattern.test(repository)) return null;
  const base = safeExternalUrl(host);
  if (base === undefined) return null;
  const parsed = new URL(base);
  if (parsed.search !== "" || parsed.hash !== "") return null;
  return (
    safeExternalUrl(
      `${parsed.href.replace(/\/+$/, "")}/${repository}/issues/${issueId}`,
    ) ?? null
  );
};

/**
 * Maps a task's issue fields to one issue link. Returns null when the task has
 * no linked issue. Diagnostics never include issue IDs, URLs or provider data.
 */
export const mapLinkedIssue = (
  task: Source,
  providers: Source,
  problem: Problem,
  notice: (detail: string) => void,
): ImportedIssueLink | null => {
  const hasIssue = populated(task.issueId);
  if (!hasIssue) {
    const stray = issueFields.filter(
      (field) => field !== "issueId" && populated(task[field]),
    );
    if (stray.length > 0)
      problem(
        `${stray.join(", ")} ${stray.length === 1 ? "has" : "have"} no issueId; the linked issue cannot be identified`,
      );
    return null;
  }
  const issueId = task.issueId;
  if (typeof issueId !== "string" || issueId.length > 500) {
    problem("issueId must be text of at most 500 characters");
    return null;
  }
  const providerKey = task.issueType ?? null;
  if (
    providerKey !== null &&
    (typeof providerKey !== "string" || !providerKeyPattern.test(providerKey))
  ) {
    problem("issueType must be a Super Productivity provider key");
    return null;
  }
  const providerSourceId = task.issueProviderId ?? null;
  if (
    providerSourceId !== null &&
    (typeof providerSourceId !== "string" ||
      providerSourceId === "" ||
      providerSourceId.length > 200)
  ) {
    problem("issueProviderId must be a provider ID");
    return null;
  }
  const lastUpdatedAt = isoTimestamp(task.issueLastUpdated);
  if (lastUpdatedAt === undefined) {
    problem("issueLastUpdated must be a valid epoch-millisecond timestamp");
    return null;
  }
  const syncMetadata = Object.fromEntries(
    syncMetadataFields
      .filter((field) => populated(task[field]))
      .map((field) => [field, task[field]]),
  );
  if (
    Buffer.byteLength(JSON.stringify(syncMetadata), "utf8") >
    maxSyncMetadataBytes
  ) {
    problem("Last-synced issue values exceed 64 KiB");
    return null;
  }
  const provider =
    providerSourceId === null || !Object.hasOwn(providers, providerSourceId)
      ? undefined
      : object(providers[providerSourceId]);
  if (provider === undefined)
    notice(
      providerSourceId === null
        ? "Linked issue names no provider; it is kept without a provider"
        : "Linked issue provider is absent from the export; the link is kept without a provider",
    );
  else if (
    providerKey !== null &&
    provider[superProductivityIssueProviderReadFields[1]] !== providerKey
  )
    problem("issueType disagrees with the linked provider's key");
  return {
    providerKey,
    providerSourceId,
    providerRecorded: provider !== undefined,
    issueId,
    displayUrl:
      provider === undefined ? null : giteaIssueUrl(provider, issueId),
    lastUpdatedAt,
    syncMetadata,
  };
};

/**
 * Maps TaskAttachment records. Links and web images stay openable; local
 * files, local images and commands become inert, unavailable provenance.
 * Addresses with embedded credentials block the import instead of being
 * stored.
 */
export const mapAttachments = (
  task: Source,
  problem: Problem,
): ImportedAttachment[] => {
  if (!populated(task.attachments)) return [];
  if (!Array.isArray(task.attachments)) {
    problem("attachments must be a list");
    return [];
  }
  if (task.attachments.length > taskAttachmentsPerTask) {
    problem(`Task has more than ${String(taskAttachmentsPerTask)} attachments`);
    return [];
  }
  const mapped: ImportedAttachment[] = [];
  for (const value of task.attachments as unknown[]) {
    const attachment = object(value);
    const unknown = Object.keys(attachment).filter(
      (field) => !Object.hasOwn(superProductivityAttachmentFields, field),
    );
    if (unknown.length > 0) {
      problem(
        `Unreviewed attachment field ${unknown.join(", ")} blocks import`,
      );
      continue;
    }
    const { type, title = "", path } = attachment;
    if (
      typeof title !== "string" ||
      title.trim().length > taskAttachmentTitleMaxLength
    ) {
      problem("Attachment title must be text of at most 500 characters");
      continue;
    }
    if (typeof path !== "string" || path.trim() === "") {
      problem("Attachment has no path; nothing identifies its content");
      continue;
    }
    // Super Productivity stores pasted links without a scheme as //host.
    const address = path.startsWith("//") ? `https:${path}` : path;
    if (urlHasCredentials(address)) {
      problem(
        "Attachment address contains a user name or password; remove it in Super Productivity before importing",
      );
      continue;
    }
    const base = { title: title.trim(), url: null, text: null };
    if (type === "NOTE") {
      if (path.length > taskAttachmentTextMaxLength) {
        problem("Note attachment exceeds 20,000 characters");
        continue;
      }
      mapped.push({
        ...base,
        kind: "note",
        text: path,
        sourcePath: null,
        unavailableReason: null,
      });
      continue;
    }
    if (path.length > taskAttachmentSourcePathMaxLength) {
      problem("Attachment path exceeds 4,096 characters");
      continue;
    }
    const url =
      type === "LINK" || type === "IMG" ? safeExternalUrl(address) : undefined;
    if (type === "LINK" || type === "IMG")
      mapped.push({
        ...base,
        kind: type === "LINK" ? "link" : "image",
        url: url ?? null,
        sourcePath: url === undefined ? path : null,
        unavailableReason:
          url !== undefined
            ? null
            : type === "IMG"
              ? "device_local"
              : "unsupported_address",
      });
    else if (type === "FILE" || type === "COMMAND")
      mapped.push({
        ...base,
        kind: type === "FILE" ? "file" : "command",
        sourcePath: path,
        unavailableReason: type === "FILE" ? "device_local" : "command_not_run",
      });
    else problem("Attachment type must be FILE, LINK, IMG, COMMAND or NOTE");
  }
  return mapped;
};
