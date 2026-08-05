---
status: accepted
---

# Bundle Baikal while depending on CalDAV rather than Baikal internals

Ship Baikal as the default second container and authoritative calendar and
address-book store, but integrate it through qualified CalDAV/CardDAV contracts
so advanced deployments can substitute another compatible server. The React
suite owns presentation, availability policy, mappings, and cached projections;
it does not duplicate authoritative calendar resources in its application
database. This preserves external-client interoperability and prevents calendar
storage from becoming inseparable from task, session, synchronization, or MCP
state.

