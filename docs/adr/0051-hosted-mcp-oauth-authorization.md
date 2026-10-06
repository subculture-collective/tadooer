---
status: accepted
---

# Authorize hosted MCP with owner-consented OAuth and PKCE

Hosted MCP must not reuse an interactive browser cookie, a connector grant, or
one shared owner automation token. This decision adds a separately authorized
OAuth boundary over the existing automation catalog. The hosted MCP transport
remains a separate dependency: authorization being available does not publish
an MCP endpoint or qualify a hosted client.

## Standards and discovery

The authorization server follows the OAuth authorization-code flow and the
current security guidance in RFC 6749, RFC 7636, RFC 8414, RFC 8707 and RFC
9700. Protected-resource discovery follows RFC 9728. OAuth error responses and
redirect behavior retain the definitions from RFC 6749 unless a later listed
specification tightens them.

The deployment publishes:

- `/.well-known/oauth-authorization-server`, with issuer, authorization, token
  and revocation endpoints, supported scopes, `code` response type, only the
  `authorization_code` grant, and only `S256` PKCE;
- `/.well-known/oauth-protected-resource`, naming the exact hosted MCP resource
  URI and this installation's authorization-server issuer; and
- a bearer challenge containing the protected-resource metadata URL when a
  hosted resource request has no usable token.

The issuer and every advertised endpoint derive from the configured HTTPS
public origin. Loopback HTTP remains test-only and is not a hosted deployment.
Metadata responses contain no owner, client, grant or credential data.

## Supported clients and registration

Clients are deployment-owned records loaded from an administrator-managed,
mode-0600 configuration file. Each record has one stable client ID, bounded
display name and an explicit non-empty set of redirect URIs. Redirect matching
is exact string matching after configuration-time URL parsing: no wildcard,
prefix, subdomain, query substitution or fragment is accepted. Userinfo is
forbidden. Hosted redirects require HTTPS. Native loopback redirects may use
HTTP only for `127.0.0.1` or `[::1]`, with the registered port matched exactly.

Clients are public clients. Client secrets and client authentication methods
are not supported. Dynamic client registration (RFC 7591) is deliberately not
supported: no registration endpoint is advertised, and an unknown client ID
is rejected before owner authentication or consent. Adding or changing a
client is a deployment and credential-ownership action, not an OAuth request.

## Authorization and consent

Every authorization request must provide all of:

- `response_type=code`;
- one configured `client_id` and one exact registered `redirect_uri`;
- an unguessable client-managed `state`, returned unchanged;
- a PKCE `code_challenge` using `code_challenge_method=S256`;
- one exact `resource` value equal to the advertised hosted MCP resource URI;
  and
- a non-empty, space-separated set of known automation scopes.

Duplicate parameters, unsupported response modes, unknown scopes, malformed
values and overlong requests fail closed. The server never widens a requested
scope set. Authorization uses the owner's normal same-origin session only to
identify the person approving the request. It displays the exact client,
resource and requested scopes and requires an explicit approve or deny action.
The browser cookie is never accepted by the token endpoint or hosted resource.

An authorization request is stored digest-only, expires after ten minutes and
is consumed by either approval or denial. The issued code is random,
digest-only, bound to owner, client, redirect URI, resource, scopes and PKCE
challenge, expires after one minute and is single-use. A code is consumed in
the same transaction that creates its grant. Failed verifier, client,
redirect, resource or replay checks return `invalid_grant` without disclosing
which binding differed.

## Tokens, rotation and isolation

The token endpoint accepts only form-encoded requests. An authorization-code
exchange requires the original `client_id`, exact `redirect_uri`, exact
`resource` and a PKCE verifier whose S256 digest matches the code. Refresh
requests require the same public client and resource and may only retain or
narrow the originally consented scopes.

Access tokens are opaque, digest-only Suite automation credentials with a
15-minute lifetime. They carry immutable owner, client, grant, resource and
scope bindings and enter the existing automation authorization path only after
all bindings, expiry and revocation checks succeed. A token issued to one
client or resource cannot be used by another client or audience. Browser,
sync-client, Google, Baikal and local manually issued automation credentials
cannot be exchanged into this grant family.

Refresh tokens are opaque and digest-only, expire after 30 days, and rotate on
every successful use. Rotation atomically revokes the presented token and
creates its successor. Reuse of any retired refresh token revokes the complete
grant family, including current access and refresh tokens. Concurrent refresh
attempts therefore produce at most one usable successor.

RFC 7009 revocation accepts either token type, is authenticated by the public
`client_id`, and returns success for unknown values. A client can revoke only
its own token family. The owner can revoke a grant from the interactive
connection inventory; this immediately invalidates every access and refresh
token in that grant without ending browser sessions or unrelated grants.

## Public endpoint and audit policy

Authorization, token, discovery and revocation endpoints have bounded request
sizes, reject unexpected content types and use `Cache-Control: no-store`.
Token and revocation endpoints reject browser `Origin` headers. Per-address
and per-client limits bound invalid authorization, exchange, refresh and
revocation attempts; limit responses do not reveal client or grant existence.
Redirects occur only after the client and redirect URI have both validated.

Append-only OAuth audit rows record only owner ID when known, client ID, grant
or request ID, phase, outcome, bounded error code, scope identifiers, resource
identifier and timestamp. They never contain raw state, codes, PKCE values,
access or refresh tokens, browser cookies, task content, redirect queries,
provider responses, stack traces or filesystem paths. Unknown-client and
malformed unauthenticated traffic is counted but is not attributed to an
owner.

## Deployment and qualification boundary

The server administrator owns the supported-client configuration and protects
it as deployment configuration even though it contains no token. The owner
owns consent and revocation. Each client owns its PKCE verifier, state and
issued tokens and must keep them out of URLs, logs, manifests and chat.

Production enablement requires an HTTPS public origin, an exact hosted MCP
resource URI, reviewed client redirects, proxy limits and a backup that keeps
OAuth tables and token digests outside user data exports. Qualification must
cover rejection, expired request/code/access/refresh grants, code and state
replay, wrong verifier, wrong redirect, wrong resource, cross-client exchange
and refresh, narrowed scopes, rotation reuse, owner/client revocation and
browser-session continuity. Unit or disposable integration checks do not prove
live client compatibility, proxy behavior, deployment or release publication.
