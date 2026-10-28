---
title: 'GET /api/v1/accounts'
description: 'List the email accounts available to the API key.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

List the email accounts available to the API key.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts' \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

This endpoint has no parameters or request body.

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Accounts | `application/json` |
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
          "provider": {
            "type": "string",
            "enum": [
              "gmail",
              "outlook",
              "imap"
            ]
          },
          "email": {
            "type": "string"
          },
          "displayName": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "auth_error",
              "disabled"
            ]
          },
          "capabilities": {
            "type": "object",
            "properties": {
              "labels": {
                "type": "boolean"
              },
              "serverThreads": {
                "type": "boolean"
              },
              "serverSearch": {
                "type": "string",
                "enum": [
                  "rich",
                  "basic"
                ]
              },
              "search": {
                "type": "object",
                "properties": {
                  "filters": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "folder",
                        "text",
                        "from",
                        "to",
                        "subject",
                        "read",
                        "starred",
                        "hasAttachment",
                        "after",
                        "before"
                      ]
                    }
                  },
                  "folderRoles": {
                    "type": "object",
                    "properties": {
                      "inbox": {
                        "type": "string",
                        "enum": [
                          "available",
                          "unavailable",
                          "unknown"
                        ]
                      },
                      "sent": {
                        "type": "string",
                        "enum": [
                          "available",
                          "unavailable",
                          "unknown"
                        ]
                      },
                      "drafts": {
                        "type": "string",
                        "enum": [
                          "available",
                          "unavailable",
                          "unknown"
                        ]
                      },
                      "archive": {
                        "type": "string",
                        "enum": [
                          "available",
                          "unavailable",
                          "unknown"
                        ]
                      },
                      "spam": {
                        "type": "string",
                        "enum": [
                          "available",
                          "unavailable",
                          "unknown"
                        ]
                      },
                      "trash": {
                        "type": "string",
                        "enum": [
                          "available",
                          "unavailable",
                          "unknown"
                        ]
                      },
                      "all": {
                        "type": "string",
                        "enum": [
                          "available",
                          "unavailable",
                          "unknown"
                        ]
                      }
                    },
                    "required": [
                      "inbox",
                      "sent",
                      "drafts",
                      "archive",
                      "spam",
                      "trash",
                      "all"
                    ],
                    "additionalProperties": false
                  },
                  "nativeQuery": {
                    "type": "object",
                    "nullable": true,
                    "properties": {
                      "syntax": {
                        "type": "string",
                        "enum": [
                          "gmail",
                          "outlook-kql"
                        ]
                      },
                      "availability": {
                        "type": "string",
                        "enum": [
                          "available",
                          "unavailable",
                          "unknown"
                        ]
                      },
                      "unavailableReason": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "syntax",
                      "availability"
                    ],
                    "additionalProperties": false
                  }
                },
                "required": [
                  "filters",
                  "folderRoles",
                  "nativeQuery"
                ],
                "additionalProperties": false
              },
              "snippets": {
                "type": "boolean"
              },
              "searchContext": {
                "type": "boolean",
                "description": "Supports optional match-centered body excerpts."
              }
            },
            "required": [
              "labels",
              "serverThreads",
              "serverSearch",
              "search",
              "snippets"
            ],
            "additionalProperties": false
          },
          "ownerMemberId": {
            "type": "string"
          },
          "sharedWithAll": {
            "type": "boolean"
          },
          "grantedMemberIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "id",
          "provider",
          "email",
          "status",
          "capabilities",
          "ownerMemberId",
          "sharedWithAll",
          "grantedMemberIds"
        ],
        "additionalProperties": false
      }
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
