---
title: 'fluxmail stdio'
description: 'Run as a stdio MCP server (for Claude Desktop / Claude Code local config)'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail stdio`

Run as a stdio MCP server (for Claude Desktop / Claude Code local config)

## Usage

```bash
fluxmail stdio [options]
```

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--account <account>` | No | Limit access to one mailbox; repeat as needed | None |
| `--profile <profile>` | No | Tool profile: read-only, read-write, full | None |
| `--allow <capability>` | No | Allow one MCP capability, or add it to --profile; repeat as needed | None |
| `--attachment-dir <path>` | No | Folder MCP tools attach files from and save attachments to (default: attachments in the data directory) | None |
| `--no-attachment-dir` | No | Turn off attaching files from and saving attachments to a folder | None |
