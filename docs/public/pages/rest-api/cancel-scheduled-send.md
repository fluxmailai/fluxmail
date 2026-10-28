---
title: 'DELETE /api/v1/accounts/{accountId}/scheduled-sends/{scheduleId}'
description: 'Cancel a pending scheduled send and keep its provider draft.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Cancel a pending scheduled send and keep its provider draft.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/scheduled-sends/schedule_123' \
  -X DELETE \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `scheduleId` | path | Yes | `string` | Minimum length: 1. |

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Scheduled send canceled | `application/json` |
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
        "scheduleId": {
          "type": "string"
        },
        "draftId": {
          "type": "string"
        },
        "draftKept": {
          "type": "boolean",
          "enum": [
            true
          ]
        }
      },
      "required": [
        "scheduleId",
        "draftId",
        "draftKept"
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
