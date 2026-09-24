import type { SyntheticEvent } from "react";
import { Field } from "../../field.tsx";
import { Button } from "../ui/button.tsx";
import { Card, CardContent, CardHeader } from "../ui/card.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Input } from "../ui/input.tsx";
import { SectionHeading } from "../ui/section-heading.tsx";

interface TaskCaptureFormProps {
  readonly busy: boolean;
  readonly onSubmit: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => Promise<void>;
}

export const TaskCaptureForm = ({ busy, onSubmit }: TaskCaptureFormProps) => (
  <Card className="task-capture">
    <CardHeader>
      <SectionHeading title="Capture a task" />
    </CardHeader>
    <CardContent>
      <form onSubmit={(event) => void onSubmit(event)}>
        <Field label="What needs doing?" name="title" autoComplete="off" />
        <Field label="Notes" name="notes" autoComplete="off" required={false} />
        <label className="field">
          <span>Estimate minutes</span>
          <Input name="estimateMinutes" type="number" min="1" max="720" />
        </label>
        <label className="capture-option">
          <Checkbox name="structured" />
          Use capture markers (online)
        </label>
        <p className="capture-help">
          Use +"Project name", #tag, @tomorrow 09:00, or !Friday. Quote text or
          escape a marker with a backslash to keep it literal. Dates use your
          planning timezone.
        </p>
        <Button disabled={busy}>{busy ? "Capturing…" : "Capture task"}</Button>
      </form>
    </CardContent>
  </Card>
);
