import type {
  NotificationPreferences,
  NotificationStatusResponse,
} from "@suite/contracts";
import type { SyntheticEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { SectionHeading } from "@/components/ui/section-heading";

export interface NotificationSettingsProps {
  readonly preferences: NotificationPreferences;
  readonly status: NotificationStatusResponse;
  readonly busy: boolean;
  readonly online: boolean;
  readonly onSave: (preferences: NotificationPreferences) => Promise<void>;
  readonly onTest: () => Promise<void>;
}

export const NotificationSettings = ({
  preferences,
  status,
  busy,
  online,
  onSave,
  onTest,
}: NotificationSettingsProps) => {
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void onSave({
      enabled: data.has("enabled"),
      leadReminderEnabled: data.has("leadReminderEnabled"),
      atStartReminderEnabled: data.has("atStartReminderEnabled"),
      detailedContentEnabled: data.has("detailedContentEnabled"),
    });
  };
  return (
    <section aria-labelledby="notification-settings-title">
      <SectionHeading
        as="h3"
        eyebrow="Private ntfy delivery"
        title="Task reminders"
        id="notification-settings-title"
        actions={
          <span className={`freshness freshness--${status.state}`}>
            {status.state}
          </span>
        }
      />
      <p className="hint">
        Detailed reminders contain only the task title, local scheduled time,
        and a Suite task link. Notes and calendar-event details are excluded.
      </p>
      {!status.configured && (
        <p className="message message-error">
          The private ntfy publisher is not configured on this server.
        </p>
      )}
      <form className="notification-preferences" onSubmit={submit}>
        <Field className="flex-row items-center gap-2">
          <Checkbox
            id="notifications-enabled"
            name="enabled"
            defaultChecked={preferences.enabled}
          />
          <FieldLabel htmlFor="notifications-enabled">
            Enable task reminders
          </FieldLabel>
        </Field>
        <Field className="flex-row items-center gap-2">
          <Checkbox
            id="notifications-lead"
            name="leadReminderEnabled"
            defaultChecked={preferences.leadReminderEnabled}
          />
          <FieldLabel htmlFor="notifications-lead">
            Remind 15 minutes before
          </FieldLabel>
        </Field>
        <Field className="flex-row items-center gap-2">
          <Checkbox
            id="notifications-start"
            name="atStartReminderEnabled"
            defaultChecked={preferences.atStartReminderEnabled}
          />
          <FieldLabel htmlFor="notifications-start">Remind at start</FieldLabel>
        </Field>
        <Field className="flex-row items-center gap-2">
          <Checkbox
            id="notifications-content"
            name="detailedContentEnabled"
            defaultChecked={preferences.detailedContentEnabled}
          />
          <FieldLabel htmlFor="notifications-content">
            Include task title and scheduled context
          </FieldLabel>
        </Field>
        <Button disabled={busy || !online || !status.configured}>
          Save reminder preferences
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy || !online || !status.configured}
          onClick={() => void onTest()}
        >
          Send test reminder
        </Button>
      </form>
      <p className="hint" role="status">
        Pending: {status.pendingCount} · Failed: {status.failedCount}
        {status.lastDelivery === null
          ? " · No delivery recorded"
          : ` · Last ${status.lastDelivery.kind.replaceAll("_", " ")}: ${status.lastDelivery.state}`}
      </p>
    </section>
  );
};
