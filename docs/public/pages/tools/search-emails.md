---
title: 'search_emails'
description: 'Search one account with typed portable syntax. The query supports text, from:, to:, subject:, in:, read and starred states, attachments, and date filters.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Search one account with typed portable syntax. The query supports text, from:, to:, subject:, in:, read and starred states, attachments, and date filters.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `query` | Yes | `string` | Typed portable search syntax Minimum length: 1. Maximum length: 2048. |
| `folder` | No | `string` or `null` | Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \All mailbox may use different rules. Minimum length: 1. Maximum length: 2048. |
| `from` | No | `string` or `null` | Maximum length: 2048. |
| `to` | No | `string` or `null` | Maximum length: 2048. |
| `subject` | No | `string` or `null` | Maximum length: 2048. |
| `read` | No | `boolean` or `null` | None |
| `starred` | No | `boolean` or `null` | None |
| `hasAttachment` | No | `boolean` or `null` | None |
| `after` | No | `string` or `null` | YYYY-MM-DD received date, inclusive in UTC |
| `before` | No | `string` or `null` | YYYY-MM-DD received date, exclusive in UTC |
| `rawProviderQuery` | No | `string` or `null` | Provider-native Gmail syntax or Outlook KQL for one compatible account Maximum length: 2048. |
| `pageSize` | No | `integer` or `null` | Defaults to 25 Minimum: 1. Maximum: 100. |
| `pageToken` | No | `string` or `null` | nextPageToken from a previous call Minimum length: 1. |
| `includeSnippet` | No | `boolean` or `null` | Request or suppress message previews |
| `includeSearchContext` | No | `boolean` or `null` | Include a match-centered body excerpt; requires a portable text query |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "accountId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        },
        {
          "type": "null"
        }
      ],
      "description": "Account to operate on. Optional when exactly one account is connected."
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
          "maxLength": 2048,
          "minLength": 1
        },
        {
          "type": "null"
        }
      ],
      "description": "Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \\All mailbox may use different rules."
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
    "rawProviderQuery": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 2048
        },
        {
          "type": "null"
        }
      ],
      "description": "Provider-native Gmail syntax or Outlook KQL for one compatible account"
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
    "pageToken": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ],
      "description": "nextPageToken from a previous call"
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
    "query"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
