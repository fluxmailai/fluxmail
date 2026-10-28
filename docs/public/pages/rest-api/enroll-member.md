---
title: 'Enroll a member'
description: 'Set your first password with an enrollment code and receive a member session.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

`POST /api/v1/auth/enroll`

Set your first password with an enrollment code and receive a member session.

## Authentication

This endpoint does not require authentication.

## Request

```bash
curl 'http://localhost:8977/api/v1/auth/enroll' \
  -X POST \
  -H "Content-Type: application/json" \
  --data '{
  "token": "string",
  "password": "string",
  "deviceName": "string"
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
    "token": {
      "type": "string",
      "minLength": 1
    },
    "password": {
      "type": "string"
    },
    "deviceName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "token",
    "password",
    "deviceName"
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
  }
}
```

</details>
