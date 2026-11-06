---
title: 'fluxmail members remove'
description: 'Remove a member, handing their mailboxes to another member'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail members remove`

Remove a member, handing their mailboxes to another member

## Usage

```bash
fluxmail members remove <memberId> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `memberId` | Yes | None | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--reassign-to <member>` | No | Member id or email to receive the removed member's mailboxes | None |
