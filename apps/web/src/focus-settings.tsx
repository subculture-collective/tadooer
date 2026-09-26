import { useState, type SyntheticEvent } from "react";
import {
  focusPreferencesSchema,
  type FocusPreferences,
  type FocusPreferencesResponse,
} from "@suite/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionHeading } from "@/components/ui/section-heading";
import { Textarea } from "@/components/ui/textarea";

export interface FocusSettingsProps {
  readonly record: FocusPreferencesResponse;
  readonly busy: boolean;
  readonly online: boolean;
  readonly message: string | null;
  readonly onSave: (preferences: FocusPreferences) => Promise<void>;
}

const text = (data: FormData, name: string, fallback: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : fallback;
};

const number = (data: FormData, name: string, fallback: number): number => {
  const value = Number(data.get(name));
  return Number.isFinite(value) ? Math.round(value) : fallback;
};

/** Reads the form into a preference record; invalid input keeps the saved value. */
export const readFocusSettingsForm = (
  data: FormData,
  current: FocusPreferences,
): FocusPreferences => {
  const mode = data.get("defaultMode");
  const breakMode = data.get("flowtimeBreakMode");
  const candidate: FocusPreferences = {
    defaultMode:
      mode === "pomodoro" || mode === "flowtime" || mode === "countdown"
        ? mode
        : current.defaultMode,
    pomodoro: {
      workMinutes: number(data, "workMinutes", current.pomodoro.workMinutes),
      shortBreakMinutes: number(
        data,
        "shortBreakMinutes",
        current.pomodoro.shortBreakMinutes,
      ),
      longBreakMinutes: number(
        data,
        "longBreakMinutes",
        current.pomodoro.longBreakMinutes,
      ),
      cyclesBeforeLongBreak: number(
        data,
        "cyclesBeforeLongBreak",
        current.pomodoro.cyclesBeforeLongBreak,
      ),
    },
    flowtime: {
      breakEnabled: data.has("flowtimeBreakEnabled"),
      breakMode:
        breakMode === "ratio" || breakMode === "rule"
          ? breakMode
          : current.flowtime.breakMode,
      breakPercentage: number(
        data,
        "breakPercentage",
        current.flowtime.breakPercentage,
      ),
      // Rules are edited only through the assistant or import for now.
      breakRules: current.flowtime.breakRules,
    },
    countdownMinutes: number(
      data,
      "countdownMinutes",
      current.countdownMinutes,
    ),
    autoStartFocusOnTracking: data.has("autoStartFocusOnTracking"),
    breakEndAlarm: data.has("breakEndAlarm"),
    idle: {
      enabled: data.has("idleEnabled"),
      minIdleMinutes: number(
        data,
        "minIdleMinutes",
        current.idle.minIdleMinutes,
      ),
      onlyWithTask: data.has("idleOnlyWithTask"),
      suppressInFocus: data.has("idleSuppressInFocus"),
    },
    takeABreak: {
      enabled: data.has("takeABreakEnabled"),
      minWorkingMinutes: number(
        data,
        "minWorkingMinutes",
        current.takeABreak.minWorkingMinutes,
      ),
      snoozeMinutes: number(
        data,
        "snoozeMinutes",
        current.takeABreak.snoozeMinutes,
      ),
      message: text(data, "takeABreakMessage", current.takeABreak.message),
    },
    trackingReminder: {
      enabled: data.has("trackingReminderEnabled"),
      minMinutes: number(
        data,
        "trackingReminderMinutes",
        current.trackingReminder.minMinutes,
      ),
    },
  };
  const parsed = focusPreferencesSchema.safeParse(candidate);
  return parsed.success ? parsed.data : current;
};

const Minutes = ({
  id,
  name,
  label,
  value,
  max,
}: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly value: number;
  readonly max: number;
}) => (
  <Field>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <Input
      id={id}
      name={name}
      type="number"
      inputMode="numeric"
      min={1}
      max={max}
      step={1}
      defaultValue={value}
      required
    />
  </Field>
);

const Toggle = ({
  id,
  name,
  label,
  checked,
}: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly checked: boolean;
}) => (
  <Field className="flex-row items-center gap-2">
    <Checkbox id={id} name={name} defaultChecked={checked} />
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
  </Field>
);

/** Focus, idle, break and tracking-reminder preferences (ADR 0029). */
export const FocusSettings = ({
  record,
  busy,
  online,
  message,
  onSave,
}: FocusSettingsProps) => {
  const preferences = record.preferences;
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const candidate = readFocusSettingsForm(
      new FormData(event.currentTarget),
      preferences,
    );
    if (!focusPreferencesSchema.safeParse(candidate).success) {
      setInvalid(
        "Check the minutes and cycle counts; each must be a whole number in range.",
      );
      return;
    }
    setInvalid(null);
    void onSave(candidate);
  };
  return (
    <section aria-labelledby="focus-settings-title">
      <SectionHeading
        as="h3"
        eyebrow="Focus and breaks"
        title="Focus preferences"
        id="focus-settings-title"
      />
      <p className="hint">
        Presets apply when a session's plan is set; a running plan keeps the
        values it started with. Idle detection watches this browser window for
        input and asks you on return; it cannot see other applications.
        {record.imported === null
          ? ""
          : ` Imported from Super Productivity on ${record.imported.importedAt.slice(0, 10)} (${String(record.imported.fields.length)} settings).`}
      </p>
      <form className="notification-preferences grid gap-3" onSubmit={submit}>
        <Field>
          <FieldLabel htmlFor="focus-default-mode">Default preset</FieldLabel>
          <NativeSelect
            id="focus-default-mode"
            name="defaultMode"
            defaultValue={preferences.defaultMode}
          >
            <option value="pomodoro">Pomodoro</option>
            <option value="flowtime">Flowtime</option>
            <option value="countdown">Countdown</option>
          </NativeSelect>
        </Field>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="text-sm font-medium">Pomodoro</legend>
          <Minutes
            id="focus-work"
            name="workMinutes"
            label="Focus minutes"
            value={preferences.pomodoro.workMinutes}
            max={240}
          />
          <Minutes
            id="focus-short-break"
            name="shortBreakMinutes"
            label="Short break minutes"
            value={preferences.pomodoro.shortBreakMinutes}
            max={120}
          />
          <Minutes
            id="focus-long-break"
            name="longBreakMinutes"
            label="Long break minutes"
            value={preferences.pomodoro.longBreakMinutes}
            max={240}
          />
          <Minutes
            id="focus-cycles"
            name="cyclesBeforeLongBreak"
            label="Cycles before a long break"
            value={preferences.pomodoro.cyclesBeforeLongBreak}
            max={12}
          />
        </fieldset>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="text-sm font-medium">Flowtime</legend>
          <Toggle
            id="focus-flowtime-break"
            name="flowtimeBreakEnabled"
            label="Suggest a break after each focus stretch"
            checked={preferences.flowtime.breakEnabled}
          />
          <Field>
            <FieldLabel htmlFor="focus-flowtime-mode">Break length</FieldLabel>
            <NativeSelect
              id="focus-flowtime-mode"
              name="flowtimeBreakMode"
              defaultValue={preferences.flowtime.breakMode}
            >
              <option value="ratio">Share of the focus stretch</option>
              <option value="rule">Rules by stretch length</option>
            </NativeSelect>
            <FieldDescription>
              {preferences.flowtime.breakRules.length === 0
                ? "No rules saved; rules come from an import or the assistant."
                : `${String(preferences.flowtime.breakRules.length)} rule(s) saved.`}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="focus-break-percentage">
              Break share (%)
            </FieldLabel>
            <Input
              id="focus-break-percentage"
              name="breakPercentage"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              step={1}
              defaultValue={preferences.flowtime.breakPercentage}
              required
            />
          </Field>
        </fieldset>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="text-sm font-medium">Countdown and options</legend>
          <Minutes
            id="focus-countdown"
            name="countdownMinutes"
            label="Countdown minutes"
            value={preferences.countdownMinutes}
            max={480}
          />
          <Toggle
            id="focus-auto-start"
            name="autoStartFocusOnTracking"
            label="Apply the default preset when focus starts from a task"
            checked={preferences.autoStartFocusOnTracking}
          />
          <Toggle
            id="focus-break-alarm"
            name="breakEndAlarm"
            label="Play a tone when a break is over"
            checked={preferences.breakEndAlarm}
          />
        </fieldset>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="text-sm font-medium">Idle detection</legend>
          <Toggle
            id="focus-idle"
            name="idleEnabled"
            label="Ask what idle time was when I return"
            checked={preferences.idle.enabled}
          />
          <Minutes
            id="focus-idle-minutes"
            name="minIdleMinutes"
            label="Minutes without input"
            value={preferences.idle.minIdleMinutes}
            max={120}
          />
          <Toggle
            id="focus-idle-task"
            name="idleOnlyWithTask"
            label="Only while a focus session is running"
            checked={preferences.idle.onlyWithTask}
          />
          <Toggle
            id="focus-idle-suppress"
            name="idleSuppressInFocus"
            label="Not during a Pomodoro or countdown"
            checked={preferences.idle.suppressInFocus}
          />
        </fieldset>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="text-sm font-medium">Take a break</legend>
          <Toggle
            id="focus-take-break"
            name="takeABreakEnabled"
            label="Remind me after working without a break"
            checked={preferences.takeABreak.enabled}
          />
          <Minutes
            id="focus-min-working"
            name="minWorkingMinutes"
            label="Minutes of work before the reminder"
            value={preferences.takeABreak.minWorkingMinutes}
            max={720}
          />
          <Minutes
            id="focus-snooze"
            name="snoozeMinutes"
            label="Snooze minutes"
            value={preferences.takeABreak.snoozeMinutes}
            max={120}
          />
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="focus-break-message">Reminder text</FieldLabel>
            <Textarea
              id="focus-break-message"
              name="takeABreakMessage"
              rows={2}
              maxLength={500}
              defaultValue={preferences.takeABreak.message}
            />
            <FieldDescription>
              {"${duration}"} is replaced with the working time.
            </FieldDescription>
          </Field>
        </fieldset>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="text-sm font-medium">Tracking reminder</legend>
          <Toggle
            id="focus-tracking"
            name="trackingReminderEnabled"
            label="Remind me when nothing is tracked during working hours"
            checked={preferences.trackingReminder.enabled}
          />
          <Minutes
            id="focus-tracking-minutes"
            name="trackingReminderMinutes"
            label="Minutes without tracking"
            value={preferences.trackingReminder.minMinutes}
            max={240}
          />
        </fieldset>
        {invalid === null ? null : (
          <p className="message message-error" role="alert">
            {invalid}
          </p>
        )}
        {message === null ? null : (
          <p className="hint" role="status">
            {message}
          </p>
        )}
        <Button disabled={busy || !online}>Save focus preferences</Button>
      </form>
    </section>
  );
};
