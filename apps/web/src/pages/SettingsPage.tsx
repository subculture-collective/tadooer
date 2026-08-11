import type {
  DayPlanResponse,
  GoogleConnectorStatusResponse,
  NotificationPreferences,
  NotificationStatusResponse,
  PlanningPreferences,
} from "@suite/contracts";
import { GooglePlanning } from "../google-planning.tsx";
import { NotificationSettings } from "../notification-settings.tsx";

export interface SettingsPageProps {
  readonly google: GoogleConnectorStatusResponse | undefined;
  readonly planningPreferences: PlanningPreferences | undefined;
  readonly dayPlan: DayPlanResponse | undefined;
  readonly notificationPreferences: NotificationPreferences | undefined;
  readonly notificationStatus: NotificationStatusResponse | undefined;
  readonly syncStatus: "online" | "offline" | "syncing" | undefined;
  readonly clientId: string | null;
  readonly plannerFreshness: string | undefined;
  readonly busy: boolean;
  readonly onAuthorizeGoogle: (() => Promise<string>) | undefined;
  readonly onSyncGoogle: (() => Promise<void>) | undefined;
  readonly onDisconnectGoogle: (() => Promise<void>) | undefined;
  readonly onSavePlanningPreferences:
    | ((preferences: PlanningPreferences) => Promise<void>)
    | undefined;
  readonly onSaveNotificationPreferences:
    | ((preferences: NotificationPreferences) => Promise<void>)
    | undefined;
  readonly onTestNotification: (() => Promise<void>) | undefined;
  readonly onSyncNow: () => Promise<void>;
  readonly onExportDiagnostics: () => Promise<void>;
}

export const SettingsPage = ({
  google,
  planningPreferences,
  dayPlan,
  notificationPreferences,
  notificationStatus,
  syncStatus,
  clientId,
  plannerFreshness,
  busy,
  onAuthorizeGoogle,
  onSyncGoogle,
  onDisconnectGoogle,
  onSavePlanningPreferences,
  onSaveNotificationPreferences,
  onTestNotification,
  onSyncNow,
  onExportDiagnostics,
}: SettingsPageProps) => {
  return (
    <>
      {google !== undefined &&
        planningPreferences !== undefined &&
        dayPlan !== undefined &&
        onAuthorizeGoogle !== undefined &&
        onSyncGoogle !== undefined &&
        onDisconnectGoogle !== undefined &&
        onSavePlanningPreferences !== undefined && (
          <GooglePlanning
            mode="preferences"
            status={google}
            preferences={planningPreferences}
            dayPlan={dayPlan}
            busy={busy}
            onAuthorize={onAuthorizeGoogle}
            onSynchronize={onSyncGoogle}
            onDisconnect={onDisconnectGoogle}
            onSavePreferences={onSavePlanningPreferences}
          />
        )}
      {notificationPreferences !== undefined &&
        notificationStatus !== undefined &&
        onSaveNotificationPreferences !== undefined &&
        onTestNotification !== undefined && (
          <NotificationSettings
            preferences={notificationPreferences}
            status={notificationStatus}
            busy={busy}
            online={syncStatus === "online"}
            onSave={onSaveNotificationPreferences}
            onTest={onTestNotification}
          />
        )}
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={() => void onSyncNow()}
      >
        Sync now
      </button>
      <section aria-labelledby="settings-health-title">
        <h3 id="settings-health-title">Client and service health</h3>
        <dl className="settings-health">
          <div>
            <dt>Task sync</dt>
            <dd>{syncStatus ?? "offline"}</dd>
          </div>
          <div>
            <dt>Client</dt>
            <dd>{clientId ?? "Not registered"}</dd>
          </div>
          <div>
            <dt>Calendar freshness</dt>
            <dd>{plannerFreshness ?? "unavailable"}</dd>
          </div>
        </dl>
        <p className="hint">
          Automation credentials remain separately scoped and revocable;
          connector secrets are never returned to this page.
        </p>
        <button
          type="button"
          className="text-button"
          onClick={() => void onExportDiagnostics()}
        >
          Export redacted sync diagnostics
        </button>
      </section>
    </>
  );
};
