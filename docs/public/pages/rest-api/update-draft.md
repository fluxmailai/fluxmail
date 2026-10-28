---
title: 'PUT /api/v1/accounts/{accountId}/drafts/{draftId}'
description: 'Replace the full content of an existing draft.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Replace the full content of an existing draft.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/drafts/draft_123' \
  -X PUT \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "body": {}
}'
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `draftId` | path | Yes | `string` | Minimum length: 1. |

### Request body

Content type: `application/json`

<details>
<summary>JSON schema</summary>

```json
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
    }
  },
  "required": [
    "body"
  ],
  "additionalProperties": false
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Draft replaced | `application/json` |
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
        "id": {
          "type": "string"
        },
        "threadId": {
          "type": "string"
        },
        "accountId": {
          "type": "string"
        },
        "draftId": {
          "type": "string"
        },
        "folder": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "role": {
              "type": "string",
              "enum": [
                "inbox",
                "sent",
                "drafts",
                "trash",
                "spam",
                "archive",
                "starred",
                "all"
              ]
            },
            "roleSource": {
              "type": "string",
              "enum": [
                "user",
                "extension",
                "name"
              ]
            },
            "unreadCount": {
              "type": "integer",
              "minimum": 0
            }
          },
          "required": [
            "id",
            "name"
          ],
          "additionalProperties": false
        },
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "from": {
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
        "replyTo": {
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
        "date": {
          "type": "string"
        },
        "snippet": {
          "type": "string"
        },
        "searchContext": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "string",
                  "enum": [
                    "matched"
                  ]
                },
                "excerpt": {
                  "type": "string"
                }
              },
              "required": [
                "status",
                "excerpt"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "string",
                  "enum": [
                    "no_literal_match",
                    "scan_limit",
                    "unavailable"
                  ]
                }
              },
              "required": [
                "status"
              ],
              "additionalProperties": false
            }
          ],
          "description": "Optional body excerpt status for a requested portable text search."
        },
        "body": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string"
            },
            "html": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "attachments": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "filename": {
                "type": "string"
              },
              "mimeType": {
                "type": "string"
              },
              "sizeBytes": {
                "type": "integer",
                "minimum": 0
              },
              "contentId": {
                "type": "string"
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
              "id",
              "filename",
              "mimeType",
              "sizeBytes"
            ],
            "additionalProperties": false
          }
        },
        "flags": {
          "type": "object",
          "properties": {
            "read": {
              "type": "boolean"
            },
            "starred": {
              "type": "boolean"
            },
            "draft": {
              "type": "boolean"
            }
          },
          "required": [
            "read",
            "starred",
            "draft"
          ],
          "additionalProperties": false
        },
        "headers": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        }
      },
      "required": [
        "id",
        "threadId",
        "accountId",
        "to",
        "subject",
        "date",
        "flags"
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
