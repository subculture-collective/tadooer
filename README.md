# Productivity Suite

This workspace is the discovery and eventual integration home for a private,
self-hostable productivity suite. The intended suite includes a Greenfield
React successor to Super Productivity, Daymark, Baikal, SuperSync, and the
existing Super Productivity MCP tooling.

No component repository is vendored or moved here yet. Repository topology,
product boundaries, compatibility requirements, and migration strategy remain
open until the requirements interview is complete.

## Existing systems under consideration

- Super Productivity fork: `/home/onnwee/Projects/forks/super-productivity`
- Daymark calendar: `/home/onnwee/Projects/tools/calendar-app`
- Super Productivity MCP suite: `/home/onnwee/Projects/tools/super-productivity-mcp`
- Baikal: deployed service; source repository or deployment definition still to
  be identified during discovery
- SuperSync: currently developed and shipped from the Super Productivity
  repository

## Discovery

The active requirements interview is recorded in
[`docs/discovery/requirements-interview.md`](docs/discovery/requirements-interview.md).

Candidate product requirements that have been captured but not assigned to a
release live under `docs/product/candidate-features/`, including
[Task Templates and Choice Pools](docs/product/candidate-features/task-templates-and-choice-pools.md).

Implementation order is governed by the
[Feature Prioritization](docs/product/feature-prioritization.md) rules and the
[Roadmap](docs/ROADMAP.md), not by feature parity with Super Productivity.
