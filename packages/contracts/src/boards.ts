import { z } from "zod";

/**
 * Boards, sections, saved task views and sidebar folders (issue #63, ADR
 * 0028). All four are owner-scoped online HTTP records with revisions; none
 * is in the sync change feed or the offline cache.
 */

const id = z.uuid();
const revision = z.number().int().positive();
const uniqueIds = (max: number) =>
  z
    .array(id)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "IDs must be unique",
    });

// ---------------------------------------------------------------- boards

/**
 * Board markers replace Super Productivity's system tags. `urgent`,
 * `important` and `in_progress` are stored per task outside its tags;
 * `today` is derived from the task's planned day or start (ADR 0027).
 */
export const boardMarkerSchema = z.enum([
  "urgent",
  "important",
  "in_progress",
  "today",
]);
export const storedBoardMarkers = [
  "urgent",
  "important",
  "in_progress",
] as const;
export const boardPanelSortSchema = z.enum([
  "dueDate",
  "created",
  "title",
  "timeEstimate",
]);
export const boardMaxPanels = 12;
export const boardMaxColumns = 6;
export const boardPanelMaxTasks = 500;

export const boardPanelFilterSchema = z
  .object({
    includedTagIds: uniqueIds(25).default([]),
    /** `all`: every included tag or marker; `any`: at least one. */
    includedTagsMatch: z.enum(["all", "any"]).default("all"),
    excludedTagIds: uniqueIds(25).default([]),
    /** `any`: one excluded tag hides the task; `all`: only all of them do. */
    excludedTagsMatch: z.enum(["any", "all"]).default("any"),
    includedMarkers: z.array(boardMarkerSchema).max(4).default([]),
    excludedMarkers: z.array(boardMarkerSchema).max(4).default([]),
    /** Empty means every project, including tasks without one. */
    projectIds: uniqueIds(100).default([]),
    doneState: z.enum(["all", "done", "open"]).default("all"),
    scheduledState: z.enum(["all", "scheduled", "unscheduled"]).default("all"),
    backlogState: z.enum(["all", "no_backlog", "only_backlog"]).default("all"),
    parentsOnly: z.boolean().default(false),
    /** Null keeps the panel's manual order. */
    sortBy: boardPanelSortSchema.nullable().default(null),
    sortDir: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict()
  .refine(
    (filter) =>
      !filter.includedTagIds.some((tag) => filter.excludedTagIds.includes(tag)),
    { message: "A tag cannot be included and excluded" },
  )
  .refine(
    (filter) =>
      !filter.includedMarkers.some((marker) =>
        filter.excludedMarkers.includes(marker),
      ),
    { message: "A marker cannot be included and excluded" },
  );

export const boardPanelSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(240),
    filter: boardPanelFilterSchema,
  })
  .strict();

export const boardSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(240),
    columns: z.number().int().min(1).max(boardMaxColumns),
    position: z.number().int().nonnegative(),
    revision,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    panels: z.array(boardPanelSchema).max(boardMaxPanels),
  })
  .strict();

/** Panel membership computed on read; manual ranks first when unsorted. */
export const boardPanelMembershipSchema = z
  .object({ panelId: id, taskIds: uniqueIds(boardPanelMaxTasks) })
  .strict();

export const boardViewSchema = z
  .object({
    board: boardSchema,
    /** The planning date used for the `today` marker. */
    today: z.iso.date(),
    members: z.array(boardPanelMembershipSchema),
    /** Stored markers of every task that appears in a panel. */
    markers: z.record(id, z.array(boardMarkerSchema)),
  })
  .strict();

export const boardPanelInputSchema = z
  .object({
    /** Absent for a new panel. */
    id: id.optional(),
    title: z.string().trim().min(1).max(240),
    filter: boardPanelFilterSchema.optional(),
  })
  .strict();

export const boardTemplateSchema = z.enum(["eisenhower", "kanban"]);

export const boardCreateRequestSchema = z
  .union([
    z
      .object({
        title: z.string().trim().min(1).max(240),
        columns: z.number().int().min(1).max(boardMaxColumns).default(1),
        panels: z.array(boardPanelInputSchema).max(boardMaxPanels).default([]),
      })
      .strict(),
    z.object({ template: boardTemplateSchema }).strict(),
  ])
  .describe("A board configuration or a default template");

/** Full replacement of a board's configuration, in panel order. */
export const boardUpdateRequestSchema = z
  .object({
    expectedRevision: revision,
    title: z.string().trim().min(1).max(240),
    columns: z.number().int().min(1).max(boardMaxColumns),
    panels: z.array(boardPanelInputSchema).max(boardMaxPanels),
  })
  .strict()
  .refine(
    (input) => {
      const ids = input.panels.flatMap((panel) =>
        panel.id === undefined ? [] : [panel.id],
      );
      return new Set(ids).size === ids.length;
    },
    { message: "Panel IDs must be unique" },
  );

export const boardOrderRequestSchema = z
  .object({ items: z.array(z.object({ id, revision }).strict()).max(100) })
  .strict();

/** Full-list manual order of one panel's current members. */
export const boardPanelOrderRequestSchema = z
  .object({
    expectedRevision: revision,
    taskIds: uniqueIds(boardPanelMaxTasks),
  })
  .strict();

/**
 * One explicit change a panel move applies to a task. The list is shown
 * before the move (dry run or assistant preview) and returned after it.
 */
export const boardMoveChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_tag"), tagId: id }).strict(),
  z.object({ kind: z.literal("remove_tag"), tagId: id }).strict(),
  z
    .object({ kind: z.literal("add_marker"), marker: boardMarkerSchema })
    .strict(),
  z
    .object({ kind: z.literal("remove_marker"), marker: boardMarkerSchema })
    .strict(),
  z.object({ kind: z.literal("complete") }).strict(),
  z.object({ kind: z.literal("reopen") }).strict(),
  z.object({ kind: z.literal("assign_project"), projectId: id }).strict(),
  z.object({ kind: z.literal("plan_today"), date: z.iso.date() }).strict(),
  z.object({ kind: z.literal("clear_planned_day") }).strict(),
  z.object({ kind: z.literal("add_to_backlog") }).strict(),
  z.object({ kind: z.literal("remove_from_backlog") }).strict(),
]);

export const boardMoveRequestSchema = z
  .object({
    expectedRevision: revision,
    taskId: id,
    taskRevision: revision,
    /** Rank inside the panel's manual order; appended when absent. */
    position: z.number().int().nonnegative().optional(),
    /** Report the changes without applying them. */
    dryRun: z.boolean().default(false),
  })
  .strict();

export const boardMoveResponseSchema = z
  .object({
    applied: z.boolean(),
    changes: z.array(boardMoveChangeSchema),
    /** Present after an applied move. */
    view: boardViewSchema.optional(),
  })
  .strict();

export const boardListResponseSchema = z
  .object({ boards: z.array(boardSchema) })
  .strict();
export const boardResponseSchema = z.object({ board: boardSchema }).strict();
export const boardViewResponseSchema = z
  .object({ view: boardViewSchema })
  .strict();

// -------------------------------------------------------------- sections

export const sectionContextKindSchema = z.enum(["project", "tag"]);
export const sectionMaxTasks = 500;

export const sectionSchema = z
  .object({
    id,
    contextKind: sectionContextKindSchema,
    contextId: id,
    title: z.string().trim().min(1).max(200),
    expanded: z.boolean(),
    position: z.number().int().nonnegative(),
    revision,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** Current active members of the context, in section order. */
    taskIds: uniqueIds(sectionMaxTasks),
  })
  .strict();

export const sectionContextSchema = z
  .object({ contextKind: sectionContextKindSchema, contextId: id })
  .strict();

export const sectionCreateRequestSchema = sectionContextSchema
  .extend({ title: z.string().trim().min(1).max(200) })
  .strict();

/** Full membership when taskIds is present; a task leaves any sibling section. */
export const sectionUpdateRequestSchema = z
  .object({
    expectedRevision: revision,
    title: z.string().trim().min(1).max(200).optional(),
    expanded: z.boolean().optional(),
    taskIds: uniqueIds(sectionMaxTasks).optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.title !== undefined ||
      patch.expanded !== undefined ||
      patch.taskIds !== undefined,
    { message: "Provide a title, expanded state or task list" },
  );

export const sectionOrderRequestSchema = sectionContextSchema
  .extend({ items: z.array(z.object({ id, revision }).strict()).max(200) })
  .strict();

export const sectionListResponseSchema = z
  .object({ sections: z.array(sectionSchema) })
  .strict();
export const sectionResponseSchema = z
  .object({ section: sectionSchema })
  .strict();

// ------------------------------------------------------------ task views

export const taskViewContextKindSchema = z.enum([
  "all",
  "today",
  "project",
  "tag",
]);
export const taskViewSortSchema = z.enum([
  "name",
  "scheduledDate",
  "deadline",
  "creationDate",
  "estimatedTime",
  "timeSpent",
]);
export const taskViewGroupSchema = z.enum([
  "tag",
  "project",
  "scheduledDate",
  "deadline",
]);
export const taskViewFilterKindSchema = z.enum([
  "tag",
  "project",
  "scheduledDate",
  "deadline",
  "estimatedTime",
  "timeSpent",
]);
export const taskViewDatePresetSchema = z.enum([
  "today",
  "tomorrow",
  "thisWeek",
  "nextWeek",
  "thisMonth",
  "nextMonth",
  "unspecified",
]);
/** Minute buckets of Super Productivity's time filter presets. */
export const taskViewTimePresetSchema = z.enum(["10", "30", "60", "120"]);

export const taskViewFilterSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("tag"), tagId: id }).strict(),
    z.object({ kind: z.literal("project"), projectId: id }).strict(),
    z
      .object({
        kind: z.literal("scheduledDate"),
        preset: taskViewDatePresetSchema,
      })
      .strict(),
    z
      .object({ kind: z.literal("deadline"), preset: taskViewDatePresetSchema })
      .strict(),
    z
      .object({
        kind: z.literal("estimatedTime"),
        preset: taskViewTimePresetSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("timeSpent"),
        preset: taskViewTimePresetSchema,
      })
      .strict(),
  ])
  .nullable();

const taskViewContextSchema = z.object({
  contextKind: taskViewContextKindSchema,
  /** Empty for `all` and `today`. */
  contextId: z.union([id, z.literal("")]).default(""),
});

export const taskViewSchema = taskViewContextSchema
  .extend({
    sortBy: taskViewSortSchema.nullable(),
    sortDir: z.enum(["asc", "desc"]),
    groupBy: taskViewGroupSchema.nullable(),
    filter: taskViewFilterSchema,
    /** Group keys the owner collapsed. */
    collapsedGroups: z.array(z.string().max(120)).max(200),
    /** 0 until the context has a saved view. */
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (view) =>
      (view.contextKind === "project" || view.contextKind === "tag") ===
      (view.contextId !== ""),
    { message: "Project and tag views need a context ID; others none" },
  );

export const taskViewSetRequestSchema = taskViewContextSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    sortBy: taskViewSortSchema.nullable().default(null),
    sortDir: z.enum(["asc", "desc"]).default("asc"),
    groupBy: taskViewGroupSchema.nullable().default(null),
    filter: taskViewFilterSchema.default(null),
    collapsedGroups: z.array(z.string().max(120)).max(200).default([]),
  })
  .strict()
  .refine(
    (view) =>
      (view.contextKind === "project" || view.contextKind === "tag") ===
      (view.contextId !== ""),
    { message: "Project and tag views need a context ID; others none" },
  );

export const taskViewListResponseSchema = z
  .object({ views: z.array(taskViewSchema) })
  .strict();
export const taskViewResponseSchema = z
  .object({ view: taskViewSchema })
  .strict();

// ---------------------------------------------------------- menu folders

export const menuFolderKindSchema = z.enum(["project", "tag"]);
/** Deepest folder nesting the sidebar keeps. */
export const menuFolderMaxDepth = 8;

export const menuFolderSchema = z
  .object({
    id,
    kind: menuFolderKindSchema,
    /** Enclosing folder of the same kind; null at the top level. */
    parentId: id.nullable(),
    title: z.string().trim().min(1).max(100),
    expanded: z.boolean(),
    /** Order among the siblings of the same parent. */
    position: z.number().int().nonnegative(),
    revision,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** Project or tag IDs in folder order; an item is in at most one folder. */
    itemIds: uniqueIds(500),
  })
  .strict();

export const menuFolderCreateRequestSchema = z
  .object({
    kind: menuFolderKindSchema,
    parentId: id.nullable().default(null),
    title: z.string().trim().min(1).max(100),
    itemIds: uniqueIds(500).default([]),
  })
  .strict();

export const menuFolderUpdateRequestSchema = z
  .object({
    expectedRevision: revision,
    title: z.string().trim().min(1).max(100).optional(),
    expanded: z.boolean().optional(),
    /** Moves the folder under another folder (or to the top level with null). */
    parentId: id.nullable().optional(),
    itemIds: uniqueIds(500).optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.title !== undefined ||
      patch.expanded !== undefined ||
      patch.parentId !== undefined ||
      patch.itemIds !== undefined,
    { message: "Provide a title, expanded state, parent or item list" },
  );

/** Full-list reorder of the folders that share one parent. */
export const menuFolderOrderRequestSchema = z
  .object({
    kind: menuFolderKindSchema,
    parentId: id.nullable().default(null),
    items: z.array(z.object({ id, revision }).strict()).max(200),
  })
  .strict();

export const menuFolderListResponseSchema = z
  .object({ folders: z.array(menuFolderSchema) })
  .strict();
export const menuFolderResponseSchema = z
  .object({ folder: menuFolderSchema })
  .strict();

// ---------------------------------------------------------- assistant

export const automationBoardsResourceInputSchema = z
  .object({ boardId: id.optional() })
  .strict();
export const automationBoardsResourceSchema = z
  .object({ boards: z.array(boardSchema), views: z.array(boardViewSchema) })
  .strict();

export const automationBoardMutationInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("create"),
        board: boardCreateRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("update"),
        boardId: id,
        board: boardUpdateRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("delete"),
        boardId: id,
        expectedRevision: revision,
      })
      .strict(),
    z
      .object({
        action: z.literal("reorder_panel"),
        boardId: id,
        panelId: id,
        order: boardPanelOrderRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("move_task"),
        boardId: id,
        panelId: id,
        move: boardMoveRequestSchema.omit({ dryRun: true }),
      })
      .strict(),
  ],
);

export const automationSectionsResourceInputSchema = sectionContextSchema;
export const automationSectionMutationInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("create"),
        section: sectionCreateRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("update"),
        sectionId: id,
        section: sectionUpdateRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("delete"),
        sectionId: id,
        expectedRevision: revision,
      })
      .strict(),
    z
      .object({
        action: z.literal("reorder"),
        order: sectionOrderRequestSchema,
      })
      .strict(),
  ],
);

export const automationMenuFolderMutationInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("create"),
        folder: menuFolderCreateRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("update"),
        folderId: id,
        folder: menuFolderUpdateRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("delete"),
        folderId: id,
        expectedRevision: revision,
      })
      .strict(),
    z
      .object({
        action: z.literal("reorder"),
        order: menuFolderOrderRequestSchema,
      })
      .strict(),
  ],
);

export const boardMutationResponseSchema = z
  .object({
    boards: z.array(boardSchema).optional(),
    view: boardViewSchema.optional(),
    changes: z.array(boardMoveChangeSchema).optional(),
  })
  .strict();
export const sectionMutationResponseSchema = z
  .object({ sections: z.array(sectionSchema) })
  .strict();
export const menuFolderMutationResponseSchema = z
  .object({ folders: z.array(menuFolderSchema) })
  .strict();

export type BoardMarker = z.infer<typeof boardMarkerSchema>;
export type BoardPanelFilter = z.infer<typeof boardPanelFilterSchema>;
export type BoardPanelFilterInput = z.input<typeof boardPanelFilterSchema>;
export type BoardPanel = z.infer<typeof boardPanelSchema>;
export type Board = z.infer<typeof boardSchema>;
export type BoardView = z.infer<typeof boardViewSchema>;
export type BoardTemplate = z.infer<typeof boardTemplateSchema>;
export type BoardCreateRequest = z.infer<typeof boardCreateRequestSchema>;
export type BoardUpdateRequest = z.infer<typeof boardUpdateRequestSchema>;
export type BoardMoveChange = z.infer<typeof boardMoveChangeSchema>;
export type BoardMoveRequest = z.infer<typeof boardMoveRequestSchema>;
export type BoardMoveResponse = z.infer<typeof boardMoveResponseSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type SectionContextKind = z.infer<typeof sectionContextKindSchema>;
export type SectionCreateRequest = z.infer<typeof sectionCreateRequestSchema>;
export type SectionUpdateRequest = z.infer<typeof sectionUpdateRequestSchema>;
export type TaskView = z.infer<typeof taskViewSchema>;
export type TaskViewContextKind = z.infer<typeof taskViewContextKindSchema>;
export type TaskViewFilter = z.infer<typeof taskViewFilterSchema>;
export type TaskViewSetRequest = z.infer<typeof taskViewSetRequestSchema>;
export type MenuFolder = z.infer<typeof menuFolderSchema>;
export type MenuFolderKind = z.infer<typeof menuFolderKindSchema>;
export type MenuFolderCreateRequest = z.infer<
  typeof menuFolderCreateRequestSchema
>;
export type MenuFolderUpdateRequest = z.infer<
  typeof menuFolderUpdateRequestSchema
>;
