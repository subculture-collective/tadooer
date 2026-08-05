---
status: accepted
---

# Start with a TypeScript modular monolith and SQLite

Use a pnpm TypeScript workspace with a React/Vite browser application and one
Node.js server process. Keep domain, API contract, persistence, and CalDAV
boundaries in independently testable packages, but bundle the server into one
deployable artifact. The default deployment stores Suite-owned state in SQLite
and serves the compiled web application and `/api` routes from the same origin.

This provides one Suite container plus one Baïkal container, avoids browser CORS
and version-skew problems, and preserves clean ports for a later PostgreSQL
adapter or separately scaled process if measured needs justify either. Baïkal
remains authoritative for DAV resources; SQLite stores Suite installation and,
in later phases, task, session, connector, mapping, and projection state.

Node.js 24 or newer is required so the foundation can use the built-in SQLite
driver without a native addon. Production images pin the Node and Baïkal release
lines rather than following floating `latest` tags.
