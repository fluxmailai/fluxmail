---
title: 'PUT /api/v1/admin/oauth-apps/{provider}'
description: 'Save an OAuth application in encrypted instance settings. Requires admin.accounts.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Save an OAuth application in encrypted instance settings. Requires admin.accounts.

## Authentication

Pass an administrator member session or an API key as a bearer token. The key must belong to an administrator and include the capability listed above.

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

## Request

```bash
curl 'http://localhost:8977/api/v1/admin/oauth-apps/google' \
  -X PUT \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "clientId": "client-id.apps.example.com",
  "clientSecret": "client-secret"
}'
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `provider` | path | Yes | `google` or `outlook` | None |

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "clientId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2048,
      "example": "client-id.apps.example.com"
    },
    "clientSecret": {
      "type": "string",
      "minLength": 1,
      "maxLength": 16384,
      "example": "client-secret"
    },
    "tenantId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2048,
      "example": "common"
    },
    "publicClient": {
      "type": "boolean"
    }
  },
  "required": [
    "clientId"
  ],
  "additionalProperties": false,
  "example": {
    "clientId": "client-id.apps.example.com",
    "clientSecret": "client-secret"
  }
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | OAuth applications | `application/json` |
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
        "google": {
          "type": "object",
          "properties": {
            "clientId": {
              "type": "string"
            },
            "clientSecretConfigured": {
              "type": "boolean"
            },
            "source": {
              "type": "string",
              "enum": [
                "built-in",
                "stored",
                "environment",
                "environment-file"
              ]
            },
            "mutable": {
              "type": "boolean"
            }
          },
          "required": [
            "clientId",
            "clientSecretConfigured",
            "source",
            "mutable"
          ]
        },
        "outlook": {
          "type": "object",
          "properties": {
            "clientId": {
              "type": "string"
            },
            "tenantId": {
              "type": "string"
            },
            "clientSecretConfigured": {
              "type": "boolean"
            },
            "source": {
              "type": "string",
              "enum": [
                "built-in",
                "stored",
                "environment",
                "environment-file"
              ]
            },
            "mutable": {
              "type": "boolean"
            }
          },
          "required": [
            "clientId",
            "tenantId",
            "clientSecretConfigured",
            "source",
            "mutable"
          ]
        }
      },
      "required": [
        "google",
        "outlook"
      ]
    }
  },
  "required": [
    "data"
  ],
  "additionalProperties": false
}
```

</details>
