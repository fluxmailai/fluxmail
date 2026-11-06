---
title: 'search_emails'
description: 'Another name for `list_emails`, with the same arguments, permissions and results.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`search_emails` is another name for [`list_emails`](/docs/tools/list-emails). It takes the same arguments, needs the same permissions and returns the same results.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `query` | No | `string` or `null` | Typed search. Plain words search the message text; quote a phrase or a value that has spaces. Filters: from:, to:, subject:, in:inbox\|sent\|drafts\|archive\|spam\|trash\|all, is:read, is:unread, is:starred, is:unstarred, has:attachment, -has:attachment, after:YYYY-MM-DD (inclusive) and before:YYYY-MM-DD (exclusive), in UTC. Terms combine with AND; OR and parentheses are searched as text. Maximum length: 2048. |
| `folder` | No | `string` or `null` | Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \All mailbox may use different rules. Minimum length: 1. Maximum length: 2048. |
| `rawProviderQuery` | No | `string` or `null` | Provider-native Gmail syntax or Outlook KQL for one compatible account Maximum length: 2048. |
| `pageSize` | No | `integer` or `null` | Defaults to 25 Minimum: 1. Maximum: 100. |
| `pageToken` | No | `string` or `null` | nextPageToken from a previous call Minimum length: 1. |
| `includeSnippet` | No | `boolean` or `null` | Request or suppress message previews |
| `includeSearchContext` | No | `boolean` or `null` | Include a match-centered body excerpt; requires search words in query |

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
      "description": "Include a match-centered body excerpt; requires search words in query",
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
