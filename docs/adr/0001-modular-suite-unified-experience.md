---
status: accepted
---

# Use modular bounded contexts behind one product experience

Build the Greenfield suite as explicit task, calendar, session, synchronization,
and automation contexts with stable contracts, while presenting them through a
single React product experience. Preserve the existing Angular application as a
migration client rather than making historical UI implementation details the new
architecture. The default self-hosted distribution must compose these contexts
into no more than one or two minimally configured containers; this keeps internal
boundaries testable without making users deploy a microservice platform.
