---
title: 'POST /api/v1/accounts/{accountId}/labels'
description: 'Create a Gmail label or an Outlook category, or return the existing one with that name. In Gmail, a name such as Projects/2026 creates a nested label and any missing parent labels, and the label also works as a folder. A new Outlook category has no color. IMAP accounts don''t have labels.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Create a Gmail label or an Outlook category, or return the existing one with that name. In Gmail, a name such as Projects/2026 creates a nested label and any missing parent labels, and the label also works as a folder. A new Outlook category has no color. IMAP accounts don't have labels.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/labels' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "name": "string"
}'
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
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "Label or category name. For a nested Gmail label, give the full path, such as Projects/2026."
    }
  },
  "required": [
    "name"
  ],
  "additionalProperties": false
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | The new label, or the existing label with that name | `application/json` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Permission or plan denied | `application/json` |
| `404` | Resource not found | `application/json` |
| `409` | Request conflict | `application/json` |
| `422` | Unsupported capability | `application/json` |
| `429` | Provider rate limit | `application/json` |
| `500` | Internal error | `application/json` |
| `503` | Provider unavailable | `application/json` |

### 200 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "color": {
          "type": "object",
          "properties": {
            "background": {
              "type": "string"
            },
            "text": {
              "type": "string"
            },
            "preset": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      },
      "required": [
        "id",
        "name"
      ],
      "additionalProperties": false
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string"
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
