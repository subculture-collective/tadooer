import { useState } from "react";
import {
  automationTokenScopeSchema,
  type AutomationToken,
  type AutomationTokenScope,
} from "@suite/contracts";
import {
  createAutomationToken,
  listAutomationTokens,
  revokeAutomationToken,
} from "../api.ts";

const permissionLabel = (scope: AutomationTokenScope): string => {
  const [area, action] = scope.split(":");
  const subject =
    area === "focus"
      ? "focus sessions"
      : area === "pools"
        ? "choice pools"
        : area;
  return `${action === "read" ? "Read" : "Manage"} ${subject ?? ""}`;
};

export const AssistantAccess = ({
  csrfToken,
}: {
  readonly csrfToken: string;
}) => {
  const [tokens, setTokens] = useState<readonly AutomationToken[] | null>(null);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(30);
  const [scopes, setScopes] = useState<AutomationTokenScope[]>(["tasks:read"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<AutomationToken | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      setTokens((await listAutomationTokens()).tokens);
    } catch (error: unknown) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not load assistant access",
      );
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const issued = await createAutomationToken(
        {
          label,
          scopes,
          expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
        },
        csrfToken,
      );
      setSecret(issued.token);
      setTokens((current) =>
        current === null ? null : [issued.record, ...current],
      );
      setMessage(
        "Access created. Save the token now; it cannot be retrieved later.",
      );
    } catch (error: unknown) {
      setError(
        `${error instanceof Error ? error.message : "Creation failed"}. If the response was interrupted, reload access before retrying and revoke any unused token.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (pendingRevoke === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await revokeAutomationToken(pendingRevoke.id, csrfToken);
      setTokens(
        (current) =>
          current?.map((token) =>
            token.id === pendingRevoke.id
              ? { ...token, revokedAt: new Date().toISOString() }
              : token,
          ) ?? null,
      );
      setPendingRevoke(null);
      setMessage("Assistant access revoked.");
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "Revocation failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="assistant-access"
      aria-labelledby="assistant-access-title"
    >
      <h3 id="assistant-access-title">Assistant access</h3>
      <p>
        Create a separate token for each assistant. Select only the permissions
        it needs. The Tadooer plugin previews changes and asks for your approval
        before deletion or bulk actions.
      </p>
      <form
        className="assistant-access-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="form-grid-2">
          <label className="field">
            Access label{" "}
            <input
              type="text"
              required
              maxLength={100}
              value={label}
              disabled={busy}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            Expires after{" "}
            <select
              value={days}
              disabled={busy}
              onChange={(event) => setDays(Number(event.currentTarget.value))}
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
        </div>
        <fieldset disabled={busy} className="form-grid-2">
          <legend>Assistant permissions</legend>
          {automationTokenScopeSchema.options.map((scope) => (
            <label key={scope} className="assistant-permission">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setScopes((current) =>
                    checked
                      ? [...current, scope]
                      : current.filter((entry) => entry !== scope),
                  );
                }}
              />
              {permissionLabel(scope)}
            </label>
          ))}
        </fieldset>
        <button
          disabled={
            busy ||
            secret !== null ||
            label.trim() === "" ||
            scopes.length === 0
          }
          type="submit"
        >
          Create assistant access
        </button>
      </form>
      {secret !== null && (
        <div>
          <label>
            New assistant token{" "}
            <input type="password" readOnly value={secret} autoComplete="off" />
          </label>
          <p>
            Save this in a private file owned by you with mode 0600, then point
            the plugin’s tokenFile setting to it. Keep it out of chat and shared
            configuration.
          </p>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(secret);
                  setError(null);
                  setMessage(
                    "Token copied. Save it in your private token file.",
                  );
                } catch {
                  setError(
                    "Clipboard unavailable. Select and copy the token field locally.",
                  );
                }
              })();
            }}
          >
            Copy token
          </button>
          <button type="button" onClick={() => setSecret(null)}>
            I saved the token — dismiss
          </button>
        </div>
      )}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        Reload assistant access
      </button>
      {tokens !== null &&
        (tokens.length === 0 ? (
          <p>No assistant tokens created.</p>
        ) : (
          <ul>
            {tokens.map((token) => (
              <li key={token.id}>
                <strong>{token.label}</strong> —{" "}
                {token.revokedAt !== null
                  ? "revoked"
                  : Date.parse(token.expiresAt) <= Date.now()
                    ? "expired"
                    : "active"}
                ; expires {token.expiresAt}
                <p>{token.scopes.map(permissionLabel).join(", ")}</p>
                {token.revokedAt === null && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPendingRevoke(token)}
                  >
                    Revoke {token.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ))}
      {pendingRevoke !== null && (
        <div role="group" aria-label="Confirm assistant revocation">
          <p>
            Revoke “{pendingRevoke.label}”? This assistant will lose access
            immediately.
          </p>
          <button type="button" disabled={busy} onClick={() => void revoke()}>
            Confirm revocation
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setPendingRevoke(null)}
          >
            Keep access
          </button>
        </div>
      )}
      {message !== null && <p role="status">{message}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </section>
  );
};
