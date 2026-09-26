import type {
  BoardMarker,
  BoardPanelFilter,
  MenuFolderKind,
  SectionContextKind,
} from "@suite/contracts";

/**
 * Super Productivity boards, sections and menu folders (issue #63, ADR 0028).
 *
 * - `boards.boardCfgs[]` become boards with panels. Panel filters keep their
 *   tags, projects, done/scheduled/backlog state, parent-only flag and sort;
 *   the system tags TODAY, EM_URGENT, EM_IMPORTANT and KANBAN_IN_PROGRESS
 *   become board markers, never ordinary tags (ADR 0019). Panel `taskIds`
 *   become the manual order.
 * - `section` entities become sections of a project or tag. Sections of the
 *   Today view have no Tadooer context and are reported.
 * - `menuTree` folders become sidebar folders with their nesting; project and
 *   tag order is applied separately (ADR 0019).
 * - Live tasks carrying a marker tag get that marker.
 *
 * Unreviewed fields block. Filter values without a mapping (unknown tags,
 * projects, tasks, sort fields or state codes) are reported as non-blocking
 * `board_notice` findings and dropped, as the source itself tolerates them.
 */

type Source = Record<string, unknown>;
const object = (value: unknown): Source =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Source)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

export const superProductivityBoardFields = {
  id: "applied",
  title: "applied",
  cols: "applied",
  panels: "applied",
} as const;

export const superProductivityBoardPanelFields = {
  id: "applied",
  title: "applied",
  taskIds: "applied",
  includedTagIds: "applied",
  excludedTagIds: "applied",
  includedTagsMatch: "applied",
  excludedTagsMatch: "applied",
  projectIds: "applied",
  // Legacy single project, migrated by the source on load.
  projectId: "applied",
  taskDoneState: "applied",
  scheduledState: "applied",
  backlogState: "applied",
  isParentTasksOnly: "applied",
  sortBy: "applied",
  sortDir: "applied",
  // Legacy due-date sort, migrated to sortBy/sortDir.
  sortByDue: "applied",
} as const;

export const superProductivitySectionFields = {
  id: "applied",
  contextId: "applied",
  contextType: "applied",
  title: "applied",
  isExpanded: "applied",
  taskIds: "applied",
} as const;

export const superProductivityMenuTreeFields = {
  projectTree: "applied",
  tagTree: "applied",
} as const;

export const superProductivityMenuFolderFields = {
  id: "applied",
  k: "applied",
  name: "applied",
  isExpanded: "applied",
  children: "applied",
} as const;

const markerByTag: Readonly<Record<string, BoardMarker>> = {
  TODAY: "today",
  EM_URGENT: "urgent",
  EM_IMPORTANT: "important",
  KANBAN_IN_PROGRESS: "in_progress",
};

export interface BoardSourceTask {
  readonly sourceId: string;
  readonly archived: boolean;
  readonly tagIds: readonly string[];
}

export interface SourceBoard {
  readonly sourceId: string;
  readonly sourceJson: string;
  readonly title: string;
  readonly columns: number;
  readonly panels: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly filter: BoardPanelFilter;
    readonly sourceTaskIds: readonly string[];
  }[];
}
export interface SourceSection {
  readonly sourceId: string;
  readonly sourceJson: string;
  readonly contextKind: SectionContextKind;
  readonly sourceContextId: string;
  readonly title: string;
  readonly expanded: boolean;
  readonly sourceTaskIds: readonly string[];
}
export interface SourceMenuFolder {
  readonly sourceId: string;
  readonly sourceJson: string;
  readonly kind: MenuFolderKind;
  readonly sourceParentId: string | null;
  readonly title: string;
  readonly expanded: boolean;
  readonly sourceItemIds: readonly string[];
}
export interface SourceBoardData {
  readonly boards: readonly SourceBoard[];
  readonly sections: readonly SourceSection[];
  readonly folders: readonly SourceMenuFolder[];
  readonly taskMarkers: readonly {
    readonly sourceTaskId: string;
    readonly markers: readonly Exclude<BoardMarker, "today">[];
  }[];
}

const emptyFilter: BoardPanelFilter = {
  includedTagIds: [],
  includedTagsMatch: "all",
  excludedTagIds: [],
  excludedTagsMatch: "any",
  includedMarkers: [],
  excludedMarkers: [],
  projectIds: [],
  doneState: "all",
  scheduledState: "all",
  backlogState: "all",
  parentsOnly: false,
  sortBy: null,
  sortDir: "asc",
};

export const mapSuperProductivityBoards = (input: {
  readonly boards: unknown;
  readonly section: unknown;
  readonly menuTree: unknown;
  readonly tasks: ReadonlyMap<string, BoardSourceTask>;
  readonly projectIds: ReadonlySet<string>;
  readonly tagIds: ReadonlySet<string>;
  readonly problem: (sourceId: string, detail: string) => void;
  readonly notice: (sourceId: string, detail: string) => void;
}): SourceBoardData => {
  const boards: SourceBoard[] = [];
  const sections: SourceSection[] = [];
  const folders: SourceMenuFolder[] = [];
  const reviewFields = (
    kind: string,
    sourceId: string,
    source: Source,
    fields: Readonly<Record<string, string>>,
  ) => {
    for (const field of Object.keys(source))
      if (!Object.hasOwn(fields, field))
        input.problem(
          sourceId,
          `Unreviewed ${kind} field ${field} blocks import`,
        );
  };
  const title = (
    sourceId: string,
    value: unknown,
    max: number,
    kind: string,
  ): string => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed === "" || trimmed.length > max) {
      input.problem(
        sourceId,
        `${kind} title is missing or longer than ${String(max)} characters`,
      );
      return trimmed === "" ? "Untitled" : trimmed.slice(0, max);
    }
    return trimmed;
  };
  const dropped = (
    sourceId: string,
    what: string,
    count: number,
    where: string,
  ) => {
    if (count > 0)
      input.notice(
        sourceId,
        `${String(count)} ${what}${count === 1 ? "" : "s"} in ${where} ${count === 1 ? "has" : "have"} no mapping and ${count === 1 ? "is" : "are"} not imported`,
      );
  };
  const tasksIn = (
    sourceId: string,
    ids: readonly string[],
    where: string,
  ): string[] => {
    let missing = 0;
    let archived = 0;
    const kept: string[] = [];
    for (const id of ids) {
      const task = input.tasks.get(id);
      if (task === undefined) missing++;
      else if (task.archived) archived++;
      else if (!kept.includes(id)) kept.push(id);
    }
    dropped(sourceId, "task reference", missing, where);
    if (archived > 0)
      input.notice(
        sourceId,
        `${String(archived)} archived ${archived === 1 ? "task" : "tasks"} in ${where} ${archived === 1 ? "is" : "are"} not ordered; history is read-only`,
      );
    return kept;
  };

  // ------------------------------------------------------------- boards
  const boardState = object(input.boards);
  for (const key of Object.keys(boardState))
    if (key !== "boardCfgs")
      input.problem(
        "boards",
        `boards.${key} is not a reviewed Super Productivity 19.1.0 boards field`,
      );
  const configs = boardState.boardCfgs;
  if (configs !== undefined && !Array.isArray(configs))
    input.problem("boards", "boards.boardCfgs must be a list");
  for (const raw of Array.isArray(configs) ? configs : []) {
    const source = object(raw);
    const sourceId =
      typeof source.id === "string" && source.id !== "" ? source.id : "board";
    reviewFields("board", sourceId, source, superProductivityBoardFields);
    if (typeof source.id !== "string" || source.id === "")
      input.problem(sourceId, "A board needs an id");
    const columns =
      typeof source.cols === "number" &&
      Number.isInteger(source.cols) &&
      source.cols >= 1 &&
      source.cols <= 6
        ? source.cols
        : 1;
    if (source.cols !== undefined && columns !== source.cols)
      input.notice(
        sourceId,
        "Board columns are not between 1 and 6; one column is used",
      );
    const panels: SourceBoard["panels"][number][] = [];
    if (!Array.isArray(source.panels))
      input.problem(sourceId, "Board panels must be a list");
    for (const rawPanel of Array.isArray(source.panels) ? source.panels : []) {
      const panel = object(rawPanel);
      const panelId =
        typeof panel.id === "string" && panel.id !== ""
          ? panel.id
          : `${sourceId}/panel`;
      reviewFields(
        "board panel",
        panelId,
        panel,
        superProductivityBoardPanelFields,
      );
      const filter = mapPanelFilter(panel, panelId, input, dropped);
      panels.push({
        sourceId: panelId,
        title: title(panelId, panel.title, 240, "Panel"),
        filter,
        sourceTaskIds: tasksIn(
          panelId,
          strings(panel.taskIds),
          `panel ${panelId}`,
        ),
      });
    }
    if (panels.length > 12) {
      input.problem(sourceId, "A board has more than 12 panels");
    }
    boards.push({
      sourceId,
      sourceJson: JSON.stringify(source),
      title: title(sourceId, source.title, 240, "Board"),
      columns,
      panels,
    });
  }

  // ----------------------------------------------------------- sections
  const sectionState = object(input.section);
  const sectionEntities = object(sectionState.entities);
  for (const [sourceId, raw] of Object.entries(sectionEntities)) {
    const source = object(raw);
    reviewFields("section", sourceId, source, superProductivitySectionFields);
    if (source.id !== sourceId)
      input.problem(sourceId, "Section identity cannot be represented");
    const contextId =
      typeof source.contextId === "string" ? source.contextId : "";
    const contextType = source.contextType;
    if (contextType === "TAG" && contextId === "TODAY") {
      input.notice(
        sourceId,
        "A section of the Today view has no Tadooer context and is not imported",
      );
      continue;
    }
    const contextKind: SectionContextKind | undefined =
      contextType === "PROJECT"
        ? "project"
        : contextType === "TAG"
          ? "tag"
          : undefined;
    if (contextKind === undefined) {
      input.problem(sourceId, "Section contextType must be PROJECT or TAG");
      continue;
    }
    const known = contextKind === "project" ? input.projectIds : input.tagIds;
    if (!known.has(contextId)) {
      input.notice(
        sourceId,
        `A section references a ${contextKind} absent from the export and is not imported`,
      );
      continue;
    }
    if (
      source.isExpanded !== undefined &&
      typeof source.isExpanded !== "boolean"
    )
      input.problem(sourceId, "isExpanded must be Boolean");
    sections.push({
      sourceId,
      sourceJson: JSON.stringify(source),
      contextKind,
      sourceContextId: contextId,
      title: title(sourceId, source.title, 200, "Section"),
      expanded: source.isExpanded !== false,
      sourceTaskIds: tasksIn(
        sourceId,
        strings(source.taskIds),
        `section ${sourceId}`,
      ),
    });
  }

  // ---------------------------------------------------------- menu tree
  const menuTree = object(input.menuTree);
  for (const key of Object.keys(menuTree))
    if (!Object.hasOwn(superProductivityMenuTreeFields, key))
      input.problem(
        "menuTree",
        `menuTree.${key} is not a reviewed Super Productivity 19.1.0 menuTree field`,
      );
  const visit = (
    nodes: unknown,
    kind: MenuFolderKind,
    parentId: string | null,
    depth: number,
  ): void => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      const node = object(raw);
      if (node.k !== "f") continue;
      const sourceId =
        typeof node.id === "string" && node.id !== ""
          ? node.id
          : `${kind}-folder`;
      reviewFields(
        "menuTree folder",
        sourceId,
        node,
        superProductivityMenuFolderFields,
      );
      if (depth >= 8) {
        input.notice(
          sourceId,
          "A menu folder nested deeper than 8 levels is placed at the deepest level",
        );
      }
      const children = Array.isArray(node.children) ? node.children : [];
      const known = kind === "project" ? input.projectIds : input.tagIds;
      const items = children
        .map((child) => object(child))
        .filter(
          (child) =>
            child.k === (kind === "project" ? "p" : "t") &&
            typeof child.id === "string",
        )
        .map((child) => child.id as string);
      dropped(
        sourceId,
        "folder item",
        items.filter((id) => !known.has(id)).length,
        `folder ${sourceId}`,
      );
      folders.push({
        sourceId,
        sourceJson: JSON.stringify({ ...node, children: undefined }),
        kind,
        sourceParentId: parentId,
        title: title(
          sourceId,
          typeof node.name === "string" && node.name.trim() !== ""
            ? node.name
            : "Folder",
          100,
          "Folder",
        ),
        expanded: node.isExpanded === true,
        sourceItemIds: items.filter((id) => known.has(id)),
      });
      visit(children, kind, sourceId, Math.min(depth + 1, 7));
    }
  };
  visit(menuTree.projectTree, "project", null, 0);
  visit(menuTree.tagTree, "tag", null, 0);

  // ------------------------------------------------------------ markers
  const taskMarkers: SourceBoardData["taskMarkers"] = [...input.tasks.values()]
    .filter((task) => !task.archived)
    .flatMap((task) => {
      const markers = task.tagIds.flatMap((tagId) => {
        const marker = markerByTag[tagId];
        return marker === undefined || marker === "today" ? [] : [marker];
      });
      return markers.length === 0
        ? []
        : [{ sourceTaskId: task.sourceId, markers: [...new Set(markers)] }];
    });

  return { boards, sections, folders, taskMarkers };
};

/** Source enum codes (1 = all) to Tadooer panel states. */
const stateCodes: Readonly<Record<string, readonly [string, string, string]>> =
  {
    taskDoneState: ["all", "done", "open"],
    scheduledState: ["all", "scheduled", "unscheduled"],
    backlogState: ["all", "no_backlog", "only_backlog"],
  };

const mapPanelFilter = (
  panel: Source,
  panelId: string,
  input: {
    readonly projectIds: ReadonlySet<string>;
    readonly tagIds: ReadonlySet<string>;
    readonly problem: (sourceId: string, detail: string) => void;
    readonly notice: (sourceId: string, detail: string) => void;
  },
  dropped: (
    sourceId: string,
    what: string,
    count: number,
    where: string,
  ) => void,
): BoardPanelFilter => {
  const splitTags = (value: unknown, role: string) => {
    const tags: string[] = [];
    const markers: BoardMarker[] = [];
    let unknown = 0;
    for (const id of strings(value)) {
      const marker = markerByTag[id];
      if (marker !== undefined) {
        if (!markers.includes(marker)) markers.push(marker);
      } else if (input.tagIds.has(id)) {
        if (!tags.includes(id)) tags.push(id);
      } else unknown++;
    }
    dropped(panelId, `${role} tag`, unknown, `panel ${panelId}`);
    return { tags, markers };
  };
  const included = splitTags(panel.includedTagIds, "included");
  const excluded = splitTags(panel.excludedTagIds, "excluded");
  const projectIds = [
    ...new Set([
      ...strings(panel.projectIds),
      ...(typeof panel.projectId === "string" ? [panel.projectId] : []),
    ]),
  ].filter((id) => id !== "");
  const allProjects =
    panel.projectIds === undefined ||
    strings(panel.projectIds).includes("") ||
    projectIds.length === 0;
  const knownProjects = allProjects
    ? []
    : projectIds.filter((id) => input.projectIds.has(id));
  dropped(
    panelId,
    "project",
    allProjects ? 0 : projectIds.length - knownProjects.length,
    `panel ${panelId}`,
  );
  const state = (key: keyof typeof stateCodes): string => {
    const value = panel[key];
    const codes = stateCodes[key] ?? ["all", "all", "all"];
    if (value === undefined) return codes[0];
    const mapped =
      typeof value === "number" && Number.isInteger(value)
        ? codes[value - 1]
        : undefined;
    if (mapped === undefined) {
      input.notice(
        panelId,
        `${key} ${JSON.stringify(value)} has no mapping; the panel shows all tasks for it`,
      );
      return codes[0];
    }
    return mapped;
  };
  let sortBy: BoardPanelFilter["sortBy"] = null;
  let sortDir: BoardPanelFilter["sortDir"] = "asc";
  if (panel.sortByDue === "asc" || panel.sortByDue === "desc") {
    sortBy = "dueDate";
    sortDir = panel.sortByDue;
  }
  if (panel.sortBy != null) {
    if (
      typeof panel.sortBy === "string" &&
      ["dueDate", "created", "title", "timeEstimate"].includes(panel.sortBy)
    )
      sortBy = panel.sortBy as BoardPanelFilter["sortBy"];
    else
      input.notice(
        panelId,
        `sortBy ${JSON.stringify(panel.sortBy)} has no mapping; the panel keeps its manual order`,
      );
  }
  if (panel.sortDir === "asc" || panel.sortDir === "desc")
    sortDir = panel.sortDir;
  const match = (
    value: unknown,
    allowed: readonly string[],
    fallback: string,
  ): string => {
    if (value == null) return fallback;
    if (typeof value === "string" && allowed.includes(value)) return value;
    input.notice(
      panelId,
      `A tag match mode has no mapping; ${fallback} is used`,
    );
    return fallback;
  };
  if (
    panel.isParentTasksOnly !== undefined &&
    typeof panel.isParentTasksOnly !== "boolean"
  )
    input.problem(panelId, "isParentTasksOnly must be Boolean");
  if (
    included.tags.some((id) => excluded.tags.includes(id)) ||
    included.markers.some((marker) => excluded.markers.includes(marker))
  )
    input.problem(
      panelId,
      "A panel includes and excludes the same tag or marker",
    );
  return {
    ...emptyFilter,
    includedTagIds: included.tags,
    includedTagsMatch: match(panel.includedTagsMatch, ["all", "any"], "all") as
      "all" | "any",
    excludedTagIds: excluded.tags,
    excludedTagsMatch: match(panel.excludedTagsMatch, ["any", "all"], "any") as
      "any" | "all",
    includedMarkers: included.markers,
    excludedMarkers: excluded.markers,
    projectIds: knownProjects,
    doneState: state("taskDoneState") as BoardPanelFilter["doneState"],
    scheduledState: state(
      "scheduledState",
    ) as BoardPanelFilter["scheduledState"],
    backlogState: state("backlogState") as BoardPanelFilter["backlogState"],
    parentsOnly: panel.isParentTasksOnly === true,
    sortBy,
    sortDir,
  };
};
