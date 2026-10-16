---
title: "Upgrade Fluxmail"
description: "Back up an installation, check client compatibility, and verify an upgrade."
updated: '2026-10-16'
---

Before upgrading, check the release notes and the version-specific [upgrade guides](/docs/upgrades/0.15.0). Apply every relevant migration guide between your current version and the target version. Clients may need updates before the server, especially when response formats change.

## 1. Record the current installation

Record your installed package version or Docker image digest, deployment configuration, and data paths. Choose the target release explicitly so you can reproduce the upgrade.

Check for pending scheduled sends and plan the interruption. Sends missed during downtime can run when the server starts again.

## 2. Back up before changing versions

Stop all processes sharing the data directory and [back up the complete installation](/docs/backup-and-restore). Include the matching encryption key and external secrets. Keep the backup outside the data volume you are upgrading.

A database migration can make the store unreadable by an older release. Downgrading the executable or image alone may not restore the previous service.

## 3. Install the target release

For a global installation, replace `<version>` with the release you selected:

```bash
npm install -g fluxmail@<version>
```

For Docker, set the selected release tag or digest in the Compose `image` field, then pull and recreate the service:

```bash
docker compose pull fluxmail
docker compose up -d fluxmail
```

Keep the existing data volume mounted. For local stdio, restart each MCP client so it launches the updated executable. For a local HTTP installation, restart the server.

Stdio connections started without `--profile` or `--allow` are now read-only. If a client drafts, organizes, or sends mail, add the [permission profile](/docs/permissions) it needs to its arguments before restarting it. New API keys default to `read-only`. Existing keys keep their profiles, but keys using `full` lose permanent deletion as described below. Custom policies keep their explicit capability grants.

The `full` profile no longer includes permanent deletion. This applies to existing keys and stdio clients that use `full`. If a client needs to permanently delete messages, add `--allow mail.delete` to its `--profile full` options. For an API key, run `fluxmail apikey permissions <key-id> --profile full --allow mail.delete`.

Scheduled delivery now belongs to `serve` or `scheduled run`. Stdio-only installations must start a persistent worker using the same data directory as their MCP clients. See [Keep scheduled delivery running](/docs/sending-and-retries#keep-scheduled-delivery-running). Remote HTTP and standard Docker installations already run the worker through `serve`.

This change migrates the SQLite store to format 6 to persist retry deadlines. Stop every process sharing the store before the first upgraded process opens it. Existing schedules and delivery records are retained. Existing retry delays cannot be reconstructed, so due schedules may be eligible immediately; subsequent retry delays survive restarts. Queued mail remains stored, and overdue mail may send when a worker starts. Rollback requires the matching pre-upgrade backup.

## 4. Verify the upgrade

```bash
fluxmail status
fluxmail accounts list
fluxmail --mail-account <account-id> folders list
```

For Docker, prefix each command with `docker compose exec fluxmail`. Then check your MCP or REST client using its own credentials. Verify that the selected mailboxes and permissions still match the client's intended access. Do not send a test email just to check connectivity.

Keep the backup until these checks pass. If startup fails, inspect [Local logs](/docs/logging) and the upgrade guide for your target release.

## If you need to roll back

Stop the new version, preserve its current data for diagnosis, and [restore the complete pre-upgrade backup](/docs/backup-and-restore) with the matching older release. Do not point an older binary at a migrated store.

A restore loses local changes since the backup. It does not undo mail already sent or changed at the provider. Review delivery and scheduling state before resuming work to avoid repeating an action.
