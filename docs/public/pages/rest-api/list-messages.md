---
title: 'GET /api/v1/accounts/{accountId}/messages'
description: 'List and filter messages in an email account.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

List and filter messages in an email account.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/messages' \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `query` | query | No | `string` | Typed portable search syntax Minimum length: 1. |
| `folder` | query | No | `string` | Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \All mailbox may use different rules. Minimum length: 1. |
| `text` | query | No | `string` | Literal full-text search terms |
| `from` | query | No | `string` | None |
| `to` | query | No | `string` | None |
| `subject` | query | No | `string` | None |
| `read` | query | No | `true` or `false` | None |
| `starred` | query | No | `true` or `false` | None |
| `hasAttachment` | query | No | `true` or `false` | None |
| `after` | query | No | `string` | Format: `date`. Pattern: `^\d{4}-\d{2}-\d{2}$`. |
| `before` | query | No | `string` | Format: `date`. Pattern: `^\d{4}-\d{2}-\d{2}$`. |
| `rawProviderQuery` | query | No | `string` | Provider-native Gmail syntax or Outlook KQL |
| `pageSize` | query | No | `string` | Pattern: `^(?:[1-9]\|[1-9][0-9]\|100)$`. |
| `pageToken` | query | No | `string` | Minimum length: 1. |
| `includeSnippet` | query | No | `true` or `false` | None |
| `includeSearchContext` | query | No | `true` or `false` | Include a match-centered body excerpt. Requires a portable text query. |

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Messages | `application/json` |
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
      "type": "array",
      "items": {
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
      }
    },
    "meta": {
      "type": "object",
      "properties": {
        "nextPageToken": {
          "type": "string"
        },
        "exhausted": {
          "type": "boolean"
        },
        "diagnostics": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "code": {
                "type": "string"
              },
              "severity": {
                "type": "string",
                "enum": [
                  "error",
                  "warning"
                ]
              },
              "message": {
                "type": "string"
              },
              "start": {
                "type": "integer",
                "minimum": 0
              },
              "end": {
                "type": "integer",
                "minimum": 0
              },
              "suggestion": {
                "type": "string"
              }
            },
            "required": [
              "code",
              "severity",
              "message"
            ],
            "additionalProperties": false
          }
        },
        "incomplete": {
          "type": "boolean",
          "enum": [
            true
          ]
        },
        "incompleteReason": {
          "type": "string",
          "enum": [
            "scan_limit",
            "provider_limit",
            "time_limit"
          ]
        },
        "inspectedCandidates": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "exhausted"
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
    "data",
    "meta"
  ],
  "additionalProperties": false
}
```

</details>
