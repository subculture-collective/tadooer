import type {
  ChoicePool,
  ChoicePoolHistoryEvent,
  ChoicePoolItem,
  ChoicePoolSuggestionResponse,
  PlanningPlaceholder,
  TemplatePoolSlot,
  Task,
} from "@suite/contracts";
import { TemplateLibrary, type TemplateView, type TemplateBlueprintView, type TemplateSetView } from "../template-library.tsx";
import { ChoicePoolLibrary } from "../choice-pool-library.tsx";

export interface ReusePageProps {
  readonly templates: readonly TemplateView[];
  readonly templateBlueprints: readonly TemplateBlueprintView[];
  readonly templateSets: readonly TemplateSetView[];
  readonly choicePools: readonly ChoicePool[];
  readonly choicePoolItems: readonly ChoicePoolItem[];
  readonly choicePoolHistory: readonly ChoicePoolHistoryEvent[];
  readonly planningPlaceholders: readonly PlanningPlaceholder[];
  readonly templatePoolSlots: readonly TemplatePoolSlot[];
  readonly tasks: readonly Task[];
  readonly projects: readonly { id: string; title: string }[];
  readonly tags: readonly { id: string; displayName: string }[];
  readonly busy: boolean;
  readonly onCreateTemplate: (draft: {
    title: string;
    notes: string;
    estimateMinutes: number | null;
    suggestedProjectId: string | null;
    tagIds: readonly string[];
    subtasks: readonly { title: string }[];
  }) => Promise<void>;
  readonly onSearchTemplates: (query: string) => void;
  readonly onArchiveTemplate: (template: TemplateView) => Promise<void>;
  readonly onEditTemplate: (
    template: TemplateView,
    draft: {
      title: string;
      notes: string;
      estimateMinutes: number | null;
      suggestedProjectId: string | null;
      tagIds: readonly string[];
      subtasks: readonly { title: string }[];
    },
  ) => Promise<void>;
  readonly onCreateTemplateSet: (
    title: string,
    templateIds: readonly string[],
  ) => Promise<void>;
  readonly onInstantiateTemplate: (
    templateId: string,
    projectId: string,
  ) => Promise<void>;
  readonly onInstantiateTemplateSet: (
    setId: string,
    projectId: string,
  ) => Promise<void>;
  readonly onCreateChoicePool: (input: {
    title: string;
    policy: "none" | "cooldown" | "cycle" | "one_shot";
    pickCount: number;
    cooldownSeconds: number | null;
    items: readonly { title: string }[];
  }) => Promise<void>;
  readonly onCreatePlanningPlaceholder: (
    taskId: string,
    poolId: string,
  ) => Promise<void>;
  readonly onEditChoicePool: (
    pool: ChoicePool,
    input: {
      title: string;
      policy: "none" | "cooldown" | "cycle" | "one_shot";
      pickCount: number;
      cooldownSeconds: number | null;
      items: readonly { readonly id?: string; readonly title: string }[];
    },
  ) => Promise<void>;
  readonly onAddTemplatePoolSlot: (
    templateId: string,
    poolId: string,
    pickCount: number,
    position: number,
  ) => Promise<void>;
  readonly onRecordChoicePoolCompletion: (
    poolId: string,
    itemId: string,
    placeholderId: string,
  ) => Promise<void>;
  readonly onSuggestPlaceholder: (
    placeholderId: string,
  ) => Promise<ChoicePoolSuggestionResponse>;
  readonly onResolvePlaceholder: (
    placeholder: PlanningPlaceholder,
    suggestion: ChoicePoolSuggestionResponse,
    selectedItemIds: readonly string[],
    override: boolean,
  ) => Promise<void>;
}

export const ReusePage = ({
  templates,
  templateBlueprints,
  templateSets,
  choicePools,
  choicePoolItems,
  choicePoolHistory,
  planningPlaceholders,
  templatePoolSlots,
  tasks,
  projects,
  tags,
  busy,
  onCreateTemplate,
  onSearchTemplates,
  onArchiveTemplate,
  onEditTemplate,
  onCreateTemplateSet,
  onInstantiateTemplate,
  onInstantiateTemplateSet,
  onCreateChoicePool,
  onCreatePlanningPlaceholder,
  onEditChoicePool,
  onAddTemplatePoolSlot,
  onRecordChoicePoolCompletion,
  onSuggestPlaceholder,
  onResolvePlaceholder,
}: ReusePageProps) => {
  return (
    <>
      <TemplateLibrary
        templates={templates}
        blueprints={templateBlueprints}
        sets={templateSets}
        projects={projects}
        tags={tags}
        busy={busy}
        onCreate={onCreateTemplate}
        onSearch={(query) => onSearchTemplates(query)}
        onArchive={onArchiveTemplate}
        onEdit={onEditTemplate}
        onCreateSet={onCreateTemplateSet}
        onInstantiate={onInstantiateTemplate}
        onInstantiateSet={onInstantiateTemplateSet}
      />
      <ChoicePoolLibrary
        pools={choicePools}
        items={choicePoolItems}
        history={choicePoolHistory}
        placeholders={planningPlaceholders}
        tasks={tasks}
        templates={templates}
        poolSlots={templatePoolSlots}
        busy={busy}
        onCreatePool={onCreateChoicePool}
        onCreatePlaceholder={onCreatePlanningPlaceholder}
        onEditPool={onEditChoicePool}
        onCreateTemplateSlot={onAddTemplatePoolSlot}
        onRecordCompletion={onRecordChoicePoolCompletion}
        onSuggest={onSuggestPlaceholder}
        onResolve={onResolvePlaceholder}
      />
    </>
  );
};
