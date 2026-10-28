---
title: 'Get a delivery outcome'
description: 'Check whether a send or forward succeeded, failed or has an uncertain outcome. Requires mail.send.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

`GET /api/v1/accounts/{accountId}/delivery-operations/{operationId}`

Check whether a send or forward succeeded, failed or has an uncertain outcome. Requires mail.send.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/delivery-operations/operationId_123' \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `operationId` | path | Yes | `string` | Minimum length: 1. |

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Delivery outcome | `application/json` |
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
        "operationId": {
          "type": "string"
        },
        "accountId": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "send",
            "forward",
            "scheduled"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "sending",
            "succeeded",
            "failed",
            "uncertain"
          ]
        },
        "result": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "threadId": {
              "type": "string"
            },
            "warnings": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "id",
            "threadId"
          ],
          "additionalProperties": false
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string"
            }
          },
          "required": [
            "code"
          ],
          "additionalProperties": false
        },
        "scheduleId": {
          "type": "string"
        }
      },
      "required": [
        "operationId",
        "accountId",
        "kind",
        "status"
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
