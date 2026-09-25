import { z } from "zod";

// Linked issues and task attachments (issue #30, ADR 0021). Local copies avoid
// an import cycle with index.ts, which re-exports this file.
const id = z.uuid();
const revision = z.number().int().positive();
const timestamp = z.iso.datetime();

export const taskLinkUrlMaxLength = 2048;
export const taskAttachmentTitleMaxLength = 500;
export const taskAttachmentTextMaxLength = 20_000;
export const taskAttachmentSourcePathMaxLength = 4096;
export const taskAttachmentsPerTask = 100;

/**
 * Returns the normalized address when it is an absolute http(s) URL without
 * embedded user credentials; otherwise undefined. Only such URLs are ever
 * opened by the web client.
 */
export const safeExternalUrl = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > taskLinkUrlMaxLength) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.hostname === "") return undefined;
  return url.href.length > taskLinkUrlMaxLength ? undefined : url.href;
};

/** True when the text parses as a URL that embeds a user name or password. */
export const urlHasCredentials = (value: string): boolean => {
  try {
    const url = new URL(value.trim());
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
};

/** Accepted as sent; the store saves the normalized form from safeExternalUrl. */
export const taskLinkUrlSchema = z
  .string()
  .max(taskLinkUrlMaxLength)
  .refine((value) => safeExternalUrl(value) !== undefined, {
    message: "Use an http or https address without a user name or password",
  });

/**
 * `link` and `note` are created in Tadooer. `file`, `image` and `command` come
 * from Super Productivity imports. Device-local files and commands are kept as
 * inert provenance: Tadooer never reads the file or runs the command.
 */
export const taskAttachmentKindSchema = z.enum([
  "link",
  "note",
  "file",
  "image",
  "command",
]);

export const taskAttachmentUnavailableReasonSchema = z.enum([
  // A path on the device that created it; the server cannot read it.
  "device_local",
  // A Super Productivity shell command; never executed.
  "command_not_run",
  // The address is not an absolute http(s) URL.
  "unsupported_address",
]);

export const taskAttachmentSchema = z
  .object({
    id,
    ownerId: id,
    taskId: id,
    kind: taskAttachmentKindSchema,
    title: z.string().max(taskAttachmentTitleMaxLength),
    /** Openable http(s) address for link and image attachments. */
    url: z.string().max(taskLinkUrlMaxLength).nullable(),
    /** Text of a note attachment. */
    text: z.string().max(taskAttachmentTextMaxLength).nullable(),
    /** Original device-local path, command or address; shown as text only. */
    sourcePath: z.string().max(taskAttachmentSourcePathMaxLength).nullable(),
    available: z.boolean(),
    unavailableReason: taskAttachmentUnavailableReasonSchema.nullable(),
    source: z.enum(["suite", "super_productivity"]),
    position: z.number().int().nonnegative(),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

/**
 * External issue identity imported from Super Productivity. There is no live
 * provider connection: refreshing or writing the issue needs a fresh provider
 * authorization that Tadooer does not yet offer.
 */
export const taskIssueLinkSchema = z
  .object({
    id,
    ownerId: id,
    taskId: id,
    source: z.literal("super_productivity"),
    /** Super Productivity provider key, e.g. GITEA, ICAL or plugin:<id>. */
    providerKey: z.string().max(100).nullable(),
    /** Provider instance ID from the source export, not a Tadooer record. */
    providerSourceId: z.string().max(200).nullable(),
    /** False when the export no longer contained that provider instance. */
    providerRecorded: z.boolean(),
    issueId: z.string().min(1).max(500),
    displayUrl: z.string().max(taskLinkUrlMaxLength).nullable(),
    connection: z.literal("authorization_required"),
    lastUpdatedAt: timestamp.nullable(),
    /** Opaque last-synced source fields kept as provenance. */
    syncMetadata: z.record(z.string(), z.unknown()),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const taskLinksResponseSchema = z
  .object({
    taskId: id,
    issueLink: taskIssueLinkSchema.nullable(),
    attachments: z.array(taskAttachmentSchema).max(taskAttachmentsPerTask),
  })
  .strict();

const attachmentTitle = z.string().trim().max(taskAttachmentTitleMaxLength);
const attachmentText = z
  .string()
  .max(taskAttachmentTextMaxLength)
  .refine((value) => value.trim().length > 0, {
    message: "Note text is required",
  });

export const taskAttachmentCreateRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("link"),
      title: attachmentTitle.default(""),
      url: taskLinkUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("note"),
      title: attachmentTitle.default(""),
      text: attachmentText,
    })
    .strict(),
]);

/** `url` applies to link attachments and `text` to note attachments only. */
export const taskAttachmentPatchRequestSchema = z
  .object({
    title: attachmentTitle.optional(),
    url: taskLinkUrlSchema.optional(),
    text: attachmentText.optional(),
  })
  .strict()
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    {
      message: "An attachment edit is required",
    },
  );

export const taskAttachmentResponseSchema = z
  .object({ attachment: taskAttachmentSchema })
  .strict();

export const taskLinksResourceInputSchema = z.object({ taskId: id }).strict();

export const automationTaskLinkMutationInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("add_attachment"),
        taskId: id,
        id,
        attachment: taskAttachmentCreateRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("update_attachment"),
        id,
        expectedRevision: revision,
        patch: taskAttachmentPatchRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("remove_attachment"),
        id,
        expectedRevision: revision,
      })
      .strict(),
    z
      .object({
        action: z.literal("remove_issue_link"),
        id,
        expectedRevision: revision,
      })
      .strict(),
  ],
);

export type TaskAttachment = z.infer<typeof taskAttachmentSchema>;
export type TaskAttachmentKind = z.infer<typeof taskAttachmentKindSchema>;
export type TaskIssueLink = z.infer<typeof taskIssueLinkSchema>;
export type TaskLinksResponse = z.infer<typeof taskLinksResponseSchema>;
export type TaskAttachmentCreateRequest = z.infer<
  typeof taskAttachmentCreateRequestSchema
>;
export type TaskAttachmentPatchRequest = z.infer<
  typeof taskAttachmentPatchRequestSchema
>;
export type AutomationTaskLinkMutationInput = z.infer<
  typeof automationTaskLinkMutationInputSchema
>;
