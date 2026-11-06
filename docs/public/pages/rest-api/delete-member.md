---
title: 'DELETE /api/v1/admin/members/{memberId}'
description: 'Remove a member permanently. Their mailboxes go to the member named in reassignTo; without it, they must own no mailboxes. Their API keys, and keys they created for others, are revoked. Requires admin.members.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Remove a member permanently. Their mailboxes go to the member named in reassignTo; without it, they must own no mailboxes. Their API keys, and keys they created for others, are revoked. Requires admin.members.

## Authentication

Pass an administrator member session or an API key as a bearer token. The key must belong to an administrator and include the capability listed above.

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

## Request

```bash
curl 'http://localhost:8977/api/v1/admin/members/memberId_123' \
  -X DELETE \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `memberId` | path | Yes | `string` | Minimum length: 1. |
| `reassignTo` | query | No | `string` | Minimum length: 1. Maximum length: 320. |

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
