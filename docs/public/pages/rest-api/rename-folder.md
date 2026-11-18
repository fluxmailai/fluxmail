---
title: 'PATCH /api/v1/accounts/{accountId}/folders/{folderId}'
description: 'Rename a folder. Give the new name on its own, without the parent path: the folder stays under the same parent and keeps its messages and subfolders. The new name must not be one another folder has. In Gmail, where the folder is a label, the labels nested under it are renamed to match. System folders such as Inbox, Sent and Trash can''t be renamed, and neither can a folder the account settings use as one. In an IMAP mailbox, the folder and its subfolders get new IDs. Message IDs normally stay the same. If one stops working, list the folder again.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Rename a folder. Give the new name on its own, without the parent path: the folder stays under the same parent and keeps its messages and subfolders. The new name must not be one another folder has. In Gmail, where the folder is a label, the labels nested under it are renamed to match. System folders such as Inbox, Sent and Trash can't be renamed, and neither can a folder the account settings use as one. In an IMAP mailbox, the folder and its subfolders get new IDs. Message IDs normally stay the same. If one stops working, list the folder again.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/folders/Receipts' \
  -X PATCH \
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
| `folderId` | path | Yes | `string` | Folder ID from the folder list, or the folder name. URL-encode it, since folder IDs can contain a slash. Minimum length: 1. |

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
      "description": "New name for the folder itself, without its parent path. For Projects/2025, send 2026 to get Projects/2026."
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
| `200` | The folder as it is listed now, and as it was listed before | `application/json` |
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
        "folder": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "name"
          ],
          "additionalProperties": false
        },
        "previous": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "name"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "folder",
        "previous"
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
