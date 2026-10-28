---
title: 'GET /api/v1/accounts/{accountId}/scheduled-sends'
description: 'List scheduled messages in an email account.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

List scheduled messages in an email account.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/scheduled-sends' \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Scheduled sends | `application/json` |
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
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "scheduleId": {
            "type": "string"
          },
          "operationId": {
            "type": "string"
          },
          "accountId": {
            "type": "string"
          },
          "draftId": {
            "type": "string"
          },
          "sendAt": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "sending",
              "sent",
              "failed",
              "uncertain",
              "canceled"
            ]
          },
          "attempts": {
            "type": "integer",
            "minimum": 0
          },
          "subject": {
            "type": "string"
          },
          "to": {
            "type": "string"
          },
          "lastError": {
            "type": "string"
          },
          "sentMessageId": {
            "type": "string"
          },
          "sentThreadId": {
            "type": "string"
          }
        },
        "required": [
          "scheduleId",
          "accountId",
          "draftId",
          "sendAt",
          "status",
          "attempts"
        ],
        "additionalProperties": false
      }
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
