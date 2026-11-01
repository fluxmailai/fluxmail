---
title: 'PUT /api/v1/me/password'
description: 'Change your password and revoke your other sessions and OAuth connections.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Change your password and revoke your other sessions and OAuth connections.

## Authentication

Pass a Fluxmail member session as a bearer token. API keys cannot use this endpoint.

## Request

```bash
curl 'http://localhost:8977/api/v1/me/password' \
  -X PUT \
  -H "Authorization: Bearer $FLUXMAIL_SESSION" \
  -H "Content-Type: application/json" \
  --data '{
  "currentPassword": "string",
  "newPassword": "string"
}'
```

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "currentPassword": {
      "type": "string"
    },
    "newPassword": {
      "type": "string"
    }
  },
  "required": [
    "currentPassword",
    "newPassword"
  ],
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
