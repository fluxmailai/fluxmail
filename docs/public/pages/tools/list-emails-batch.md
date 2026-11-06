---
title: 'list_emails_batch'
description: 'List or search emails in up to 20 accounts at once, with one result group per account. Filter with query, which takes typed search such as from:ann@example.com is:unread, and use folder for a folder role. Each account pages with its own pageToken.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

List or search emails in up to 20 accounts at once, with one result group per account. Filter with query, which takes typed search such as from:ann@example.com is:unread, and use folder for a folder role. Each account pages with its own pageToken.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accounts` | Yes | array of `object` | None |
| `query` | No | `string` or `null` | Typed search. Plain words search the message text; quote a phrase or a value that has spaces. Filters: from:, to:, subject:, in:inbox\|sent\|drafts\|archive\|spam\|trash\|all, is:read, is:unread, is:starred, is:unstarred, has:attachment, -has:attachment, after:YYYY-MM-DD (inclusive) and before:YYYY-MM-DD (exclusive), in UTC. Terms combine with AND; OR and parentheses are searched as text. Maximum length: 2048. |
| `folder` | No | `inbox` or `sent` or `drafts` or `archive` or `spam` or `trash` or `all` or `null` | None |
| `pageSize` | No | `integer` or `null` | Defaults to 25 Minimum: 1. Maximum: 100. |
| `includeSnippet` | No | `boolean` or `null` | Request or suppress message previews |
| `includeSearchContext` | No | `boolean` or `null` | Include a match-centered body excerpt; requires search words in query |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "accounts": {
      "minItems": 1,
      "maxItems": 20,
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
      }
    },
    "query": {
      "description": "Typed search. Plain words search the message text; quote a phrase or a value that has spaces. Filters: from:, to:, subject:, in:inbox|sent|drafts|archive|spam|trash|all, is:read, is:unread, is:starred, is:unstarred, has:attachment, -has:attachment, after:YYYY-MM-DD (inclusive) and before:YYYY-MM-DD (exclusive), in UTC. Terms combine with AND; OR and parentheses are searched as text.",
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
    "pageSize": {
      "description": "Defaults to 25",
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        {
          "type": "null"
        }
      ]
    },
    "includeSnippet": {
      "description": "Request or suppress message previews",
      "type": [
        "boolean",
        "null"
      ]
    },
    "includeSearchContext": {
      "description": "Include a match-centered body excerpt; requires search words in query",
      "type": [
        "boolean",
        "null"
      ]
    }
  },
  "required": [
    "accounts"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
