---
title: 'fluxmail drafts create'
description: 'Create a draft'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail drafts create`

Create a draft

## Usage

```bash
fluxmail drafts create [options]
```

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--from <address>` | No | Send from an available address | None |
| `--to <address>` | No | Add a To recipient; repeat as needed | None |
| `--cc <address>` | No | Add a Cc recipient; repeat as needed | None |
| `--bcc <address>` | No | Add a Bcc recipient; repeat as needed | None |
| `--subject <subject>` | No | Set the subject | None |
| `--body <text>` | No | Set the plain-text body; use blank lines between unwrapped prose paragraphs | None |
| `--body-file <path>` | No | Read the plain-text body from a file; keep prose paragraphs unwrapped | None |
| `--html <html>` | No | Set the HTML body | None |
| `--html-file <path>` | No | Read the HTML body from a file | None |
| `--attach <path>` | No | Attach a local file; repeat as needed | None |
| `--reply-to <message-id>` | No | Reply to a message | None |
| `--reply-all` | No | Include the original recipients in the reply | None |
| `--time-zone <zone>` | No | Date the quoted message in a reply in this IANA time zone, such as America/New_York | None |
| `--no-quote` | No | Leave the original message out of a reply | None |
| `--input <file>` | No | Read an exact REST JSON body from a file, or pass - for stdin | None |
