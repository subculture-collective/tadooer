# Release channels

`candidate.example.json` documents the manifest shape only; its zero digest is
not qualified or promotable production evidence. A release operator creates a
candidate containing the exact Git revision, OCI `sha256:` digest, packaged
desktop artifact, and qualification timestamp after `pnpm verify:phase8`.

Promote and roll back channel pointers explicitly:

```bash
node deploy/release-channel.mjs promote /absolute/candidate.json /absolute/channel-state
node deploy/release-channel.mjs rollback /absolute/channel-state/history/<manifest>.json /absolute/channel-state
```

The channel directory is deployment state, not source. Promotion archives the
previous stable manifest; rollback archives the current manifest before
selecting an earlier qualified artifact. Database rollback, when required,
uses `deploy/restore-stack.sh` with a separately selected coherent backup.
