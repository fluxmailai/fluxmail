---
title: 'POST /api/v1/accounts/{accountId}/messages/actions'
description: 'Apply one mailbox action to a batch of messages.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Apply one mailbox action to a batch of messages.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/messages/actions' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "messageIds": [
    "msg_123"
  ],
  "action": "markRead"
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
    "messageIds": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "example": "msg_123"
      },
      "minItems": 1
    },
    "action": {
      "type": "string",
      "enum": [
        "markRead",
        "markUnread",
        "star",
        "unstar",
        "archive",
        "trash",
        "untrash",
        "delete",
        "move",
        "addLabels",
        "removeLabels"
      ]
    },
    "folder": {
      "type": "string",
      "minLength": 1,
      "description": "Required when action is move. Use archive or trash instead of moving to those folders."
    },
    "labels": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "maxItems": 100,
      "description": "Required when action is addLabels or removeLabels. Change Gmail system labels with dedicated actions."
    }
  },
  "required": [
    "messageIds",
    "action"
  ],
  "additionalProperties": false
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Messages modified | `application/json` |
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
        "action": {
          "type": "string"
        },
        "succeededIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "failed": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "messageId": {
                "type": "string"
              },
              "code": {
                "type": "string"
              }
            },
            "required": [
              "messageId",
              "code"
            ],
            "additionalProperties": false
          }
        },
        "uncertainIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "action",
        "succeededIds",
        "failed",
        "uncertainIds"
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
