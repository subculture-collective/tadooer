import { useState } from "react";
import {
  automationTokenScopeSchema,
  type AutomationToken,
  type AutomationTokenConfirmationPolicy,
  type AutomationTokenScope,
} from "@suite/contracts";
import {
  createAutomationToken,
  listAutomationTokens,
  revokeAutomationToken,
} from "../api.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionHeading } from "@/components/ui/section-heading";

const permissionLabel = (scope: AutomationTokenScope): string => {
  const [area, action] = scope.split(":");
  const subject =
    area === "focus"
      ? "focus sessions"
      : area === "pools"
        ? "choice pools"
        : area === "plugin_data"
          ? "imported plugin data (names and sizes only)"
          : area === "connectors"
            ? "calendar connectors (status; never a credential)"
            : area === "imports"
              ? "owner-previewed calendar imports"
              : area === "publication"
                ? "read-only calendar feeds (never the address)"
                : area;
  return `${action === "read" ? "Read" : action === "recover" ? "Retry" : "Manage"} ${subject ?? ""}`;
};

// ADR 0035: consequential actions (deletion, bulk, replacement, takeover,
// test messages) always need a separate confirmation whatever this says.
const confirmationPolicyLabel = (
  policy: AutomationTokenConfirmationPolicy,
): string =>
  policy === "execute_ordinary"
    ? "ordinary edits apply after preview; consequential actions still need confirmation"
    : "every change needs a separate confirmation";

export const AssistantAccess = ({
  csrfToken,
}: {
  readonly csrfToken: string;
}) => {
  const [tokens, setTokens] = useState<readonly AutomationToken[] | null>(null);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(30);
  const [scopes, setScopes] = useState<AutomationTokenScope[]>(["tasks:read"]);
  const [confirmationPolicy, setConfirmationPolicy] =
    useState<AutomationTokenConfirmationPolicy>("confirm_all");
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
          confirmationPolicy,
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
      <SectionHeading
        as="h3"
        id="assistant-access-title"
        title="Assistant access"
      />
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
          <Field className="field">
            <FieldLabel htmlFor="assistant-label">Access label</FieldLabel>
            <Input
              id="assistant-label"
              type="text"
              required
              maxLength={100}
              value={label}
              disabled={busy}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </Field>
          <Field className="field">
            <FieldLabel htmlFor="assistant-expiry">Expires after</FieldLabel>
            <NativeSelect
              id="assistant-expiry"
              value={days}
              disabled={busy}
              onChange={(event) => setDays(Number(event.currentTarget.value))}
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </NativeSelect>
          </Field>
          <Field className="field">
            <FieldLabel htmlFor="assistant-confirmation-policy">
              Confirmation policy
            </FieldLabel>
            <NativeSelect
              id="assistant-confirmation-policy"
              value={confirmationPolicy}
              disabled={busy}
              onChange={(event) =>
                setConfirmationPolicy(
                  event.currentTarget.value === "execute_ordinary"
                    ? "execute_ordinary"
                    : "confirm_all",
                )
              }
            >
              <option value="confirm_all">Confirm every change</option>
              <option value="execute_ordinary">
                Apply ordinary edits after preview
              </option>
            </NativeSelect>
            <p className="text-muted-foreground text-sm">
              Deletions, bulk actions, tag replacement, focus takeover and test
              messages always need a separate confirmation. The policy cannot be
              changed later; revoke and create new access instead.
            </p>
          </Field>
        </div>
        <fieldset disabled={busy} className="form-grid-2">
          <legend>Assistant permissions</legend>
          {automationTokenScopeSchema.options.map((scope) => (
            <Field
              key={scope}
              className="assistant-permission flex-row items-center gap-2"
            >
              <Checkbox
                id={`assistant-scope-${scope}`}
                checked={scopes.includes(scope)}
                onCheckedChange={(checked) => {
                  setScopes((current) =>
                    checked
                      ? [...current, scope]
                      : current.filter((entry) => entry !== scope),
                  );
                }}
              />
              <FieldLabel htmlFor={`assistant-scope-${scope}`}>
                {permissionLabel(scope)}
              </FieldLabel>
            </Field>
          ))}
        </fieldset>
        <Button
          disabled={
            busy ||
            secret !== null ||
            label.trim() === "" ||
            scopes.length === 0
          }
          type="submit"
        >
          Create assistant access
        </Button>
      </form>
      {secret !== null && (
        <div>
          <Field>
            <FieldLabel htmlFor="assistant-token">
              New assistant token
            </FieldLabel>
            <Input
              id="assistant-token"
              type="password"
              readOnly
              value={secret}
              autoComplete="off"
            />
          </Field>
          <p>
            Save this in a private file owned by you with mode 0600, then point
            the plugin’s tokenFile setting to it. Keep it out of chat and shared
            configuration.
          </p>
          <Button
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
          </Button>
          <Button type="button" variant="ghost" onClick={() => setSecret(null)}>
            I saved the token — dismiss
          </Button>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void refresh()}
      >
        Reload assistant access
      </Button>
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
                <p>{confirmationPolicyLabel(token.confirmationPolicy)}</p>
                {token.revokedAt === null && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => setPendingRevoke(token)}
                  >
                    Revoke {token.label}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}
      {pendingRevoke !== null && (
        <Alert
          variant="warning"
          role="group"
          aria-label="Confirm assistant revocation"
        >
          <p>
            Revoke “{pendingRevoke.label}”? This assistant will lose access
            immediately.
          </p>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void revoke()}
          >
            Confirm revocation
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => setPendingRevoke(null)}
          >
            Keep access
          </Button>
        </Alert>
      )}
      {message !== null && <p role="status">{message}</p>}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
};
