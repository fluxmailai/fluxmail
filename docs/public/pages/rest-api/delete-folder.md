---
title: 'DELETE /api/v1/accounts/{accountId}/folders/{folderId}'
description: 'Delete a folder that has no messages and no subfolders. Move or trash its mail, and delete its subfolders, first. In Gmail, where the folder is a label, remove the label from its messages. System folders such as Inbox, Sent and Trash can''t be deleted, and neither can a folder the account settings use as one. In Outlook, the deleted folder moves to Deleted Items.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Delete a folder that has no messages and no subfolders. Move or trash its mail, and delete its subfolders, first. In Gmail, where the folder is a label, remove the label from its messages. System folders such as Inbox, Sent and Trash can't be deleted, and neither can a folder the account settings use as one. In Outlook, the deleted folder moves to Deleted Items.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/folders/Receipts' \
  -X DELETE \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `folderId` | path | Yes | `string` | Folder ID from the folder list, or the folder name. URL-encode it, since folder IDs can contain a slash. Minimum length: 1. |

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | The deleted folder | `application/json` |
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
        "deleted": {
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
        "deleted"
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
