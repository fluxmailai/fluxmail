---
title: 'POST /api/v1/accounts/{accountId}/folders'
description: 'Create a folder in an email account, or return the existing folder with that name. In Gmail, the folder is a label. System folder names, including Inbox, Sent and Trash, are rejected.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Create a folder in an email account, or return the existing folder with that name. In Gmail, the folder is a label. System folder names, including Inbox, Sent and Trash, are rejected.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/folders' \
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
      "description": "Folder name, or the full path of a subfolder with the separator the account uses in its folder names, such as Projects/2026. Missing parent folders are created too."
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
| `200` | The new folder, or the existing folder with that name | `application/json` |
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
        "role": {
          "type": "string",
          "enum": [
            "inbox",
            "sent",
            "drafts",
            "trash",
            "spam",
            "archive",
            "starred",
            "all"
          ]
        },
        "roleSource": {
          "type": "string",
          "enum": [
            "user",
            "extension",
            "name"
          ]
        },
        "unreadCount": {
          "type": "integer",
          "minimum": 0
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
