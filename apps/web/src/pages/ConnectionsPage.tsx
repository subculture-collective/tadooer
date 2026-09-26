import { useState } from "react";
import type {
  BaikalStatusResponse,
  DayPlanResponse,
  GoogleConnectorStatusResponse,
  PlanningPreferences,
} from "@suite/contracts";
import { GooglePlanning } from "../google-planning.tsx";
import { CalendarMigration } from "../calendar-migration.tsx";
import { AssistantAccess } from "../components/AssistantAccess.tsx";
import { SuperProductivityImport } from "../components/SuperProductivityImport.tsx";
import { ImportedPluginData } from "../components/ImportedPluginData.tsx";
import { CalendarSubscriptions } from "../components/CalendarSubscriptions.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import { SectionHeading } from "../components/ui/section-heading.tsx";

export interface ConnectionsPageProps {
  readonly calendarMessage?: string | null;
  readonly baikal: BaikalStatusResponse;
  readonly google: GoogleConnectorStatusResponse | undefined;
  readonly planningPreferences: PlanningPreferences | undefined;
  readonly dayPlan: DayPlanResponse | undefined;
  readonly csrfToken: string;
  readonly onTaskImport: () => Promise<void>;
  readonly busy: boolean;
  readonly onAuthorizeGoogle: (() => Promise<string>) | undefined;
  readonly onSyncGoogle: ((full?: boolean) => Promise<void>) | undefined;
  readonly onDisconnectGoogle: (() => Promise<void>) | undefined;
  readonly onSavePlanningPreferences:
    ((preferences: PlanningPreferences) => Promise<void>) | undefined;
}

export const ConnectionsPage = ({
  calendarMessage,
  baikal,
  google,
  planningPreferences,
  dayPlan,
  csrfToken,
  onTaskImport,
  busy,
  onAuthorizeGoogle,
  onSyncGoogle,
  onDisconnectGoogle,
  onSavePlanningPreferences,
}: ConnectionsPageProps) => {
  // Reloads the imported plugin data list after an import (ADR 0026).
  const [imports, setImports] = useState(0);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        title="Connections"
        description="Manage imports, assistant access, and calendar integrations."
      />
      <AssistantAccess csrfToken={csrfToken} />
      <SuperProductivityImport
        csrfToken={csrfToken}
        onApplied={async () => {
          setImports((count) => count + 1);
          await onTaskImport();
        }}
      />
      <ImportedPluginData csrfToken={csrfToken} refreshKey={imports} />
      {calendarMessage && (
        <Alert variant="info" role="status" aria-live="polite">
          <AlertDescription>{calendarMessage}</AlertDescription>
        </Alert>
      )}
      {google !== undefined &&
        planningPreferences !== undefined &&
        dayPlan !== undefined &&
        onAuthorizeGoogle !== undefined &&
        onSyncGoogle !== undefined &&
        onDisconnectGoogle !== undefined &&
        onSavePlanningPreferences !== undefined && (
          <GooglePlanning
            mode="connection"
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
      <CalendarSubscriptions csrfToken={csrfToken} />
      <Card aria-labelledby="connections-calendars-title">
        <CardHeader>
          <SectionHeading
            as="h3"
            id="connections-calendars-title"
            title="Discovered calendars"
          />
        </CardHeader>
        <CardContent className="grid gap-3">
          {baikal.calendars.length === 0 ? (
            <EmptyState title="No calendar collections were returned." />
          ) : (
            <ul className="calendars">
              {baikal.calendars.map((calendar) => (
                <li key={calendar.href}>
                  <strong>{calendar.displayName}</strong>
                  <span>
                    {[
                      calendar.supportsEvents ? "Events" : null,
                      calendar.supportsTodos ? "Todos" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No supported component reported"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <CalendarMigration
            calendars={baikal.calendars}
            csrfToken={csrfToken}
          />
          <p className="boundary-note">
            Calendar reads and Suite-created time blocks are conditional and
            bounded. Calendar and focus mutations remain online-only and are
            never silently queued.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};
