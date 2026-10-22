---
title: 'fluxmail connections accounts'
description: 'Change the mailboxes one of your OAuth connections can use'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail connections accounts`

Change the mailboxes one of your OAuth connections can use

## Usage

```bash
fluxmail connections accounts <connectionId> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `connectionId` | Yes | None | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--account <account>` | No | Replace the allowlist with this mailbox; repeat as needed | None |
| `--all-accounts` | No | Allow every mailbox available to you, including later ones | None |
