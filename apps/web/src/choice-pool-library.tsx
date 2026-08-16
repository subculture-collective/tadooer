import { useState, type SyntheticEvent } from "react";
import type {
  ChoicePool,
  ChoicePoolHistoryEvent,
  ChoicePoolItem,
  ChoicePoolSuggestionResponse,
  PlanningPlaceholder,
  TemplatePoolSlot,
  Task,
} from "@suite/contracts";

export interface ChoicePoolLibraryProps {
  readonly pools: readonly ChoicePool[];
  readonly items: readonly ChoicePoolItem[];
  readonly history: readonly ChoicePoolHistoryEvent[];
  readonly placeholders: readonly PlanningPlaceholder[];
  readonly tasks: readonly Task[];
  readonly templates: readonly {
    readonly id: string;
    readonly title: string;
    readonly archivedAt: string | null;
  }[];
  readonly poolSlots: readonly TemplatePoolSlot[];
  readonly busy: boolean;
  readonly onCreatePool: (input: {
    title: string;
    policy: "none" | "cooldown" | "cycle" | "one_shot";
    pickCount: number;
    cooldownSeconds: number | null;
    items: readonly { title: string }[];
  }) => Promise<void>;
  readonly onCreatePlaceholder: (
    taskId: string,
    poolId: string,
  ) => Promise<void>;
  readonly onEditPool: (
    pool: ChoicePool,
    input: {
      title: string;
      policy: "none" | "cooldown" | "cycle" | "one_shot";
      pickCount: number;
      cooldownSeconds: number | null;
      items: readonly { readonly id?: string; readonly title: string }[];
    },
  ) => Promise<void>;
  readonly onCreateTemplateSlot: (
    templateId: string,
    poolId: string,
    pickCount: number,
    position: number,
  ) => Promise<void>;
  readonly onRecordCompletion: (
    poolId: string,
    itemId: string,
    placeholderId: string,
  ) => Promise<void>;
  readonly onSuggest: (
    placeholderId: string,
  ) => Promise<ChoicePoolSuggestionResponse>;
  readonly onResolve: (
    placeholder: PlanningPlaceholder,
    suggestion: ChoicePoolSuggestionResponse,
    selectedItemIds: readonly string[],
    override: boolean,
  ) => Promise<void>;
}

const value = (data: FormData, key: string): string => {
  const found = data.get(key);
  return typeof found === "string" ? found : "";
};

const reasonText: Readonly<Record<string, string>> = {
  eligible: "Eligible now",
  archived: "Archived",
  cooldown: "Cooling down",
  cycle_selected: "Already selected in this cycle",
  one_shot_selected: "One-shot item already selected",
};

export const ChoicePoolLibrary = ({
  pools,
  items,
  history,
  placeholders,
  tasks,
  templates,
  poolSlots,
  busy,
  onCreatePool,
  onCreatePlaceholder,
  onEditPool,
  onCreateTemplateSlot,
  onRecordCompletion,
  onSuggest,
  onResolve,
}: ChoicePoolLibraryProps) => {
  const [suggestions, setSuggestions] = useState<
    Readonly<Record<string, ChoicePoolSuggestionResponse>>
  >({});
  const [selected, setSelected] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});

  const createPool = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const policy = value(data, "policy") as
      "none" | "cooldown" | "cycle" | "one_shot";
    const itemDrafts = value(data, "items")
      .split("\n")
      .map((title) => title.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
    await onCreatePool({
      title: value(data, "title"),
      policy,
      pickCount: Number(value(data, "pickCount")),
      cooldownSeconds:
        policy === "cooldown"
          ? Number(value(data, "cooldownDays")) * 86_400
          : null,
      items: itemDrafts,
    });
    form.reset();
  };

  const createPlaceholder = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await onCreatePlaceholder(value(data, "taskId"), value(data, "poolId"));
    event.currentTarget.reset();
  };

  const preview = async (placeholderId: string) => {
    const suggestion = await onSuggest(placeholderId);
    setSuggestions((current) => ({ ...current, [placeholderId]: suggestion }));
    setSelected((current) => ({
      ...current,
      [placeholderId]: suggestion.selectedItemIds,
    }));
  };

  return (
    <section
      className="choice-pool-library"
      aria-labelledby="choice-pool-title"
    >
      <div className="section-heading">
        <div>
          <p className="step">Resolve vague work deliberately</p>
          <h3 id="choice-pool-title">Choice Pools</h3>
        </div>
      </div>
      <p className="muted">
        Candidates remain inert until you preview and confirm a planning
        placeholder. Eligibility is explainable and based on recorded selection
        history.
      </p>
      <form
        className="choice-pool-create"
        onSubmit={(event) => void createPool(event)}
      >
        <label className="field">
          <span>Pool name</span>
          <input name="title" required maxLength={240} />
        </label>
        <label className="field">
          <span>Policy</span>
          <select name="policy" defaultValue="cycle">
            <option value="none">Always eligible</option>
            <option value="cooldown">Cooldown after selection</option>
            <option value="cycle">Cycle without replacement</option>
            <option value="one_shot">One shot</option>
          </select>
        </label>
        <label className="field">
          <span>Pick count</span>
          <input
            name="pickCount"
            type="number"
            min="1"
            max="25"
            defaultValue="1"
            required
          />
        </label>
        <label className="field">
          <span>Cooldown days (used only for cooldown)</span>
          <input
            name="cooldownDays"
            type="number"
            min="1"
            max="365"
            defaultValue="5"
            required
          />
        </label>
        <label className="field choice-pool-items">
          <span>Candidates, one per line</span>
          <textarea name="items" rows={5} required />
        </label>
        <button disabled={busy}>Create pool</button>
      </form>
      {pools.length === 0 ? (
        <p className="muted">No Choice Pools yet.</p>
      ) : (
        <ul className="choice-pools">
          {pools.map((pool) => (
            <li key={pool.id}>
              <strong>{pool.title}</strong>
              <span>
                Pick {pool.pickCount} · {pool.policy.replaceAll("_", " ")} ·{" "}
                {history.filter(({ poolId }) => poolId === pool.id).length}{" "}
                history events
              </span>
              <ol>
                {items
                  .filter(({ poolId }) => poolId === pool.id)
                  .map((item) => (
                    <li key={item.id}>{item.title}</li>
                  ))}
              </ol>
              <details>
                <summary>Edit pool and candidates</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    const policy = value(
                      data,
                      "policy",
                    ) as ChoicePool["policy"];
                    const candidateTitles = value(data, "items")
                      .split("\n")
                      .map((title) => title.trim())
                      .filter(Boolean);
                    void onEditPool(pool, {
                      title: value(data, "title"),
                      policy,
                      pickCount: Number(value(data, "pickCount")),
                      cooldownSeconds:
                        policy === "cooldown"
                          ? Number(value(data, "cooldownDays")) * 86_400
                          : null,
                      items: candidateTitles.map((title) => {
                        const existing = items.find(
                          (item) =>
                            item.poolId === pool.id && item.title === title,
                        );
                        return existing === undefined
                          ? { title }
                          : { id: existing.id, title };
                      }),
                    });
                  }}
                >
                  <label className="field">
                    <span>Name</span>
                    <input name="title" defaultValue={pool.title} required />
                  </label>
                  <label className="field">
                    <span>Policy</span>
                    <select name="policy" defaultValue={pool.policy}>
                      <option value="none">Always eligible</option>
                      <option value="cooldown">Cooldown</option>
                      <option value="cycle">Cycle</option>
                      <option value="one_shot">One shot</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Pick count</span>
                    <input
                      name="pickCount"
                      type="number"
                      min="1"
                      max="25"
                      defaultValue={pool.pickCount}
                    />
                  </label>
                  <label className="field">
                    <span>Cooldown days</span>
                    <input
                      name="cooldownDays"
                      type="number"
                      min="1"
                      max="365"
                      defaultValue={Math.max(
                        1,
                        Math.round((pool.cooldownSeconds ?? 432000) / 86400),
                      )}
                    />
                  </label>
                  <label className="field">
                    <span>Candidates, one per line</span>
                    <textarea
                      name="items"
                      rows={5}
                      defaultValue={items
                        .filter(
                          ({ poolId, archivedAt }) =>
                            poolId === pool.id && archivedAt === null,
                        )
                        .map(({ title }) => title)
                        .join("\n")}
                    />
                  </label>
                  <button disabled={busy}>Save pool</button>
                </form>
              </details>
            </li>
          ))}
        </ul>
      )}
      <form
        className="placeholder-create"
        onSubmit={(event) => void createPlaceholder(event)}
      >
        <h4>Create a Planning Placeholder</h4>
        <label className="field">
          <span>Parent task</span>
          <select name="taskId" required defaultValue="">
            <option value="" disabled>
              Select a task
            </option>
            {tasks
              .filter(({ status }) => status === "open")
              .map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Choice Pool</span>
          <select name="poolId" required defaultValue="">
            <option value="" disabled>
              Select a pool
            </option>
            {pools
              .filter(({ archivedAt }) => archivedAt === null)
              .map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.title}
                </option>
              ))}
          </select>
        </label>
        <button disabled={busy || pools.length === 0 || tasks.length === 0}>
          Reserve placeholder
        </button>
      </form>
      <form
        className="placeholder-create"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const templateId = value(data, "templateId");
          const existingSlots = poolSlots.filter(
            (slot) => slot.templateId === templateId,
          );
          void onCreateTemplateSlot(
            templateId,
            value(data, "poolId"),
            Number(value(data, "pickCount")),
            existingSlots.length,
          );
        }}
      >
        <h4>Add a Choice Pool slot to a Task Template</h4>
        <label className="field">
          <span>Template</span>
          <select name="templateId" required defaultValue="">
            <option value="" disabled>
              Select a template
            </option>
            {templates
              .filter(({ archivedAt }) => archivedAt === null)
              .map((template) => (
                <option key={template.id} value={template.id}>
                  {template.title}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Choice Pool</span>
          <select name="poolId" required defaultValue="">
            <option value="" disabled>
              Select a pool
            </option>
            {pools
              .filter(({ archivedAt }) => archivedAt === null)
              .map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.title}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Pick count</span>
          <input
            name="pickCount"
            type="number"
            min="1"
            max="25"
            defaultValue="1"
            required
          />
        </label>
        <button disabled={busy || templates.length === 0 || pools.length === 0}>
          Add template slot
        </button>
      </form>
      <div className="placeholders">
        {placeholders.map((placeholder) => {
          const suggestion = suggestions[placeholder.id];
          const selectedIds = selected[placeholder.id] ?? [];
          const poolItems = items.filter(
            ({ poolId }) => poolId === placeholder.poolId,
          );
          return (
            <article key={placeholder.id}>
              <h4>
                {tasks.find(({ id }) => id === placeholder.taskId)?.title ??
                  "Planning task"}
              </h4>
              <p className="hint">
                {placeholder.state === "resolved"
                  ? "Resolved into concrete subtasks"
                  : `Unresolved · choose ${String(placeholder.pickCount)}`}
              </p>
              {placeholder.state === "resolved" &&
                history
                  .filter(
                    ({ placeholderId, kind }) =>
                      placeholderId === placeholder.id && kind === "selected",
                  )
                  .map((event) => {
                    const completed = history.some(
                      ({ placeholderId, itemId, kind }) =>
                        placeholderId === placeholder.id &&
                        itemId === event.itemId &&
                        kind === "completed",
                    );
                    return (
                      <button
                        key={event.id}
                        type="button"
                        disabled={busy || completed}
                        onClick={() =>
                          void onRecordCompletion(
                            event.poolId,
                            event.itemId,
                            placeholder.id,
                          )
                        }
                      >
                        {completed
                          ? "Completion recorded"
                          : `Record completion: ${items.find(({ id }) => id === event.itemId)?.title ?? "item"}`}
                      </button>
                    );
                  })}
              {placeholder.state === "unresolved" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void preview(placeholder.id)}
                >
                  Preview eligible choices
                </button>
              )}
              {suggestion !== undefined &&
                placeholder.state === "unresolved" && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void onResolve(
                        placeholder,
                        suggestion,
                        selectedIds,
                        new FormData(event.currentTarget).get("override") ===
                          "on",
                      );
                    }}
                  >
                    <fieldset>
                      <legend>Select exactly {placeholder.pickCount}</legend>
                      {poolItems.map((item) => {
                        const eligibility = suggestion.eligibility.find(
                          ({ itemId }) => itemId === item.id,
                        );
                        return (
                          <label key={item.id} className="pool-choice">
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(item.id)}
                              onChange={(event) =>
                                setSelected((current) => ({
                                  ...current,
                                  [placeholder.id]: event.currentTarget.checked
                                    ? [...selectedIds, item.id]
                                    : selectedIds.filter(
                                        (id) => id !== item.id,
                                      ),
                                }))
                              }
                            />
                            <span>{item.title}</span>
                            <small>
                              {reasonText[eligibility?.reason ?? "archived"]}
                              {eligibility?.eligibleAt == null
                                ? ""
                                : ` until ${new Date(eligibility.eligibleAt).toLocaleString()}`}
                            </small>
                          </label>
                        );
                      })}
                    </fieldset>
                    <label className="pool-choice">
                      <input name="override" type="checkbox" />
                      <span>Override policy and record the bypass</span>
                    </label>
                    <button
                      disabled={
                        busy || selectedIds.length !== placeholder.pickCount
                      }
                    >
                      Confirm resolution
                    </button>
                  </form>
                )}
            </article>
          );
        })}
      </div>
    </section>
  );
};
