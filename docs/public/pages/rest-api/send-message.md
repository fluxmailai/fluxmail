---
title: 'POST /api/v1/accounts/{accountId}/send'
description: 'Send a message now or schedule it for a specified time.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Send a message now or schedule it for a specified time.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/send' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  --data '{
  "draftId": "draft_123"
}'
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `Idempotency-Key` | header | Yes | `string` | A unique key for one intended delivery. Reuse it when retrying the same request. Minimum length: 1. Maximum length: 255. Pattern: `^[\x21-\x7e]+$`. |

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

## Safe retries

Fluxmail scopes each delivery key to the authenticated credential. Delivery operations and their keys have no automatic expiry.

- Repeating a request with the same key and request data returns the stored delivery operation. It does not send again.
- Reusing the key with different request data returns `409 idempotency_conflict`.
- An `uncertain` operation may have been delivered. Fluxmail does not retry it automatically.

Save the key with the request and reuse it if the response is lost. Look up the operation status before taking further action. For an `uncertain` result, check the Sent folder or recipient before creating a new delivery request.

REST keys created before the delivery-operation upgrade keep their original 24 hour lifetime. A retry with one of those keys may return the legacy response shape and `Idempotency-Replayed: true`.

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Delivery operation | `application/json` |
| `202` | Message scheduled | `application/json` |
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
        "operationId": {
          "type": "string"
        },
        "accountId": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "send",
            "forward",
            "scheduled"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "sending",
            "succeeded",
            "failed",
            "uncertain"
          ]
        },
        "result": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "threadId": {
              "type": "string"
            },
            "warnings": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "id",
            "threadId"
          ],
          "additionalProperties": false
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string"
            }
          },
          "required": [
            "code"
          ],
          "additionalProperties": false
        },
        "scheduleId": {
          "type": "string"
        }
      },
      "required": [
        "operationId",
        "accountId",
        "kind",
        "status"
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

### 202 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "operationId": {
          "type": "string"
        },
        "accountId": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "send",
            "forward",
            "scheduled"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "sending",
            "succeeded",
            "failed",
            "uncertain"
          ]
        },
        "result": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "threadId": {
              "type": "string"
            },
            "warnings": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "id",
            "threadId"
          ],
          "additionalProperties": false
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string"
            }
          },
          "required": [
            "code"
          ],
          "additionalProperties": false
        },
        "scheduleId": {
          "type": "string"
        }
      },
      "required": [
        "operationId",
        "accountId",
        "kind",
        "status"
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
