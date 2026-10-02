import { z } from "zod";

// Local copies avoid an import cycle with index.ts, which re-exports this file.
const id = z.uuid();
const revision = z.number().int().positive();
const timestamp = z.iso.datetime();

/** Six-digit hex colour. Stored lowercase; Super Productivity theme blobs are not stored. */
export const organizationColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #3366cc");

/**
 * A Material Symbols ligature name (for example `work` or `wb_sunny`) or a
 * short emoji sequence. Icons render as text, never as markup or image URLs.
 */
export const organizationIconPattern =
  /^(?:[a-z][a-z0-9_]{0,63}|(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f){0,15})$/u;
export const organizationIconSchema = z
  .string()
  .regex(
    organizationIconPattern,
    "Use a lowercase icon name such as work, or a single emoji",
  );

const projectConfigureFields = {
  color: organizationColorSchema.nullable().optional(),
  icon: organizationIconSchema.nullable().optional(),
  hiddenFromMenu: z.boolean().optional(),
  backlogEnabled: z.boolean().optional(),
};
export const projectPatchFields = {
  completed: z.boolean().optional(),
  ...projectConfigureFields,
};
export const tagPatchFields = {
  color: organizationColorSchema.nullable().optional(),
  icon: organizationIconSchema.nullable().optional(),
};

export const organizationOrderItemsSchema = z
  .array(z.object({ id, revision }).strict())
  .min(1)
  .max(500)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    {
      message: "Order cannot contain duplicate records",
    },
  );
/** Complete ordered membership with the revision each record had when read. */
export const organizationOrderRequestSchema = z
  .object({ items: organizationOrderItemsSchema })
  .strict();

export const projectBacklogRequestSchema = z
  .object({ taskId: id, inBacklog: z.boolean() })
  .strict();

export const noteContentMaxLength = 20_000;
/** Markdown source stored as text. The web client renders a safe subset. */
export const noteContentSchema = z
  .string()
  .max(noteContentMaxLength)
  .refine((value) => value.trim().length > 0, {
    message: "Note content is required",
  });

export const noteSchema = z.object({
  id,
  ownerId: id,
  content: z.string().max(noteContentMaxLength),
  projectId: id.nullable(),
  tagId: id.nullable(),
  pinnedToToday: z.boolean(),
  position: z.number().int().nonnegative(),
  revision,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const singleAssociation = (input: {
  readonly projectId?: string | null | undefined;
  readonly tagId?: string | null | undefined;
}) =>
  input.projectId === undefined ||
  input.projectId === null ||
  input.tagId === undefined ||
  input.tagId === null;
const singleAssociationMessage = {
  message: "A note belongs to at most one project or tag",
};

export const noteCreateRequestSchema = z
  .object({
    content: noteContentSchema,
    projectId: id.nullable().default(null),
    tagId: id.nullable().default(null),
    pinnedToToday: z.boolean().default(false),
  })
  .strict()
  .refine(singleAssociation, singleAssociationMessage);

/**
 * Setting a project clears any tag association and vice versa; send null to
 * make the note standalone.
 */
export const notePatchRequestSchema = z
  .object({
    content: noteContentSchema.optional(),
    projectId: id.nullable().optional(),
    tagId: id.nullable().optional(),
    pinnedToToday: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "A note edit is required",
  })
  .refine(singleAssociation, singleAssociationMessage);

/**
 * ADR 0046: the note fields an offline `note.create` carries. Every field is
 * explicit so the operation's request hash never depends on a default.
 */
export const syncNoteCreateSchema = z
  .object({
    id,
    content: noteContentSchema,
    projectId: id.nullable(),
    tagId: id.nullable(),
    pinnedToToday: z.boolean(),
  })
  .strict()
  .refine(singleAssociation, singleAssociationMessage);

/**
 * ADR 0046: the fields an offline `note.patch` may change. `position` is
 * accepted here and not by the HTTP patch: the browser moves a note by
 * swapping two positions, each guarded by its own record revision.
 */
export const syncNotePatchFieldsSchema = z
  .object({
    content: noteContentSchema.optional(),
    projectId: id.nullable().optional(),
    tagId: id.nullable().optional(),
    pinnedToToday: z.boolean().optional(),
    position: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "A note edit is required",
  })
  .refine(singleAssociation, singleAssociationMessage);

export const noteResponseSchema = z.object({ note: noteSchema }).strict();
export const noteListResponseSchema = z
  .object({ notes: z.array(noteSchema) })
  .strict();
export const noteMutationResponseSchema = z
  .object({
    notes: z.array(noteSchema),
    deletedIds: z.array(id).max(1),
  })
  .strict();

const lifecycle = {
  create: (title: z.ZodString) =>
    z.object({ action: z.literal("create"), id, title }).strict(),
  rename: (title: z.ZodString) =>
    z
      .object({
        action: z.literal("rename"),
        id,
        expectedRevision: revision,
        title,
      })
      .strict(),
  archive: z
    .object({
      action: z.enum(["archive", "restore"]),
      id,
      expectedRevision: revision,
    })
    .strict(),
};
const nonEmptyConfiguration = {
  message: "Provide at least one setting to change",
};

export const automationProjectMutationInputSchema = (title: z.ZodString) =>
  z.discriminatedUnion("action", [
    lifecycle.create(title),
    lifecycle.rename(title),
    lifecycle.archive,
    z
      .object({
        action: z.enum(["complete", "reopen"]),
        id,
        expectedRevision: revision,
      })
      .strict(),
    z
      .object({
        action: z.literal("configure"),
        id,
        expectedRevision: revision,
        ...projectConfigureFields,
      })
      .strict()
      .refine(
        ({ color, icon, hiddenFromMenu, backlogEnabled }) =>
          [color, icon, hiddenFromMenu, backlogEnabled].some(
            (value) => value !== undefined,
          ),
        nonEmptyConfiguration,
      ),
  ]);

export const automationTagMutationInputSchema = (title: z.ZodString) =>
  z.discriminatedUnion("action", [
    lifecycle.create(title),
    lifecycle.rename(title),
    lifecycle.archive,
    z
      .object({
        action: z.literal("configure"),
        id,
        expectedRevision: revision,
        ...tagPatchFields,
      })
      .strict()
      .refine(
        ({ color, icon }) => color !== undefined || icon !== undefined,
        nonEmptyConfiguration,
      ),
  ]);

export const automationOrganizationOrderInputSchema =
  organizationOrderRequestSchema;

export const automationProjectBacklogInputSchema = z
  .object({
    projectId: id,
    expectedRevision: revision,
    taskId: id,
    inBacklog: z.boolean(),
  })
  .strict();

export const automationNoteMutationInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("create"),
        id,
        content: noteContentSchema,
        projectId: id.nullable().default(null),
        tagId: id.nullable().default(null),
        pinnedToToday: z.boolean().default(false),
      })
      .strict()
      .refine(singleAssociation, singleAssociationMessage),
    z
      .object({
        action: z.literal("update"),
        id,
        expectedRevision: revision,
        patch: notePatchRequestSchema,
      })
      .strict(),
    z
      .object({ action: z.literal("delete"), id, expectedRevision: revision })
      .strict(),
    z
      .object({
        action: z.literal("reorder"),
        items: organizationOrderItemsSchema,
      })
      .strict(),
  ],
);

export type OrganizationOrderItem = z.infer<
  typeof organizationOrderItemsSchema
>[number];
export type Note = z.infer<typeof noteSchema>;
export type NoteCreateRequest = z.infer<typeof noteCreateRequestSchema>;
export type NotePatchRequest = z.infer<typeof notePatchRequestSchema>;
export type AutomationNoteMutationInput = z.infer<
  typeof automationNoteMutationInputSchema
>;
