---
title: 'POST /api/v1/me/api-keys'
description: 'Create an API key for yourself and return its secret once.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Create an API key for yourself and return its secret once.

## Authentication

Pass a Fluxmail member session as a bearer token. API keys cannot use this endpoint.

## Request

```bash
curl 'http://localhost:8977/api/v1/me/api-keys' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_SESSION" \
  -H "Content-Type: application/json" \
  --data '{
  "name": "string"
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
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "permissionProfile": {
      "type": "string",
      "enum": [
        "read-only",
        "read-write",
        "full"
      ]
    },
    "capabilities": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "mail.read",
          "mail.drafts",
          "mail.organize",
          "mail.trash",
          "mail.delete",
          "mail.send",
          "admin.accounts",
          "admin.members",
          "admin.api_keys",
          "admin.license",
          "admin.audit"
        ]
      },
      "minItems": 1,
      "maxItems": 11
    },
    "supplementalCapabilities": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "admin.accounts",
          "admin.members",
          "admin.api_keys",
          "admin.license",
          "admin.audit"
        ]
      },
      "maxItems": 5
    },
    "accountIds": {
      "type": "array",
      "nullable": true,
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "name"
  ],
  "additionalProperties": false
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Success | `application/json` |
| `201` | Success | `application/json` |
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

### 201 response

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
