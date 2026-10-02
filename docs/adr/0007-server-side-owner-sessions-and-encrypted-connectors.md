---
status: accepted
---

# Use revocable server-side sessions and encrypted connector credentials

The browser authenticates with an opaque, short-lived session cookie. SQLite
stores only a SHA-256 digest of the session token, an independently hashed CSRF
token, idle and absolute expiries, and explicit revocation state. Unsafe HTTP
requests require both a same-origin request and the session's CSRF token. The
single supported account is still persisted under a stable owner identity so
authorization never depends on a process-global current user.

Owner passwords use Node's memory-hard scrypt implementation with versioned
parameters and a constant-work dummy verification path when no matching owner
exists. Login attempts are rate-limited. Sessions are not placed in browser
storage and can be revoked immediately without a signing-key rotation.

> Note, 2026-10-02: [ADR 0048](0048-trusted-device-sessions.md) adds
> trusted-device sessions. A device the owner marks as trusted at sign-in
> keeps a session for 30 days of inactivity (180 days at most) with a token
> that rotates on use; sensitive routes on such a session need the password
> again within 15 minutes. A session without that choice is unchanged:
> opaque, 30 minutes idle, 12 hours absolute, as described here.

DAV passwords are encrypted with AES-256-GCM and authenticated metadata before
they enter SQLite. A randomly generated 256-bit key is stored as a mode-0600
file in the Suite data volume, outside the SQLite file. Backup tooling copies
that key as a separately permissioned secret sidecar. A database backup
therefore requires its matching key sidecar to make connector credentials usable
after restore. Losing that key intentionally fails closed and requires the owner
to reconnect Baïkal; it does not make task data unrecoverable.

The Phase 0B connector accepts credentials only for the server-configured
Baïkal endpoint. User-selectable external CalDAV origins remain deferred until
their SSRF, DNS-rebinding, TLS, redirect, and credential-leak boundaries have a
separate contract and test corpus.
