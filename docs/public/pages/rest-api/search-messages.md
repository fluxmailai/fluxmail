---
title: 'POST /api/v1/messages/search'
description: 'Search up to 20 email accounts with one portable query.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Search up to 20 email accounts with one portable query.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/messages/search' \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
  "accounts": [
    {
      "accountId": "acct_123"
    }
  ],
  "query": "string"
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
    "accounts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "accountId": {
            "type": "string",
            "minLength": 1,
            "example": "acct_123"
          },
          "pageToken": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "accountId"
        ],
        "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 20
    },
    "query": {
      "type": "string",
      "minLength": 1
    },
    "folder": {
      "type": "string",
      "enum": [
        "inbox",
        "sent",
        "drafts",
        "archive",
        "spam",
        "trash",
        "all"
      ]
    },
    "text": {
      "type": "string"
    },
    "from": {
      "type": "string"
    },
    "to": {
      "type": "string"
    },
    "subject": {
      "type": "string"
    },
    "read": {
      "type": "boolean"
    },
    "starred": {
      "type": "boolean"
    },
    "hasAttachment": {
      "type": "boolean"
    },
    "after": {
      "type": "string",
      "format": "date",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "before": {
      "type": "string",
      "format": "date",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "pageSize": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "includeSnippet": {
      "type": "boolean"
    },
    "includeSearchContext": {
      "type": "boolean",
      "description": "Include a match-centered body excerpt. Requires a portable text query."
    }
  },
  "required": [
    "accounts",
    "query"
  ],
  "additionalProperties": false
}
```

</details>

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Grouped search results | `application/json` |
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
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "accountId": {
                "type": "string"
              },
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
              }
            },
            "required": [
              "accountId",
              "data",
              "meta"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "accountId": {
                "type": "string"
              },
              "error": {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string"
                  },
                  "message": {
                    "type": "string"
                  },
                  "data": {
                    "type": "object",
                    "additionalProperties": {
                      "nullable": true
                    }
                  },
                  "exhausted": {
                    "type": "boolean",
                    "enum": [
                      false
                    ]
                  }
                },
                "required": [
                  "code",
                  "message",
                  "exhausted"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "accountId",
              "error"
            ],
            "additionalProperties": false
          }
        ]
      }
    },
    "meta": {
      "type": "object",
      "properties": {
        "exhausted": {
          "type": "boolean"
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
