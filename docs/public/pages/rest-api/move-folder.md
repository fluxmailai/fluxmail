---
title: 'POST /api/v1/accounts/{accountId}/folders/{folderId}/move'
description: 'Move a folder under another folder, or to the top level of the account. The folder keeps its own name, its messages and its subfolders. Send either `parent` or `topLevel: true`, not both. The destination can''t be the folder itself, one of its subfolders, or the trash, and it can''t already hold a folder with the same name. In Gmail, where the folder is a label, the labels nested under it move with it. System folders such as Inbox, Sent and Trash can''t be moved, and neither can a folder the account settings use as one. In an IMAP mailbox, the folder and its subfolders get new IDs. Message IDs normally stay the same. If one stops working, list the folder again.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Move a folder under another folder, or to the top level of the account. The folder keeps its own name, its messages and its subfolders. Send either `parent` or `topLevel: true`, not both. The destination can't be the folder itself, one of its subfolders, or the trash, and it can't already hold a folder with the same name. In Gmail, where the folder is a label, the labels nested under it move with it. System folders such as Inbox, Sent and Trash can't be moved, and neither can a folder the account settings use as one. In an IMAP mailbox, the folder and its subfolders get new IDs. Message IDs normally stay the same. If one stops working, list the folder again.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/folders/Receipts/move' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{}'
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
    "parent": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "ID or name of the folder to move it under. Leave out when topLevel is true."
    },
    "topLevel": {
      "type": "boolean",
      "description": "Set to true to move the folder to the top level of the account. Leave out when parent is given."
    }
  },
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
