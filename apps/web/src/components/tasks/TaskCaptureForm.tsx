import type { SyntheticEvent } from "react";
import { Field } from "../../field.tsx";
import { Button } from "../ui/button.tsx";
import { Card, CardContent, CardHeader } from "../ui/card.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Input } from "../ui/input.tsx";
import { SectionHeading } from "../ui/section-heading.tsx";
import { useApplicationPreferences } from "../../application-preferences.tsx";
import { CaptureLinkPreference } from "./CaptureLinkPreference.tsx";
import { CapturePasteSection } from "./CapturePasteSection.tsx";

interface TaskCaptureFormProps {
  readonly busy: boolean;
  readonly onSubmit: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => Promise<void>;
  /**
   * ADR 0031: with a session token the online-only paste preview and the
   * URL preference are shown. Plain capture never needs it.
   */
  readonly csrfToken?: string | undefined;
  readonly onTasksCreated?: (() => void) | undefined;
}

export const TaskCaptureForm = ({
  busy,
  onSubmit,
  csrfToken,
  onTasksCreated,
}: TaskCaptureFormProps) => {
  // ADR 0030: capture defaults; the owner can still clear the estimate.
  const { defaultEstimateMinutes } =
    useApplicationPreferences().snapshot.preferences;
  return (
    <Card className="task-capture">
      <CardHeader>
        <SectionHeading title="Capture a task" />
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void onSubmit(event)}>
          <Field label="What needs doing?" name="title" autoComplete="off" />
          <Field
            label="Notes"
            name="notes"
            autoComplete="off"
            required={false}
          />
          <label className="field">
            <span>Estimate minutes</span>
            <Input
              name="estimateMinutes"
              type="number"
              min="1"
              max="720"
              key={defaultEstimateMinutes ?? "none"}
              defaultValue={defaultEstimateMinutes ?? ""}
            />
          </label>
          <label className="capture-option">
            <Checkbox name="structured" />
            Use capture markers (online)
          </label>
          <label className="capture-option">
            <Checkbox name="createTags" />
            Create unknown #tags with this task
          </label>
          <p className="capture-help">
            Use +"Project name", #tag, 30m or 1h30m, @tomorrow (planned day),
            @tomorrow 09:00 (planned time), @every monday, or !Friday. Web
            addresses are attached as links per the setting below. Quote text or
            escape a marker with a backslash to keep it literal. An unknown #tag
            is created only when the box above is ticked. Dates use your
            planning timezone.
          </p>
          <Button disabled={busy}>
            {busy ? "Capturing…" : "Capture task"}
          </Button>
        </form>
        {csrfToken === undefined ? null : (
          <>
            <CaptureLinkPreference csrfToken={csrfToken} />
            <CapturePasteSection
              csrfToken={csrfToken}
              busy={busy}
              onTasksCreated={onTasksCreated}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
};
