---
title: 'List emails'
description: 'List or search emails in a mailbox, with metadata and optional previews. Filter by folder, sender, read state, dates and more, and paginate with pageToken. Use get_email for full bodies.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`list_emails`

List or search emails in a mailbox, with metadata and optional previews. Filter by folder, sender, read state, dates and more, and paginate with pageToken. Use get_email for full bodies.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `folder` | No | `string` or `null` | Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \All mailbox may use different rules. Minimum length: 1. |
| `text` | No | `string` or `null` | Literal full-text search terms |
| `from` | No | `string` or `null` | None |
| `to` | No | `string` or `null` | None |
| `subject` | No | `string` or `null` | None |
| `read` | No | `boolean` or `null` | None |
| `starred` | No | `boolean` or `null` | None |
| `hasAttachment` | No | `boolean` or `null` | None |
| `after` | No | `string` or `null` | YYYY-MM-DD received date, inclusive in UTC Minimum length: 1. |
| `before` | No | `string` or `null` | YYYY-MM-DD received date, exclusive in UTC Minimum length: 1. |
| `rawProviderQuery` | No | `string` or `null` | Provider-native Gmail syntax or Outlook KQL for one compatible account |
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
          "minLength": 1
        },
        {
          "type": "null"
        }
      ],
      "description": "Account to operate on. Optional when exactly one account is connected."
    },
    "folder": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ],
      "description": "Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \\All mailbox may use different rules."
    },
    "text": {
      "type": [
        "string",
        "null"
      ],
      "description": "Literal full-text search terms"
    },
    "from": {
      "type": [
        "string",
        "null"
      ]
    },
    "to": {
      "type": [
        "string",
        "null"
      ]
    },
    "subject": {
      "type": [
        "string",
        "null"
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
          "minLength": 1
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
          "minLength": 1
        },
        {
          "type": "null"
        }
      ],
      "description": "YYYY-MM-DD received date, exclusive in UTC"
    },
    "rawProviderQuery": {
      "type": [
        "string",
        "null"
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
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
