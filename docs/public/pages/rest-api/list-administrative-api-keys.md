---
title: 'GET /api/v1/admin/api-keys'
description: 'List API key metadata without returning plaintext secrets. Requires admin.api_keys.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

List API key metadata without returning plaintext secrets. Requires admin.api_keys.

## Authentication

Pass an administrator member session or an API key as a bearer token. The key must belong to an administrator and include the capability listed above.

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

## Request

```bash
curl 'http://localhost:8977/api/v1/admin/api-keys' \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

This endpoint has no parameters or request body.

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | API keys | `application/json` |
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
      "type": "array",
      "items": {
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
    }
  },
  "required": [
    "data"
  ]
}
```

</details>
