import type { SyntheticEvent } from "react";
import { Field } from "../../field.tsx";

interface TaskCaptureFormProps {
  readonly busy: boolean;
  readonly onSubmit: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => Promise<void>;
}

export const TaskCaptureForm = ({ busy, onSubmit }: TaskCaptureFormProps) => (
  <form className="task-capture" onSubmit={(event) => void onSubmit(event)}>
    <h2>Capture a task</h2>
    <Field label="What needs doing?" name="title" autoComplete="off" />
    <Field label="Notes" name="notes" autoComplete="off" required={false} />
    <label className="field">
      <span>Estimate minutes</span>
      <input name="estimateMinutes" type="number" min="1" max="720" />
    </label>
    <label className="capture-option">
      <input type="checkbox" name="structured" />
      Use capture markers (online)
    </label>
    <p className="capture-help">
      Use +"Project name", #tag, @tomorrow 09:00, or !Friday. Quote text or
      escape a marker with a backslash to keep it literal. Dates use your
      planning timezone.
    </p>
    <button disabled={busy}>{busy ? "Capturing…" : "Capture task"}</button>
  </form>
);
