---
title: 'Search emails batch'
description: 'Search up to 20 accounts with one portable query and return one result group per account.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`search_emails_batch`

Search up to 20 accounts with one portable query and return one result group per account.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accounts` | Yes | array of `object` | None |
| `query` | Yes | `string` | Typed portable search syntax Minimum length: 1. Maximum length: 2048. |
| `folder` | No | `inbox` or `sent` or `drafts` or `archive` or `spam` or `trash` or `all` or `null` | None |
| `from` | No | `string` or `null` | Maximum length: 2048. |
| `to` | No | `string` or `null` | Maximum length: 2048. |
| `subject` | No | `string` or `null` | Maximum length: 2048. |
| `read` | No | `boolean` or `null` | None |
| `starred` | No | `boolean` or `null` | None |
| `hasAttachment` | No | `boolean` or `null` | None |
| `after` | No | `string` or `null` | YYYY-MM-DD received date, inclusive in UTC |
| `before` | No | `string` or `null` | YYYY-MM-DD received date, exclusive in UTC |
| `pageSize` | No | `integer` or `null` | Defaults to 25 Minimum: 1. Maximum: 100. |
| `includeSnippet` | No | `boolean` or `null` | Request or suppress message previews |
| `includeSearchContext` | No | `boolean` or `null` | Include a match-centered body excerpt; requires a portable text query |

<details>
<summary>JSON input schema</summary>

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
            "maxLength": 512
          },
          "pageToken": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ]
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
      "maxLength": 2048,
      "minLength": 1,
      "description": "Typed portable search syntax"
    },
    "folder": {
      "anyOf": [
        {
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
        {
          "type": "null"
        }
      ]
    },
    "from": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 2048
        },
        {
          "type": "null"
        }
      ]
    },
    "to": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 2048
        },
        {
          "type": "null"
        }
      ]
    },
    "subject": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 2048
        },
        {
          "type": "null"
        }
      ]
    },
    "read": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "starred": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "hasAttachment": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "after": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        {
          "type": "null"
        }
      ],
      "description": "YYYY-MM-DD received date, inclusive in UTC"
    },
    "before": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        {
          "type": "null"
        }
      ],
      "description": "YYYY-MM-DD received date, exclusive in UTC"
    },
    "pageSize": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        {
          "type": "null"
        }
      ],
      "description": "Defaults to 25"
    },
    "includeSnippet": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "Request or suppress message previews"
    },
    "includeSearchContext": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "Include a match-centered body excerpt; requires a portable text query"
    }
  },
  "required": [
    "accounts",
    "query"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
