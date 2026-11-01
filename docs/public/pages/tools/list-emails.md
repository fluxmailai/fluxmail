---
title: 'list_emails'
description: 'List or search emails in a mailbox, with metadata and optional previews. Filter by folder, sender, read state, dates and more, and paginate with pageToken. Use get_email for full bodies.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

List or search emails in a mailbox, with metadata and optional previews. Filter by folder, sender, read state, dates and more, and paginate with pageToken. Use get_email for full bodies.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `folder` | No | `string` or `null` | Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \All mailbox may use different rules. Minimum length: 1. Maximum length: 2048. |
| `text` | No | `string` or `null` | Literal full-text search terms Maximum length: 2048. |
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
      "description": "Account to operate on. Optional when exactly one account is connected.",
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        },
        {
          "type": "null"
        }
      ]
    },
    "folder": {
      "description": "Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \\All mailbox may use different rules.",
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        },
        {
          "type": "null"
        }
      ]
    },
    "text": {
      "description": "Literal full-text search terms",
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
      "description": "YYYY-MM-DD received date, inclusive in UTC",
      "anyOf": [
        {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "before": {
      "description": "YYYY-MM-DD received date, exclusive in UTC",
      "anyOf": [
        {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "rawProviderQuery": {
      "description": "Provider-native Gmail syntax or Outlook KQL for one compatible account",
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
    "pageToken": {
      "description": "nextPageToken from a previous call",
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
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
      "description": "Include a match-centered body excerpt; requires a portable text query",
      "type": [
        "boolean",
        "null"
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
