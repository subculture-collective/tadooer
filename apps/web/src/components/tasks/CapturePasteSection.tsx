import { useState } from "react";
import type { CapturePreviewResponse } from "@suite/contracts";
import { createTaskBatch, previewTaskCapture } from "../../api.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Textarea } from "../ui/textarea.tsx";

interface CapturePasteSectionProps {
  readonly csrfToken: string;
  readonly busy: boolean;
  readonly onTasksCreated?: (() => void) | undefined;
}

const messageFor = (error: unknown): string =>
  error instanceof Error ? error.message : "Capture failed";

type PreviewChild = Omit<CapturePreviewResponse["items"][number], "children">;

const describe = (item: PreviewChild): string => {
  const parts: string[] = [];
  if (item.projectTitle !== null) parts.push(`+${item.projectTitle}`);
  for (const tag of item.tagTitles) parts.push(`#${tag}`);
  if (item.estimateMinutes !== null)
    parts.push(`${String(item.estimateMinutes)} min`);
  if (item.plannedDay !== null) parts.push(`planned ${item.plannedDay}`);
  if (item.plannedStart !== null)
    parts.push(`starts ${new Date(item.plannedStart).toLocaleString()}`);
  if (item.deadline !== null) parts.push(`due ${item.deadline}`);
  if (item.recurrence !== null) parts.push(item.recurrence);
  if (item.links.length > 0)
    parts.push(
      `${String(item.links.length)} ${item.links.length === 1 ? "link" : "links"}`,
    );
  return parts.join(" · ");
};

/**
 * ADR 0031: paste a Markdown list or an email; preview every task the paste
 * would create, confirm any new tags, then create them in one batch.
 * Online-only: the section is rendered only with a session token.
 */
export const CapturePasteSection = ({
  csrfToken,
  busy,
  onTasksCreated,
}: CapturePasteSectionProps) => {
  const [text, setText] = useState("");
  const [structured, setStructured] = useState(true);
  const [preview, setPreview] = useState<CapturePreviewResponse | null>(null);
  const [createTags, setCreateTags] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);

  const runPreview = async (): Promise<void> => {
    setWorking(true);
    setError(null);
    setCreated(null);
    try {
      setPreview(await previewTaskCapture({ text, structured }, csrfToken));
      setCreateTags(false);
    } catch (caught: unknown) {
      setPreview(null);
      setError(messageFor(caught));
    } finally {
      setWorking(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (preview === null) return;
    setWorking(true);
    setError(null);
    try {
      const result = await createTaskBatch(
        { ...preview.request, createTags },
        csrfToken,
        crypto.randomUUID(),
      );
      setCreated(result.tasks.length);
      setPreview(null);
      setText("");
      onTasksCreated?.();
    } catch (caught: unknown) {
      setError(messageFor(caught));
    } finally {
      setWorking(false);
    }
  };

  const total =
    preview === null
      ? 0
      : preview.items.reduce(
          (count, item) => count + 1 + item.children.length,
          0,
        );
  const needsConsent = preview !== null && preview.newTags.length > 0;

  return (
    <section className="capture-paste" aria-label="Paste tasks">
      <label className="field">
        <span>Paste a Markdown list or an email</span>
        <Textarea
          name="pasteText"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={
            "- [ ] First task #tag 30m\n  - child task\nor an email starting with Subject:"
          }
          rows={4}
        />
      </label>
      <label className="capture-option">
        <Checkbox
          checked={structured}
          onCheckedChange={(value) => setStructured(value === true)}
        />
        Read capture markers in each line
      </label>
      <p className="capture-actions">
        <Button
          type="button"
          variant="outline"
          disabled={busy || working || text.trim() === ""}
          onClick={() => void runPreview()}
        >
          {working && preview === null ? "Previewing…" : "Preview tasks"}
        </Button>
      </p>
      {preview === null ? null : (
        <div className="capture-preview" role="region" aria-live="polite">
          <p>
            {preview.kind === "email"
              ? "One task from the email subject; the body becomes notes."
              : `${String(total)} ${total === 1 ? "task" : "tasks"} from the ${preview.kind === "markdown" ? "list" : "text"}.`}
            {preview.skippedCompleted > 0
              ? ` ${String(preview.skippedCompleted)} completed ${preview.skippedCompleted === 1 ? "item is" : "items are"} skipped.`
              : ""}
            {preview.truncated ? " Long text was shortened." : ""}
          </p>
          <ul>
            {preview.items.map((item, index) => (
              <li key={index}>
                <strong>{item.title}</strong>
                {describe(item) === "" ? null : (
                  <small> {describe(item)}</small>
                )}
                {item.children.length === 0 ? null : (
                  <ul>
                    {item.children.map((child, childIndex) => (
                      <li key={childIndex}>
                        {child.title}
                        {describe(child) === "" ? null : (
                          <small> {describe(child)}</small>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {needsConsent ? (
            <label className="capture-option">
              <Checkbox
                checked={createTags}
                onCheckedChange={(value) => setCreateTags(value === true)}
              />
              Create {preview.newTags.length === 1 ? "tag" : "tags"}{" "}
              {preview.newTags.map((tag) => `#${tag}`).join(", ")}
            </label>
          ) : null}
          <p className="capture-actions">
            <Button
              type="button"
              disabled={busy || working || (needsConsent && !createTags)}
              onClick={() => void confirm()}
            >
              {working
                ? "Creating…"
                : `Create ${String(total)} ${total === 1 ? "task" : "tasks"}`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={working}
              onClick={() => setPreview(null)}
            >
              Cancel
            </Button>
          </p>
        </div>
      )}
      {created === null ? null : (
        <p role="status">
          Created {String(created)} {created === 1 ? "task" : "tasks"}.
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
};
