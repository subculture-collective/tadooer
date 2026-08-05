---
status: accepted
---

# Ship one owner account without baking single-user assumptions into the model

The first self-hosted release supports one owner and one suite login, while all
persisted records, tokens, connector credentials, and authorization decisions
remain scoped to a stable owner identity. The suite backend manages the bundled
Baikal connection so the browser does not need a second login; direct DAV access
is explicit and uses separately revocable credentials. Household/team accounts,
sharing, and delegated administration are deferred rather than simulated in v1.

