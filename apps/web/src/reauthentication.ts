/**
 * The recent-password prompt of ADR 0048. On a trusted device a sensitive
 * request can be refused with `REAUTHENTICATION_REQUIRED`. The API client
 * then asks here; the mounted dialog confirms the password with the server
 * and the client repeats the request once. Without a mounted dialog the
 * refusal is returned to the caller unchanged.
 */

type ReauthenticationPrompt = () => Promise<boolean>;

let prompt: ReauthenticationPrompt | undefined;
let pending: Promise<boolean> | undefined;

/** Registers the dialog; returns a function that removes it again. */
export const registerReauthenticationPrompt = (
  next: ReauthenticationPrompt,
): (() => void) => {
  prompt = next;
  return () => {
    if (prompt === next) prompt = undefined;
  };
};

/**
 * Resolves true once the owner confirmed the password. Requests refused at
 * the same time share one prompt.
 */
export const requestReauthentication = (): Promise<boolean> => {
  if (prompt === undefined) return Promise.resolve(false);
  pending ??= prompt().finally(() => {
    pending = undefined;
  });
  return pending;
};
