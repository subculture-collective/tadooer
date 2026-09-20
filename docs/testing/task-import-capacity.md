# Super Productivity import capacity

Issue: #18. The browser, task-import HTTP routes and pure parser share a 16 MiB
UTF-8 byte limit. Other JSON routes retain their existing 5 MiB default. Live and
archived tasks, projects, tags and repeat configurations share a 50,000-record
budget (the larger of each store index and entity count). Diagnostics are capped
at 100,000. Exceeding a budget rejects the export; it never trims history or applies
a partial import. A streamed byte overflow returns HTTP 413 after authentication
and CSRF checks, without destroying the socket before the error can be delivered.

The limit provides roughly four times the inspected full backup's byte size and
more than ten times its task count while retaining finite parsing/report work.
It is a per-request budget, not a throughput or concurrent-load guarantee.

## Local qualification — September 20, 2026

- Full repository gate: formatting, lint, typechecks, 216 tests across 65 files,
  and all four builds passed.
- Boundary tests: below/at/above the inclusive byte limit, UTF-8 multibyte text,
  malformed JSON, aggregate archive records, oversized indexes, streamed bodies
  without Content-Length, and unchanged default-route budget.
- Authenticated HTTP tests: a 6 MiB export previews successfully; preview/apply
  reject oversized bodies with 413 and malformed JSON with 400, without creating
  tasks. Existing reviewed-hash, unsupported-data, replay and auth checks pass.
- Fresh automatic backup `2026-09-20_131744.json` previewed read-only, intact:
  4,191,857 bytes; SHA-256
  `dfdddc25d21317fc9fb6a00ff5bd7f2e4b0962bd2da19d01e238bfbb411215b3`.
  Inventory remains 4,821 accepted task records and 4,802 findings; apply remains
  blocked. See the real-backup report for the six excluded blank-title records.
  Pure prepare took 63 ms; process peak RSS was 161,920 KiB.
- Synthetic 50,000-task core export: 14,466,701 bytes; pure prepare took 257 ms,
  process peak RSS 330,568 KiB, all records inventoried. No apply was performed.
  Peak RSS includes Node and in-process fixture construction; these are local
  observations, not production memory guarantees.

No real data was imported, no source backup changed, and no production deployment
was performed. Browser interaction and production-capacity qualification are not
claimed by these parser/HTTP measurements.
