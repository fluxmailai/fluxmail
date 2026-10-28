---
title: 'Update IMAP folders'
description: 'Update the folder overrides for an IMAP account. Requires admin.accounts.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

`PATCH /api/v1/admin/accounts/{accountId}/imap/folders`

Update the folder overrides for an IMAP account. Requires admin.accounts.

## Authentication

Pass an administrator member session or an API key as a bearer token. The key must belong to an administrator and include the capability listed above.

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

## Request

```bash
curl 'http://localhost:8977/api/v1/admin/accounts/acct_123/imap/folders' \
  -X PATCH \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "sent": "Sent"
}'
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. Maximum length: 200. |

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
  "additionalProperties": false,
  "example": {
    "sent": "Sent"
  }
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Updated folder overrides | `application/json` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Administrative access denied | `application/json` |
| `404` | Resource not found | `application/json` |
| `409` | Request conflict | `application/json` |
| `413` | Request body too large | `application/json` |
| `415` | Unsupported media type | `application/json` |
| `500` | Internal error | `application/json` |
| `502` | License could not be verified | `application/json` |

### 200 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "additionalProperties": {
        "nullable": true
      }
    }
  },
  "required": [
    "data"
  ],
  "additionalProperties": false
}
```

</details>
