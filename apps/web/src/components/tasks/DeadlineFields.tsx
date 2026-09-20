import { useState } from "react";
import { taskDeadlineSchema, type Task } from "@suite/contracts";

export const deadlineFromForm = (data: FormData): Task["deadline"] => {
  const kind = data.get("deadlineKind");
  if (kind === "none" || kind === null) return null;
  const raw = data.get("deadlineValue");
  const value = typeof raw === "string" ? raw : "";
  return taskDeadlineSchema.parse({
    kind,
    value: kind === "instant" ? new Date(`${value}Z`).toISOString() : value,
  });
};

export const DeadlineFields = ({
  deadline,
}: {
  readonly deadline: Task["deadline"];
}) => {
  const [kind, setKind] = useState<"none" | "date" | "instant">(
    deadline?.kind ?? "none",
  );
  return (
    <fieldset>
      <legend>Deadline</legend>
      <label className="field">
        <span>Deadline type</span>
        <select
          name="deadlineKind"
          value={kind}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "none" || value === "date" || value === "instant")
              setKind(value);
          }}
        >
          <option value="none">No deadline</option>
          <option value="date">Date only</option>
          <option value="instant">Date and time (UTC)</option>
        </select>
      </label>
      {kind !== "none" && (
        <label className="field">
          <span>
            {kind === "date" ? "Deadline date" : "Deadline date and time (UTC)"}
          </span>
          <input
            key={kind}
            name="deadlineValue"
            type={kind === "date" ? "date" : "datetime-local"}
            required
            step={kind === "instant" ? "0.001" : undefined}
            defaultValue={
              deadline?.kind === kind ? deadline.value.replace(/Z$/, "") : ""
            }
          />
        </label>
      )}
    </fieldset>
  );
};
