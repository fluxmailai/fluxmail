---
title: 'POST /api/v1/admin/connections'
description: 'Create or reauthorize a Gmail, Outlook, or IMAP connection. Requires admin.accounts.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Create or reauthorize a Gmail, Outlook, or IMAP connection. Requires admin.accounts.

## Authentication

Pass an administrator member session or an API key as a bearer token. The key must belong to an administrator and include the capability listed above.

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

## Request

```bash
curl 'http://localhost:8977/api/v1/admin/connections' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "provider": "gmail",
  "ownerMemberId": "you@example.com"
}'
```

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "gmail"
          ]
        },
        "ownerMemberId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "reauthorizeAccountId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "sharedWithAll": {
          "type": "boolean"
        },
        "grantedMemberIds": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "maxItems": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "outlook"
          ]
        },
        "ownerMemberId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "reauthorizeAccountId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "sharedWithAll": {
          "type": "boolean"
        },
        "grantedMemberIds": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "maxItems": 100
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "enum": [
            "imap"
          ]
        },
        "ownerMemberId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "reauthorizeAccountId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "sharedWithAll": {
          "type": "boolean"
        },
        "grantedMemberIds": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "maxItems": 100
        },
        "email": {
          "type": "string",
          "maxLength": 320,
          "format": "email"
        },
        "displayName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "imap": {
          "type": "object",
          "properties": {
            "host": {
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "port": {
              "type": "integer",
              "minimum": 1,
              "maximum": 65535
            },
            "security": {
              "type": "string",
              "enum": [
                "tls",
                "starttls"
              ]
            },
            "user": {
              "type": "string",
              "minLength": 1,
              "maxLength": 320
            },
            "password": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            }
          },
          "required": [
            "host",
            "port",
            "security",
            "user",
            "password"
          ],
          "additionalProperties": false
        },
        "smtp": {
          "type": "object",
          "properties": {
            "host": {
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "port": {
              "type": "integer",
              "minimum": 1,
              "maximum": 65535
            },
            "security": {
              "type": "string",
              "enum": [
                "tls",
                "starttls"
              ]
            },
            "user": {
              "type": "string",
              "minLength": 1,
              "maxLength": 320
            },
            "password": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            }
          },
          "required": [
            "host",
            "port",
            "security",
            "user",
            "password"
          ],
          "additionalProperties": false
        },
        "saveSent": {
          "type": "boolean"
        },
        "folderOverrides": {
          "type": "object",
          "properties": {
            "sent": {
              "type": "string",
              "minLength": 1,
              "maxLength": 1024
            },
            "drafts": {
              "type": "string",
              "minLength": 1,
              "maxLength": 1024
            },
            "trash": {
              "type": "string",
              "minLength": 1,
              "maxLength": 1024
            },
            "archive": {
              "type": "string",
              "minLength": 1,
              "maxLength": 1024
            },
            "spam": {
              "type": "string",
              "minLength": 1,
              "maxLength": 1024
            }
          },
          "additionalProperties": false
        }
      },
      "required": [
        "provider",
        "email",
        "imap",
        "smtp"
      ],
      "additionalProperties": false
    }
  ],
  "example": {
    "provider": "gmail",
    "ownerMemberId": "you@example.com"
  }
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `201` | Connection prepared or saved | `application/json` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Administrative access denied | `application/json` |
| `404` | Resource not found | `application/json` |
| `409` | Request conflict | `application/json` |
| `413` | Request body too large | `application/json` |
| `415` | Unsupported media type | `application/json` |
| `500` | Internal error | `application/json` |
| `502` | License could not be verified | `application/json` |

### 201 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "additionalProperties": {
        "nullable": true
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
