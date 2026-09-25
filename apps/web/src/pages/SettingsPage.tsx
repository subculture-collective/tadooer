import type {
  DayPlanResponse,
  GoogleConnectorStatusResponse,
  NotificationPreferences,
  NotificationStatusResponse,
  PlanningPreferences,
  Project,
} from "@suite/contracts";
import type { ApplicationPreferencesState } from "../application-preferences.tsx";
import { ApplicationPreferencesSettings } from "../components/settings/ApplicationPreferencesSettings.tsx";
import { GooglePlanning } from "../google-planning.tsx";
import { NotificationSettings } from "../notification-settings.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import { SectionHeading } from "../components/ui/section-heading.tsx";

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
  readonly onSyncGoogle: ((full?: boolean) => Promise<void>) | undefined;
  readonly onDisconnectGoogle: (() => Promise<void>) | undefined;
  readonly onSavePlanningPreferences:
    ((preferences: PlanningPreferences) => Promise<void>) | undefined;
  readonly onSaveNotificationPreferences:
    ((preferences: NotificationPreferences) => Promise<void>) | undefined;
  readonly onTestNotification: (() => Promise<void>) | undefined;
  readonly onSyncNow: () => Promise<void>;
  readonly onExportDiagnostics: () => Promise<void>;
  /** ADR 0030 application preferences and shortcuts. */
  readonly applicationPreferences?: ApplicationPreferencesState | undefined;
  readonly projects?: readonly Project[] | undefined;
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
  applicationPreferences,
  projects = [],
}: SettingsPageProps) => {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Control planning, notifications, synchronization, and diagnostic data."
      />
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
      {applicationPreferences !== undefined && (
        <ApplicationPreferencesSettings
          preferences={applicationPreferences.snapshot.preferences}
          revision={applicationPreferences.snapshot.revision}
          projects={projects}
          busy={busy}
          online={syncStatus === "online" && applicationPreferences.loaded}
          error={applicationPreferences.error}
          onSave={applicationPreferences.save}
        />
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void onSyncNow()}
      >
        Sync now
      </Button>
      <Card aria-labelledby="settings-health-title">
        <CardHeader>
          <SectionHeading
            as="h3"
            id="settings-health-title"
            title="Client and service health"
          />
        </CardHeader>
        <CardContent className="grid gap-3">
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
          <Button
            type="button"
            variant="outline"
            onClick={() => void onExportDiagnostics()}
          >
            Export redacted sync diagnostics
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
