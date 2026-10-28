---
title: 'Update an API key'
description: 'Update the permissions or mailbox scope of an API key. Requires admin.api_keys.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

`PATCH /api/v1/admin/api-keys/{keyId}`

Update the permissions or mailbox scope of an API key. Requires admin.api_keys.

## Authentication

Pass an administrator member session or an API key as a bearer token. The key must belong to an administrator and include the capability listed above.

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

## Request

```bash
curl 'http://localhost:8977/api/v1/admin/api-keys/keyId_123' \
  -X PATCH \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "permissionProfile": "read-only"
}'
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `keyId` | path | Yes | `string` | Minimum length: 1. Maximum length: 200. |

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "permissionProfile": {
      "type": "string",
      "enum": [
        "read-only",
        "read-write",
        "full"
      ]
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
    "customCapabilities": {
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
    "accounts": {
      "type": "array",
      "nullable": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "maxItems": 100
    }
  },
  "additionalProperties": false,
  "example": {
    "permissionProfile": "read-only"
  }
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Updated API key | `application/json` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Administrative access denied | `application/json` |
| `404` | Resource not found | `application/json` |
| `409` | Request conflict | `application/json` |
| `413` | Request body too large | `application/json` |
| `415` | Unsupported media type | `application/json` |
| `500` | Internal error | `application/json` |
| `502` | License could not be verified | `application/json` |

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
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "createdAt": {
          "type": "string"
        },
        "lastUsedAt": {
          "type": "string",
          "nullable": true
        },
        "memberId": {
          "type": "string"
        },
        "permissionProfile": {
          "type": "string",
          "enum": [
            "read-only",
            "read-write",
            "full",
            "custom"
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
          }
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
          }
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
        "id",
        "name",
        "createdAt",
        "lastUsedAt",
        "memberId",
        "permissionProfile",
        "capabilities",
        "supplementalCapabilities",
        "accountIds"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "data"
  ]
}
```

</details>
