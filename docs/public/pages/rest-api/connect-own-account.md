---
title: 'Connect or reauthorize a mailbox account'
description: 'Connect a Gmail, Outlook or IMAP mailbox, or reauthorize an existing mailbox you own or administer.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

`POST /api/v1/accounts/connections`

Connect a Gmail, Outlook or IMAP mailbox, or reauthorize an existing mailbox you own or administer.

## Authentication

Pass a Fluxmail member session as a bearer token. API keys cannot use this endpoint.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/connections' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_SESSION" \
  -H "Content-Type: application/json" \
  --data '{
  "provider": "gmail"
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
    "provider": {
      "type": "string",
      "enum": [
        "gmail",
        "outlook",
        "imap"
      ]
    },
    "reauthorizeAccountId": {
      "type": "string"
    },
    "email": {
      "type": "string",
      "format": "email"
    },
    "displayName": {
      "type": "string"
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
    "provider"
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
| `422` | Unsupported capability | `application/json` |
| `429` | Too many attempts | `application/json` |
| `503` | Provider unavailable | `application/json` |

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
  }
}
```

</details>
