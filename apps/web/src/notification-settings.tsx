import type {
  NotificationPreferences,
  NotificationStatusResponse,
} from "@suite/contracts";
import type { SyntheticEvent } from "react";

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
      <div className="section-heading">
        <div>
          <p className="step">Private ntfy delivery</p>
          <h3 id="notification-settings-title">Task reminders</h3>
        </div>
        <span className={`freshness freshness--${status.state}`}>
          {status.state}
        </span>
      </div>
      <p className="hint">
        Detailed reminders contain only the task title, local scheduled time,
        and a Suite task link. Notes and calendar-event details are excluded.
      </p>
      {!status.configured && (
        <p className="form-error">
          The private ntfy publisher is not configured on this server.
        </p>
      )}
      <form className="notification-preferences" onSubmit={submit}>
        <label>
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={preferences.enabled}
          />
          Enable task reminders
        </label>
        <label>
          <input
            type="checkbox"
            name="leadReminderEnabled"
            defaultChecked={preferences.leadReminderEnabled}
          />
          Remind 15 minutes before
        </label>
        <label>
          <input
            type="checkbox"
            name="atStartReminderEnabled"
            defaultChecked={preferences.atStartReminderEnabled}
          />
          Remind at start
        </label>
        <label>
          <input
            type="checkbox"
            name="detailedContentEnabled"
            defaultChecked={preferences.detailedContentEnabled}
          />
          Include task title and scheduled context
        </label>
        <button disabled={busy || !online || !status.configured}>
          Save reminder preferences
        </button>
        <button
          type="button"
          className="text-button"
          disabled={busy || !online || !status.configured}
          onClick={() => void onTest()}
        >
          Send test reminder
        </button>
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
