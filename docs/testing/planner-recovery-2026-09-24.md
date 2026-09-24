# Planner actions and recovery qualification — September 24, 2026

Implementation revision: `630d45dec387afbd926e5ab013a23f42f5eb6b4f`, based on
`588c1ed99df36402d22d5447ad0f4c88d35a9df5`. Delivery: [PR #89](https://git.subcult.tv/PatrickFanella/productivity-suite/pulls/89).
This record covers development acceptance for [#14](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/14)
and [#16](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/16).
Candidate deployment remains [#37](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/37);
production soak remains [#21](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/21).

## Environment and automated checks

The disposable runtime used a fresh SQLite database, synthetic owner, Suite on
127.0.0.1:18580, and Baikal Compose project `suite-reliability-sep24` on
127.0.0.1:18586. Chromium profiles signed in through the normal owner UI.
`pnpm verify` passed: 260 tests in 81 files, formatting, lint, type checks,
and all four builds. Hosted checks and the final merge SHA are recorded on PR #89.

## Browser results

| Journey                            | Evidence and result                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-field deadline conflict       | Separate browser profiles queued October 1 and October 2 deadlines offline. Reconnecting in order produced a field review showing current and attempted values. Explicit retry applied October 2 with a fresh operation. A second conflict between October 3 and 4 kept October 3 after Keep current.                                                                                                                                                     |
| Reset, snapshot, and replay        | A write was accepted by the disposable server, then its acknowledgement was replaced with a controlled `SYNC_CURSOR_EXPIRED` response. The client fetched a snapshot and replayed the identical operation ID, sequence, payload, and hash. The server returned `replayed` with the original revision/change sequence. One task existed; the unrelated pending deadline conflict remained present across reset.                                            |
| Conflict history                   | IndexedDB readback retained the original immutable operation as `resolved`, its resolution choice/time, and the replacement operation ID for retry. Keep-current queued no replacement. Unrelated task edits no longer dismiss conflicts; focused tests reject stale reviews and retries while later task edits are queued.                                                                                                                               |
| Command keyboard and mobile        | Ctrl+K, typed search, ArrowDown/Enter, Escape, and return to the trigger passed. Offline Sync now remained disabled and did not activate. At 390×844, Tasks → Settings → Tasks navigation worked, and the Planner had no document-width overflow.                                                                                                                                                                                                         |
| Planner block identity and actions | Two real Baikal events had the same title and start: one 45-minute Suite block and one 30-minute external event. Both remained visible; only the persisted Suite mapping exposed task controls. A separate probe passed schedule, complete/reopen, move, removal, reschedule, Enter/Space, Escape focus return, and mobile Sheet checks. An offline move failure retained the edited time/duration and left the last successful calendar block unchanged. |
| Planner periods and races          | Day, three-day, and week used Chicago-local boundaries. A held older response released after a newer navigation did not replace the new period. A failed refresh retained only the matching cached period and Retry restored the projection. A fixed browser clock at the November 1 fall-back rendered the repeated 1 AM hour.                                                                                                                           |
| Session recovery                   | Two profiles received controlled valid 403 `CSRF_INVALID` and 401 `AUTH_REQUIRED` responses. The session refresh/password panels retained title, notes, capture mode, and navigation. Normal recovery succeeded; an explicit subsequent capture produced one successful write. Offline capture also survived navigation and synchronized with an acknowledged operation on reconnect.                                                                     |
| Freshness UI                       | A contract-valid Google status fixture displayed a localized last-success timestamp and stale saved-projection state. Injected resync failure preserved that timestamp and state and left retry available. No actual Google account or provider call was involved.                                                                                                                                                                                        |

## Retained artifacts and limits

Local artifacts remain in `output/reliability/`: the root report, queued/outbox
readbacks, reset request/outcome records, command/mobile results, session report,
Planner report, details report, and screenshots. These are development artifacts,
not a production ledger. The first reset fixture omitted the required request ID;
the resulting invalid-response failure was retained and the corrected case passed.
An initial session-route harness attempt allowed two disposable writes; those are
excluded from qualifying evidence. Intermediate build/type errors and the local
lint failure caused by scratch browser scripts are retained separately from the
passing final gate.

Browser network failures, response ordering, clock changes, and Google responses
were controlled injections. They do not prove naturally expired sessions, actual
server retention expiry, live Google behavior, or a production provider outage.
Actual calendar reads/writes used disposable Baikal. Offline `plannedStart`
mutation remains intentionally unsupported; calendar placement requires the
online provider path. Unsupported resource conflicts remain visible for manual
review instead of being silently dismissed. No production image, database,
credential, candidate pin, or soak ledger changed.
