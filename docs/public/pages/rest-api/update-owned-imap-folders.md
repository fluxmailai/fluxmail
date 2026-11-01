---
title: 'PATCH /api/v1/accounts/{accountId}/imap/folders'
description: 'Update special-folder overrides for an IMAP mailbox you own or administer.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Update special-folder overrides for an IMAP mailbox you own or administer.

## Authentication

Pass a Fluxmail member session as a bearer token. API keys cannot use this endpoint.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/imap/folders' \
  -X PATCH \
  -H "Authorization: Bearer $FLUXMAIL_SESSION" \
  -H "Content-Type: application/json" \
  --data '{}'
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "sent": {
      "type": "string",
      "nullable": true,
      "minLength": 1,
      "maxLength": 1024
    },
    "drafts": {
      "type": "string",
      "nullable": true,
      "minLength": 1,
      "maxLength": 1024
    },
    "trash": {
      "type": "string",
      "nullable": true,
      "minLength": 1,
      "maxLength": 1024
    },
    "archive": {
      "type": "string",
      "nullable": true,
      "minLength": 1,
      "maxLength": 1024
    },
    "spam": {
      "type": "string",
      "nullable": true,
      "minLength": 1,
      "maxLength": 1024
    }
  },
  "additionalProperties": false
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Success | `application/json` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Permission denied | `application/json` |
| `404` | Not found | `application/json` |
| `409` | Conflict | `application/json` |
| `413` | Request body too large | `application/json` |
| `422` | Unsupported capability | `application/json` |
| `429` | Too many attempts | `application/json` |
| `503` | Provider unavailable | `application/json` |

### 200 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "nullable": true
    }
  },
  "additionalProperties": {
    "nullable": true
  }
}
```

</details>
