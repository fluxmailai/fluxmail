---
title: 'DELETE /api/v1/accounts/{accountId}/labels/{labelId}'
description: 'Delete a Gmail label or an Outlook category. In Gmail, the label is removed from its messages, which stay in the account, and a label with nested labels can''t be deleted until they are. Gmail system labels such as Inbox and Starred can''t be deleted.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Delete a Gmail label or an Outlook category. In Gmail, the label is removed from its messages, which stay in the account, and a label with nested labels can't be deleted until they are. Gmail system labels such as Inbox and Starred can't be deleted.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/labels/Receipts' \
  -X DELETE \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `labelId` | path | Yes | `string` | Label ID from the label list, or the label name. URL-encode it, since label names can contain a slash. Minimum length: 1. |

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | The deleted label | `application/json` |
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
