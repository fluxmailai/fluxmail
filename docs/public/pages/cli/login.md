---
title: 'fluxmail login'
description: 'Log in to a local or remote instance, or to Fluxmail Cloud'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail login`

Log in to a local or remote instance, or to Fluxmail Cloud

## Usage

```bash
fluxmail login [options]
```

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--server <url>` | No | Add or update a remote instance | None |
| `--email <email>` | No | Member email | None |
| `--enroll` | No | Use a one-time enrollment code | None |
| `--reset` | No | Use a one-time password reset code | None |
| `--cloud` | No | Log in to Fluxmail Cloud in a browser | None |
| `--api-key` | No | With --cloud, use a Cloud API key instead of a browser | None |
| `--profile <profile>` | No | With --cloud, the permissions to request: read-only, read-write, or full | None |
