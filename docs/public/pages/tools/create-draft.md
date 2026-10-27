---
title: 'Create draft'
description: 'Create a draft in the mailbox. With replyToMessageId, the draft is a reply: recipients and a subject left out come from the original message, and replyAll includes all of its recipients.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`create_draft`

Create a draft in the mailbox. With replyToMessageId, the draft is a reply: recipients and a subject left out come from the original message, and replyAll includes all of its recipients.

## Permissions

Required capabilities: `mail.drafts`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. |
| `from` | No | `string` or `null` | Connected address or an available send-as address Format: `email`. |
| `to` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `cc` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `bcc` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `subject` | No | `string` or `null` | Defaults to "Re: ..." when replying |
| `bodyText` | No | `string` or `null` | Plain-text body. Line breaks appear in the sent email. Keep each prose paragraph on one continuous line and separate paragraphs with blank lines. |
| `bodyHtml` | No | `string` or `null` | HTML body |
| `replyToMessageId` | No | `string` or `null` | Message being replied to; threads correctly and computes recipients if "to" is omitted Minimum length: 1. |
| `replyAll` | No | `boolean` or `null` | With replyToMessageId: reply to all original recipients |
| `attachments` | No | array of `object` or `null` | None |

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
    "from": {
      "anyOf": [
        {
          "type": "string",
          "format": "email"
        },
        {
          "type": "null"
        }
      ],
      "description": "Connected address or an available send-as address"
    },
    "to": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ],
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "cc": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ],
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "bcc": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ],
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
    },
    "subject": {
      "type": [
        "string",
        "null"
      ],
      "description": "Defaults to \"Re: ...\" when replying"
    },
    "bodyText": {
      "type": [
        "string",
        "null"
      ],
      "description": "Plain-text body. Line breaks appear in the sent email. Keep each prose paragraph on one continuous line and separate paragraphs with blank lines."
    },
    "bodyHtml": {
      "type": [
        "string",
        "null"
      ],
      "description": "HTML body"
    },
    "replyToMessageId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ],
      "description": "Message being replied to; threads correctly and computes recipients if \"to\" is omitted"
    },
    "replyAll": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "With replyToMessageId: reply to all original recipients"
    },
    "attachments": {
      "anyOf": [
        {
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
                "description": "base64"
              },
              "contentId": {
                "type": "string",
                "minLength": 1,
                "description": "Content-ID for an inline image, referenced from bodyHtml as cid:<contentId>"
              },
              "disposition": {
                "type": "string",
                "enum": [
                  "inline",
                  "attachment"
                ],
                "description": "Defaults to attachment"
              }
            },
            "required": [
              "filename",
              "mimeType",
              "content"
            ],
            "additionalProperties": false
          }
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
