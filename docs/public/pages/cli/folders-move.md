---
title: 'fluxmail folders move'
description: 'Move a folder under another folder, or to the top level, in an email account'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail folders move`

Move a folder under another folder, or to the top level, in an email account

## Usage

```bash
fluxmail folders move <folder> [parent] [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `folder` | Yes | Folder ID from folders list, or the folder name | None |
| `parent` | No | ID or name of the folder to move it under | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--top-level` | No | Move the folder to the top level instead of under another folder | None |
