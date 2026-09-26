import { useEffect, useState, type SyntheticEvent } from "react";
import {
  applicationStartPages,
  normalizeShortcutBinding,
  resolveShortcutBindings,
  shortcutActions,
  shortcutConflicts,
  taskReminderOffsetMinutes,
  type ApplicationPreferences,
  type Project,
  type ShortcutActionId,
  type ShortcutOverrides,
} from "@suite/contracts";
import { Button } from "../ui/button.tsx";
import { Card, CardContent, CardHeader } from "../ui/card.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Field, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { NativeSelect } from "../ui/native-select.tsx";
import { SectionHeading } from "../ui/section-heading.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { formatBinding, shortcutGroups } from "../../shortcuts.ts";

export interface ApplicationPreferencesSettingsProps {
  readonly preferences: ApplicationPreferences;
  readonly revision: number;
  readonly projects: readonly Project[];
  readonly busy: boolean;
  readonly online: boolean;
  readonly error: string | null;
  readonly onSave: (preferences: ApplicationPreferences) => Promise<boolean>;
}

const startPageLabel: Readonly<
  Record<(typeof applicationStartPages)[number], string>
> = {
  today: "Today",
  inbox: "Inbox",
  planner: "Planner",
  tasks: "Tasks",
  history: "History",
  worklog: "Worklog",
  counters: "Counters",
  reuse: "Reuse",
  habits: "Habits",
  connections: "Connections",
  settings: "Settings",
};

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const reminderValue = (
  reminder: ApplicationPreferences["defaultTaskReminder"],
): string =>
  reminder.kind === "before_start" ? String(reminder.minutes) : reminder.kind;

const reminderFrom = (
  value: string,
): ApplicationPreferences["defaultTaskReminder"] => {
  if (value === "default" || value === "none") return { kind: value };
  const minutes = Number(value);
  const offset = taskReminderOffsetMinutes.find((m) => m === minutes);
  return offset === undefined
    ? { kind: "default" }
    : { kind: "before_start", minutes: offset };
};

const minutesFrom = (value: FormDataEntryValue | null): number | null => {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 720
    ? minutes
    : null;
};

/**
 * Settings section for the application preferences record (ADR 0030). The
 * form posts the whole record with the revision it was rendered from; the
 * shortcut editor validates bindings and conflicts before a save.
 */
export const ApplicationPreferencesSettings = ({
  preferences,
  revision,
  projects,
  busy,
  online,
  error,
  onSave,
}: ApplicationPreferencesSettingsProps) => {
  const [overrides, setOverrides] = useState<ShortcutOverrides>(
    preferences.shortcuts,
  );
  const [bindingErrors, setBindingErrors] = useState<
    Partial<Record<ShortcutActionId, string>>
  >({});
  useEffect(() => {
    setOverrides(preferences.shortcuts);
    setBindingErrors({});
  }, [preferences.shortcuts, revision]);
  const conflicts = shortcutConflicts(overrides);
  const effective = resolveShortcutBindings(overrides);
  const invalid =
    conflicts.length > 0 || Object.values(bindingErrors).some(Boolean);

  const editBinding = (id: ShortcutActionId, raw: string): void => {
    const action = shortcutActions.find((candidate) => candidate.id === id);
    const trimmed = raw.trim();
    if (trimmed === "") {
      setOverrides((current) => ({ ...current, [id]: null }));
      setBindingErrors((current) => ({ ...current, [id]: undefined }));
      return;
    }
    const normalized = normalizeShortcutBinding(trimmed);
    if (normalized === undefined) {
      setBindingErrors((current) => ({
        ...current,
        [id]: "Use modifiers (Ctrl, Alt, Shift) plus one key",
      }));
      return;
    }
    setBindingErrors((current) => ({ ...current, [id]: undefined }));
    setOverrides((current) =>
      normalized === action?.defaultBinding
        ? Object.fromEntries(
            Object.entries(current).filter(([key]) => key !== id),
          )
        : { ...current, [id]: normalized },
    );
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (invalid) return;
    const data = new FormData(event.currentTarget);
    const text = (name: string): string => {
      const value = data.get(name);
      return typeof value === "string" ? value : "";
    };
    const startPage = applicationStartPages.find(
      (page) => page === text("defaultStartPage"),
    );
    const firstDayOfWeek = Number(text("firstDayOfWeek"));
    const hour = Number(text("dueDateNotificationHour"));
    void onSave({
      theme:
        text("theme") === "light" || text("theme") === "system"
          ? (text("theme") as "light" | "system")
          : "dark",
      language: preferences.language,
      dateTimeLocale:
        text("dateTimeLocale").trim() || preferences.dateTimeLocale,
      firstDayOfWeek:
        Number.isInteger(firstDayOfWeek) &&
        firstDayOfWeek >= 0 &&
        firstDayOfWeek <= 6
          ? firstDayOfWeek
          : preferences.firstDayOfWeek,
      defaultStartPage: startPage ?? preferences.defaultStartPage,
      defaultProjectId:
        text("defaultProjectId") === "" ? null : text("defaultProjectId"),
      confirmBeforeDelete: data.has("confirmBeforeDelete"),
      markdownInNotes: data.has("markdownInNotes"),
      autoMarkParentDone: data.has("autoMarkParentDone"),
      autoAddWorkedOnToToday: data.has("autoAddWorkedOnToToday"),
      defaultEstimateMinutes: minutesFrom(data.get("defaultEstimateMinutes")),
      defaultChildEstimateMinutes: minutesFrom(
        data.get("defaultChildEstimateMinutes"),
      ),
      notifyWhenEstimateExceeded: data.has("notifyWhenEstimateExceeded"),
      defaultTaskReminder: reminderFrom(text("defaultTaskReminder")),
      notifyOnDueDate: data.has("notifyOnDueDate"),
      dueDateNotificationHour:
        Number.isInteger(hour) && hour >= 0 && hour <= 23
          ? hour
          : preferences.dueDateNotificationHour,
      dailySummaryNote: text("dailySummaryNote").slice(0, 10_000),
      shortcuts: overrides,
    });
  };

  return (
    <Card aria-labelledby="application-preferences-title">
      <CardHeader>
        <SectionHeading
          as="h3"
          id="application-preferences-title"
          eyebrow={`Revision ${String(revision)}`}
          title="Application preferences"
        />
      </CardHeader>
      <CardContent>
        <form
          key={revision}
          className="application-preferences grid gap-4"
          onSubmit={submit}
        >
          {error !== null && (
            <p className="message message-error" role="alert">
              {error}
            </p>
          )}
          <fieldset className="grid gap-3">
            <legend>Appearance and locale</legend>
            <label className="field">
              <span>Theme</span>
              <NativeSelect name="theme" defaultValue={preferences.theme}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">Follow the device</option>
              </NativeSelect>
            </label>
            <label className="field">
              <span>Language</span>
              <NativeSelect name="language" defaultValue="en" disabled>
                <option value="en">
                  English
                  {preferences.language === "en"
                    ? ""
                    : ` (imported preference: ${preferences.language}; only English is available)`}
                </option>
              </NativeSelect>
            </label>
            <label className="field">
              <span>Date and time locale</span>
              <Input
                name="dateTimeLocale"
                defaultValue={preferences.dateTimeLocale}
                placeholder="en-US"
                pattern="[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*"
              />
            </label>
            <label className="field">
              <span>First day of the week</span>
              <NativeSelect
                name="firstDayOfWeek"
                defaultValue={String(preferences.firstDayOfWeek)}
              >
                {weekdays.map((day, index) => (
                  <option key={day} value={String(index)}>
                    {day}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="field">
              <span>Open first</span>
              <NativeSelect
                name="defaultStartPage"
                defaultValue={preferences.defaultStartPage}
              >
                {applicationStartPages.map((page) => (
                  <option key={page} value={page}>
                    {startPageLabel[page]}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </fieldset>
          <fieldset className="grid gap-3">
            <legend>Tasks</legend>
            <label className="field">
              <span>Default project for new tasks</span>
              <NativeSelect
                name="defaultProjectId"
                defaultValue={preferences.defaultProjectId ?? ""}
              >
                <option value="">No project</option>
                {projects
                  .filter((project) => project.archivedAt === null)
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            <label className="field">
              <span>Default estimate (minutes)</span>
              <Input
                name="defaultEstimateMinutes"
                type="number"
                min="1"
                max="720"
                defaultValue={preferences.defaultEstimateMinutes ?? ""}
              />
            </label>
            <label className="field">
              <span>Default estimate for child tasks (minutes)</span>
              <Input
                name="defaultChildEstimateMinutes"
                type="number"
                min="1"
                max="720"
                defaultValue={preferences.defaultChildEstimateMinutes ?? ""}
              />
            </label>
            {(
              [
                ["confirmBeforeDelete", "Ask before deleting a task"],
                ["markdownInNotes", "Render task notes as Markdown"],
                [
                  "autoMarkParentDone",
                  "Complete a parent when its last open child is completed",
                ],
                [
                  "autoAddWorkedOnToToday",
                  "Plan a task for today when focus starts on it",
                ],
                [
                  "notifyWhenEstimateExceeded",
                  "Show a notice when focus time exceeds the estimate",
                ],
              ] as const
            ).map(([name, label]) => (
              <Field key={name} className="flex-row items-center gap-2">
                <Checkbox
                  id={`application-${name}`}
                  name={name}
                  defaultChecked={preferences[name]}
                />
                <FieldLabel htmlFor={`application-${name}`}>{label}</FieldLabel>
              </Field>
            ))}
          </fieldset>
          <fieldset className="grid gap-3">
            <legend>Reminders</legend>
            <label className="field">
              <span>Default reminder for tasks with a start time</span>
              <NativeSelect
                name="defaultTaskReminder"
                defaultValue={reminderValue(preferences.defaultTaskReminder)}
              >
                <option value="default">Follow notification settings</option>
                <option value="none">No reminder</option>
                {taskReminderOffsetMinutes.map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    {minutes === 0
                      ? "At start"
                      : `${String(minutes)} minutes before`}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Field className="flex-row items-center gap-2">
              <Checkbox
                id="application-notifyOnDueDate"
                name="notifyOnDueDate"
                defaultChecked={preferences.notifyOnDueDate}
              />
              <FieldLabel htmlFor="application-notifyOnDueDate">
                Remind about date-only tasks (stored; delivery is not built yet)
              </FieldLabel>
            </Field>
            <label className="field">
              <span>Hour for date-only reminders (0–23)</span>
              <Input
                name="dueDateNotificationHour"
                type="number"
                min="0"
                max="23"
                defaultValue={preferences.dueDateNotificationHour}
              />
            </label>
          </fieldset>
          <fieldset className="grid gap-3">
            <legend>Daily summary note</legend>
            <label className="field">
              <span>Shown on Today</span>
              <Textarea
                name="dailySummaryNote"
                rows={3}
                maxLength={10_000}
                defaultValue={preferences.dailySummaryNote}
              />
            </label>
          </fieldset>
          <fieldset className="grid gap-3">
            <legend>Keyboard shortcuts</legend>
            <p className="hint">
              Type a binding such as Ctrl+K, Shift+A or ?. Clear a field to
              unbind the action. Ctrl also matches Command on Apple devices.
            </p>
            {conflicts.length > 0 && (
              <p className="message message-error" role="alert">
                {conflicts
                  .map(
                    (conflict) =>
                      `${formatBinding(conflict.binding)} is bound to ${conflict.actionIds.join(" and ")}`,
                  )
                  .join(". ")}
              </p>
            )}
            {shortcutGroups().map(({ group, actions }) => (
              <div key={group} className="grid gap-2">
                <h4>{group}</h4>
                {actions.map((action) => (
                  <label key={action.id} className="field shortcut-field">
                    <span>{action.label}</span>
                    <Input
                      name={`shortcut:${action.id}`}
                      aria-invalid={bindingErrors[action.id] !== undefined}
                      defaultValue={effective.get(action.id) ?? ""}
                      placeholder={action.defaultBinding ?? "Not bound"}
                      onBlur={(event) =>
                        editBinding(action.id, event.currentTarget.value)
                      }
                    />
                    {bindingErrors[action.id] !== undefined && (
                      <small className="message message-error">
                        {bindingErrors[action.id]}
                      </small>
                    )}
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
          <Button disabled={busy || !online || invalid}>
            Save application preferences
          </Button>
          {!online && (
            <p className="hint">Reconnect to save application preferences.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
};
