import { useMemo, useState, type SyntheticEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionHeading } from "@/components/ui/section-heading";
import { Textarea } from "@/components/ui/textarea";

export interface TemplateView {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly estimateMinutes: number | null;
  readonly suggestedProjectId: string | null;
  readonly tagIds: readonly string[];
  readonly revision: number;
  readonly archivedAt: string | null;
}

export interface TemplateBlueprintView {
  readonly id: string;
  readonly templateId: string;
  readonly title: string;
  readonly position: number;
}

export interface TemplateSetView {
  readonly id: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly templateIds: readonly string[];
}

export interface ProjectOption {
  readonly id: string;
  readonly title: string;
}
export interface TagOption {
  readonly id: string;
  readonly displayName: string;
}

export interface TemplateLibraryProps {
  readonly templates: readonly TemplateView[];
  readonly blueprints: readonly TemplateBlueprintView[];
  readonly sets: readonly TemplateSetView[];
  readonly projects: readonly ProjectOption[];
  readonly tags: readonly TagOption[];
  readonly busy: boolean;
  readonly onCreate: (draft: {
    title: string;
    notes: string;
    estimateMinutes: number | null;
    suggestedProjectId: string | null;
    tagIds: readonly string[];
    subtasks: readonly { title: string }[];
  }) => Promise<void>;
  readonly onSearch: (query: string) => void;
  readonly onArchive: (template: TemplateView) => Promise<void>;
  readonly onEdit: (
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
  readonly onCreateSet: (
    title: string,
    templateIds: readonly string[],
  ) => Promise<void>;
  readonly onInstantiate: (
    templateId: string,
    projectId: string,
  ) => Promise<void>;
  readonly onInstantiateSet: (
    setId: string,
    projectId: string,
  ) => Promise<void>;
}

const formText = (form: HTMLFormElement, field: string): string => {
  const value = new FormData(form).get(field);
  return typeof value === "string" ? value : "";
};

export const TemplateLibrary = ({
  templates,
  blueprints,
  sets,
  projects,
  tags,
  busy,
  onCreate,
  onSearch,
  onArchive,
  onEdit,
  onCreateSet,
  onInstantiate,
  onInstantiateSet,
}: TemplateLibraryProps) => {
  const [query, setQuery] = useState("");
  const [destination, setDestination] = useState<Record<string, string>>({});
  const blueprintFor = useMemo(
    () =>
      new Map(
        templates.map((template) => [
          template.id,
          blueprints
            .filter((blueprint) => blueprint.templateId === template.id)
            .sort((left, right) => left.position - right.position),
        ]),
      ),
    [blueprints, templates],
  );
  const submitCreate = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const estimate = Number(formText(form, "estimateMinutes"));
    const subtasks = formText(form, "subtasks")
      .split("\n")
      .map((title) => title.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
    await onCreate({
      title: formText(form, "title"),
      notes: formText(form, "notes"),
      estimateMinutes:
        Number.isInteger(estimate) && estimate > 0 ? estimate : null,
      suggestedProjectId: formText(form, "suggestedProjectId") || null,
      tagIds: new FormData(form)
        .getAll("tagIds")
        .filter((value): value is string => typeof value === "string"),
      subtasks,
    });
    form.reset();
  };
  const submitSearch = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch(query);
  };
  const submitSet = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    await onCreateSet(
      formText(form, "title"),
      new FormData(form)
        .getAll("templateIds")
        .filter((value): value is string => typeof value === "string"),
    );
    form.reset();
  };
  const submitEdit = async (
    event: SyntheticEvent<HTMLFormElement>,
    template: TemplateView,
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    const estimate = Number(formText(form, "estimateMinutes"));
    const subtasks = formText(form, "subtasks")
      .split("\n")
      .map((title) => title.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
    await onEdit(template, {
      title: formText(form, "title"),
      notes: formText(form, "notes"),
      estimateMinutes:
        Number.isInteger(estimate) && estimate > 0 ? estimate : null,
      suggestedProjectId: formText(form, "suggestedProjectId") || null,
      tagIds: new FormData(form)
        .getAll("tagIds")
        .filter((value): value is string => typeof value === "string"),
      subtasks,
    });
  };
  const chooseDestination = (id: string, projectId: string) =>
    setDestination((current) => ({ ...current, [id]: projectId }));
  const destinationSelect = (
    id: string,
    suggestedProjectId?: string | null,
  ) => (
    <label className="field compact-field">
      <span>Existing destination project</span>
      <NativeSelect
        required
        value={destination[id] ?? suggestedProjectId ?? ""}
        onChange={(event) => chooseDestination(id, event.currentTarget.value)}
      >
        <option value="" disabled>
          Choose a project
        </option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.title}
          </option>
        ))}
      </NativeSelect>
    </label>
  );

  return (
    <section
      className="template-library"
      aria-labelledby="template-library-title"
    >
      <SectionHeading
        as="h3"
        eyebrow="Reusable work"
        title="Template Library"
        id="template-library-title"
        actions={
          <form
            className="template-search"
            role="search"
            onSubmit={submitSearch}
          >
            <label>
              <span className="sr-only">Search templates</span>
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search templates"
              />
            </label>
            <Button type="submit" variant="ghost" disabled={busy}>
              Search
            </Button>
          </form>
        }
      />
      <p className="hint" id="template-library-note">
        Templates are inert blueprints. They do not appear in active tasks,
        reminders, or focus tracking.
      </p>
      <form
        className="template-create"
        onSubmit={(event) => void submitCreate(event)}
        aria-describedby="template-library-note"
      >
        <h4>New template</h4>
        <label className="field">
          <span>Template title</span>
          <Input name="title" required autoComplete="off" />
        </label>
        <label className="field">
          <span>Notes</span>
          <Input name="notes" autoComplete="off" />
        </label>
        <label className="field">
          <span>Estimate minutes</span>
          <Input name="estimateMinutes" type="number" min="1" max="720" />
        </label>
        <label className="field">
          <span>Suggested project</span>
          <NativeSelect name="suggestedProjectId">
            <option value="">No suggestion</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </NativeSelect>
        </label>
        {tags.length > 0 && (
          <fieldset>
            <legend>Tags</legend>
            {tags.map((tag) => (
              <label key={tag.id}>
                <Checkbox name="tagIds" value={tag.id} /> {tag.displayName}
              </label>
            ))}
          </fieldset>
        )}
        <label className="field">
          <span>Checklist blueprints (one per line)</span>
          <Textarea name="subtasks" rows={3} />
        </label>
        <Button disabled={busy}>{busy ? "Saving…" : "Save template"}</Button>
      </form>
      {templates.length === 0 ? (
        <EmptyState title="No templates match this library yet." />
      ) : (
        <ul className="template-list">
          {templates.map((template) => {
            const items = blueprintFor.get(template.id) ?? [];
            const selected =
              destination[template.id] ?? template.suggestedProjectId ?? "";
            return (
              <Card key={template.id} className="template-card">
                <CardContent>
                  <div className="task-heading">
                    <strong>{template.title}</strong>
                    <small>
                      {template.estimateMinutes == null
                        ? "No estimate"
                        : `${String(template.estimateMinutes)} minutes`}{" "}
                      · {items.length} checklist{" "}
                      {items.length === 1 ? "item" : "items"}
                    </small>
                  </div>
                  {template.notes && <p>{template.notes}</p>}
                  {items.length > 0 && (
                    <ol className="template-blueprints">
                      {items.map((item) => (
                        <li key={item.id}>{item.title}</li>
                      ))}
                    </ol>
                  )}
                  <Collapsible className="template-edit">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" type="button">
                        Edit template
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <form
                        onSubmit={(event) => void submitEdit(event, template)}
                      >
                        <label className="field">
                          <span>Title</span>
                          <Input
                            name="title"
                            required
                            defaultValue={template.title}
                          />
                        </label>
                        <label className="field">
                          <span>Notes</span>
                          <Input name="notes" defaultValue={template.notes} />
                        </label>
                        <label className="field">
                          <span>Estimate minutes</span>
                          <Input
                            name="estimateMinutes"
                            type="number"
                            min="1"
                            max="720"
                            defaultValue={template.estimateMinutes ?? ""}
                          />
                        </label>
                        <label className="field">
                          <span>Suggested project</span>
                          <NativeSelect
                            name="suggestedProjectId"
                            defaultValue={template.suggestedProjectId ?? ""}
                          >
                            <option value="">No suggestion</option>
                            {projects.map((project) => (
                              <option key={project.id} value={project.id}>
                                {project.title}
                              </option>
                            ))}
                          </NativeSelect>
                        </label>
                        {tags.length > 0 && (
                          <fieldset>
                            <legend>Tags</legend>
                            {tags.map((tag) => (
                              <label key={tag.id}>
                                <Checkbox
                                  name="tagIds"
                                  value={tag.id}
                                  defaultChecked={template.tagIds.includes(
                                    tag.id,
                                  )}
                                />{" "}
                                {tag.displayName}
                              </label>
                            ))}
                          </fieldset>
                        )}
                        <label className="field">
                          <span>Checklist blueprints (one per line)</span>
                          <Textarea
                            name="subtasks"
                            rows={3}
                            defaultValue={items
                              .map(({ title }) => title)
                              .join("\n")}
                          />
                        </label>
                        <Button disabled={busy}>Save template</Button>
                      </form>
                    </CollapsibleContent>
                  </Collapsible>
                  <div className="template-destination">
                    {destinationSelect(
                      template.id,
                      template.suggestedProjectId,
                    )}
                    <Button
                      type="button"
                      disabled={busy || !selected}
                      onClick={() => void onInstantiate(template.id, selected)}
                    >
                      Create task
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void onArchive(template)}
                    >
                      Archive template
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </ul>
      )}
      <section className="template-sets" aria-labelledby="template-set-title">
        <h4 id="template-set-title">Template Sets</h4>
        <p className="hint">
          Create every member as independent work in one existing project.
        </p>
        <form
          className="template-set-create"
          onSubmit={(event) => void submitSet(event)}
        >
          <label className="field">
            <span>Set name</span>
            <Input name="title" required autoComplete="off" />
          </label>
          <fieldset>
            <legend>Templates in this set</legend>
            {templates
              .filter((template) => template.archivedAt === null)
              .map((template) => (
                <label key={template.id}>
                  <Checkbox name="templateIds" value={template.id} />{" "}
                  {template.title}
                </label>
              ))}
          </fieldset>
          <Button disabled={busy || templates.length === 0}>Save set</Button>
        </form>
        {sets.length === 0 ? (
          <EmptyState title="No reusable sets yet." />
        ) : (
          <ul className="template-list">
            {sets
              .filter((set) => set.archivedAt === null)
              .map((set) => {
                const selected = destination[set.id] ?? "";
                return (
                  <Card key={set.id} className="template-card">
                    <CardContent>
                      <strong>{set.title}</strong>
                      <ol className="template-blueprints">
                        {set.templateIds.map((templateId) => (
                          <li key={templateId}>
                            {templates.find(({ id }) => id === templateId)
                              ?.title ?? "Archived template"}
                          </li>
                        ))}
                      </ol>
                      <div className="template-destination">
                        {destinationSelect(set.id)}
                        <Button
                          type="button"
                          disabled={busy || !selected}
                          onClick={() =>
                            void onInstantiateSet(set.id, selected)
                          }
                        >
                          Create set
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
          </ul>
        )}
      </section>
    </section>
  );
};
