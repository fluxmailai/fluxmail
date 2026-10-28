---
title: 'DELETE /api/v1/admin/oauth-apps/{provider}'
description: 'Remove a stored OAuth application. Requires admin.accounts.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Remove a stored OAuth application. Requires admin.accounts.

## Authentication

Pass an administrator member session or an API key as a bearer token. The key must belong to an administrator and include the capability listed above.

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

## Request

```bash
curl 'http://localhost:8977/api/v1/admin/oauth-apps/google' \
  -X DELETE \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `provider` | path | Yes | `google` or `outlook` | None |

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
