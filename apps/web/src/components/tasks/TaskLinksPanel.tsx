import { useState, type SyntheticEvent } from "react";
import {
  safeExternalUrl,
  type TaskAttachment,
  type TaskLinksResponse,
} from "@suite/contracts";
import {
  createTaskAttachment,
  deleteTaskAttachment,
  deleteTaskIssueLink,
  getTaskLinks,
} from "../../api.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { NativeSelect } from "../ui/native-select.tsx";
import { Textarea } from "../ui/textarea.tsx";

const unavailableText: Readonly<
  Record<NonNullable<TaskAttachment["unavailableReason"]>, string>
> = {
  device_local:
    "Unavailable: a file on the device that created it. Tadooer does not read local files.",
  command_not_run:
    "Unavailable: an imported command. Tadooer never runs commands.",
  unsupported_address: "Unavailable: not an http or https address.",
};

const kindLabel: Readonly<Record<TaskAttachment["kind"], string>> = {
  link: "Link",
  note: "Note",
  file: "File",
  image: "Image",
  command: "Command",
};

/** Opens only http(s) URLs, in a new tab without opener or referrer. */
const ExternalLink = ({
  href,
  children,
}: {
  readonly href: string | null;
  readonly children: string;
}) => {
  const safe = href === null ? undefined : safeExternalUrl(href);
  return safe === undefined ? (
    <span>{children}</span>
  ) : (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
};

const hostOf = (url: string | null): string => {
  if (url === null) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

export interface TaskLinksViewProps {
  readonly links: TaskLinksResponse;
  readonly busy: boolean;
  readonly online: boolean;
  readonly onAdd: (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => void;
  readonly onRemoveAttachment: (attachment: TaskAttachment) => void;
  readonly onRemoveIssueLink: () => void;
}

/** Presentational view of one task's issue link and attachments. */
export const TaskLinksView = ({
  links,
  busy,
  online,
  onAdd,
  onRemoveAttachment,
  onRemoveIssueLink,
}: TaskLinksViewProps) => {
  const disabled = busy || !online;
  const issue = links.issueLink;
  return (
    <div className="task-links">
      {issue !== null && (
        <section aria-label="Linked issue">
          <p>
            <strong>Linked issue</strong>{" "}
            <Badge variant="secondary">
              {issue.providerKey ?? "Unknown provider"}
            </Badge>{" "}
            <ExternalLink href={issue.displayUrl}>
              {`Issue ${issue.issueId}`}
            </ExternalLink>
          </p>
          <p className="muted">
            {issue.providerRecorded
              ? "Not connected. Refreshing this issue needs a new provider authorization, which Tadooer does not offer yet."
              : "The provider was not in the imported export. The link is kept as a record only."}
            {issue.lastUpdatedAt !== null &&
              ` Last synced ${new Date(issue.lastUpdatedAt).toLocaleString()}.`}
          </p>
          <Button
            type="button"
            variant="destructive"
            disabled={disabled}
            onClick={onRemoveIssueLink}
          >
            Remove issue link
          </Button>
        </section>
      )}
      <section aria-label="Attachments">
        <strong>Attachments</strong>
        {links.attachments.length === 0 ? (
          <p className="muted">No attachments.</p>
        ) : (
          <ul>
            {links.attachments.map((attachment) => {
              const label =
                attachment.title !== ""
                  ? attachment.title
                  : hostOf(attachment.url) || kindLabel[attachment.kind];
              return (
                <li key={attachment.id}>
                  <Badge variant="outline">{kindLabel[attachment.kind]}</Badge>{" "}
                  {attachment.kind === "note" ? (
                    <>
                      {attachment.title !== "" && (
                        <strong>{attachment.title}</strong>
                      )}
                      <p className="task-links__note">{attachment.text}</p>
                    </>
                  ) : (
                    <ExternalLink href={attachment.url}>{label}</ExternalLink>
                  )}
                  {attachment.unavailableReason !== null && (
                    <>
                      <p className="muted">
                        {unavailableText[attachment.unavailableReason]}
                      </p>
                      {attachment.sourcePath !== null && (
                        <code className="task-links__source">
                          {attachment.sourcePath}
                        </code>
                      )}
                    </>
                  )}
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={disabled}
                    onClick={() => {
                      onRemoveAttachment(attachment);
                    }}
                  >
                    Remove {label}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <form className="task-edit" onSubmit={onAdd}>
        <label className="field">
          <span>Attachment type</span>
          <NativeSelect name="kind" defaultValue="link" disabled={disabled}>
            <option value="link">Link</option>
            <option value="note">Note</option>
          </NativeSelect>
        </label>
        <label className="field">
          <span>Title (optional)</span>
          <Input name="title" autoComplete="off" disabled={disabled} />
        </label>
        <label className="field">
          <span>Link address or note text</span>
          <Textarea name="content" rows={2} required disabled={disabled} />
        </label>
        <Button disabled={disabled}>Add attachment</Button>
      </form>
      {!online && (
        <p className="muted">Attachments need a connection to change.</p>
      )}
    </div>
  );
};

const failure = (error: unknown): string =>
  error instanceof Error ? error.message : "The change could not be saved";

const field = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

export interface TaskLinksPanelProps {
  readonly taskId: string;
  readonly csrfToken: string;
  readonly online: boolean;
}

/**
 * Loads a task's links when opened. Links are online-only records; every
 * write sends the record's revision and reloads the task's links.
 */
export const TaskLinksPanel = ({
  taskId,
  csrfToken,
  online,
}: TaskLinksPanelProps) => {
  const [links, setLinks] = useState<TaskLinksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<TaskLinksResponse>) => {
    setBusy(true);
    setError(null);
    try {
      setLinks(await work());
    } catch (cause: unknown) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details
      className="task-links-panel"
      onToggle={(event) => {
        if (event.currentTarget.open && links === null && online)
          void run(() => getTaskLinks(taskId));
      }}
    >
      <summary>Links and attachments</summary>
      {error !== null && <p role="alert">{error}</p>}
      {links === null ? (
        <p className="muted">
          {online ? "Loading…" : "Links and attachments need a connection."}
        </p>
      ) : (
        <TaskLinksView
          links={links}
          busy={busy}
          online={online}
          onAdd={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const content = field(data, "content");
            const title = field(data, "title");
            const kind = field(data, "kind") === "note" ? "note" : "link";
            if (kind === "link" && safeExternalUrl(content) === undefined) {
              setError(
                "Use an http or https address without a user name or password.",
              );
              return;
            }
            if (content.trim() === "") {
              setError("Note text is required.");
              return;
            }
            void run(async () => {
              const next = await createTaskAttachment(
                taskId,
                kind === "note"
                  ? { kind: "note", title, text: content }
                  : { kind: "link", title, url: content.trim() },
                csrfToken,
              );
              form.reset();
              return next;
            });
          }}
          onRemoveAttachment={(attachment) => {
            void run(async () => {
              await deleteTaskAttachment(
                taskId,
                attachment.id,
                attachment.revision,
                csrfToken,
              );
              return getTaskLinks(taskId);
            });
          }}
          onRemoveIssueLink={() => {
            const issue = links.issueLink;
            if (issue === null) return;
            void run(async () => {
              await deleteTaskIssueLink(
                taskId,
                issue.id,
                issue.revision,
                csrfToken,
              );
              return getTaskLinks(taskId);
            });
          }}
        />
      )}
    </details>
  );
};
