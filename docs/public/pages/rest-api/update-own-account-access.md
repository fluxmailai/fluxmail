---
title: 'PATCH /api/v1/accounts/{accountId}/access'
description: 'Share a mailbox you own with every member or with selected members, make it private, or hand it to another member.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Share a mailbox you own with every member or with selected members, make it private, or hand it to another member.

## Authentication

Pass a Fluxmail member session as a bearer token. API keys cannot use this endpoint.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/access' \
  -X PATCH \
  -H "Authorization: Bearer $FLUXMAIL_SESSION" \
  -H "Content-Type: application/json" \
  --data '{}'
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
    "ownerMemberId": {
      "type": "string"
    },
    "sharedWithAll": {
      "type": "boolean"
    },
    "grantedMemberIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 100
    }
  },
  "additionalProperties": false
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Success | `application/json` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Permission denied | `application/json` |
| `404` | Not found | `application/json` |
| `409` | Conflict | `application/json` |
| `413` | Request body too large | `application/json` |
| `429` | Too many attempts | `application/json` |

### 200 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "nullable": true
    }
  },
  "additionalProperties": {
    "nullable": true
  }
}
```

</details>
