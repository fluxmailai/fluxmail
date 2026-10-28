---
title: 'Preview a send'
description: 'Resolve the sender, recipients and attachments without sending mail. Requires mail.send, plus mail.drafts for an existing draft or mail.read for a reply.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

`POST /api/v1/accounts/{accountId}/send/preview`

Resolve the sender, recipients and attachments without sending mail. Requires mail.send, plus mail.drafts for an existing draft or mail.read for a reply.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/send/preview' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "draftId": "draft_123"
}'
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "draftId": {
          "type": "string",
          "minLength": 1,
          "example": "draft_123"
        },
        "sendAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "draftId"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "format": "email"
        },
        "to": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "format": "email"
              },
              "name": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "email"
            ],
            "additionalProperties": false
          }
        },
        "cc": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "format": "email"
              },
              "name": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "email"
            ],
            "additionalProperties": false
          }
        },
        "bcc": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "format": "email"
              },
              "name": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "email"
            ],
            "additionalProperties": false
          }
        },
        "subject": {
          "type": "string"
        },
        "body": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string",
              "description": "Plain-text body. Line breaks appear in the sent email. Keep each prose paragraph on one continuous line and separate paragraphs with blank lines."
            },
            "html": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "replyToMessageId": {
          "type": "string",
          "minLength": 1,
          "example": "msg_123"
        },
        "replyAll": {
          "type": "boolean",
          "description": "Requires replyToMessageId when true."
        },
        "attachments": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "filename": {
                "type": "string",
                "minLength": 1
              },
              "mimeType": {
                "type": "string",
                "minLength": 1
              },
              "content": {
                "type": "string",
                "format": "byte",
                "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
                "description": "Base64-encoded content"
              },
              "contentId": {
                "type": "string",
                "minLength": 1
              },
              "disposition": {
                "type": "string",
                "enum": [
                  "inline",
                  "attachment"
                ]
              }
            },
            "required": [
              "filename",
              "mimeType",
              "content"
            ],
            "additionalProperties": false
          }
        },
        "sendAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "body"
      ],
      "additionalProperties": false
    }
  ]
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Resolved send details | `application/json` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Permission or plan denied | `application/json` |
| `404` | Resource not found | `application/json` |
| `409` | Request conflict | `application/json` |
| `422` | Unsupported capability | `application/json` |
| `429` | Provider rate limit | `application/json` |
| `500` | Internal error | `application/json` |
| `503` | Provider unavailable | `application/json` |

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
        "accountId": {
          "type": "string"
        },
        "from": {
          "type": "string"
        },
        "to": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "format": "email"
              },
              "name": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "email"
            ],
            "additionalProperties": false
          }
        },
        "cc": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "format": "email"
              },
              "name": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "email"
            ],
            "additionalProperties": false
          }
        },
        "bcc": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "format": "email"
              },
              "name": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "email"
            ],
            "additionalProperties": false
          }
        },
        "subject": {
          "type": "string"
        },
        "attachments": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "filename": {
                "type": "string"
              },
              "mimeType": {
                "type": "string"
              },
              "sizeBytes": {
                "type": "integer"
              }
            },
            "required": [
              "filename",
              "mimeType",
              "sizeBytes"
            ],
            "additionalProperties": false
          }
        },
        "bodyTextChars": {
          "type": "integer"
        },
        "bodyHtmlChars": {
          "type": "integer"
        }
      },
      "required": [
        "accountId",
        "from",
        "to",
        "cc",
        "bcc",
        "subject",
        "attachments",
        "bodyTextChars",
        "bodyHtmlChars"
      ],
      "additionalProperties": false
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string"
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
