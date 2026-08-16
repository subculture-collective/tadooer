import type {
  BaikalStatusResponse,
  DayPlanResponse,
  GoogleConnectorStatusResponse,
  PlanningPreferences,
} from "@suite/contracts";
import { GooglePlanning } from "../google-planning.tsx";
import { CalendarMigration } from "../calendar-migration.tsx";

export interface ConnectionsPageProps {
  readonly baikal: BaikalStatusResponse;
  readonly google: GoogleConnectorStatusResponse | undefined;
  readonly planningPreferences: PlanningPreferences | undefined;
  readonly dayPlan: DayPlanResponse | undefined;
  readonly csrfToken: string;
  readonly busy: boolean;
  readonly onAuthorizeGoogle: (() => Promise<string>) | undefined;
  readonly onSyncGoogle: (() => Promise<void>) | undefined;
  readonly onDisconnectGoogle: (() => Promise<void>) | undefined;
  readonly onSavePlanningPreferences:
    | ((preferences: PlanningPreferences) => Promise<void>)
    | undefined;
}

export const ConnectionsPage = ({
  baikal,
  google,
  planningPreferences,
  dayPlan,
  csrfToken,
  busy,
  onAuthorizeGoogle,
  onSyncGoogle,
  onDisconnectGoogle,
  onSavePlanningPreferences,
}: ConnectionsPageProps) => {
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
      <section aria-labelledby="connections-calendars-title">
        <h3 id="connections-calendars-title">Discovered calendars</h3>
        {baikal.calendars.length === 0 ? (
          <p className="muted">
            No calendar collections were returned.
          </p>
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
          Calendar reads and Suite-created time blocks are conditional
          and bounded. Calendar and focus mutations remain online-only
          and are never silently queued.
        </p>
      </section>
    </>
  );
};
