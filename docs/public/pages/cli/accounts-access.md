---
title: 'fluxmail accounts access'
description: 'Set who can access a mailbox you own'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail accounts access`

Set who can access a mailbox you own

## Usage

```bash
fluxmail accounts access <accountId> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `accountId` | Yes | None | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--owner-only` | No | Only the owner can access the mailbox | None |
| `--shared` | No | Share the mailbox with every member | None |
| `--share-with <member>` | No | Replace selected access with this member; repeat as needed | None |
