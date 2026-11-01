---
title: 'create_draft'
description: 'Create a draft in the mailbox. With replyToMessageId, the draft is a reply: recipients and a subject left out come from the original message, and replyAll includes all of its recipients.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Create a draft in the mailbox. With replyToMessageId, the draft is a reply: recipients and a subject left out come from the original message, and replyAll includes all of its recipients.

## Permissions

Required capabilities: `mail.drafts`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `from` | No | `string` or `null` | Connected address or an available send-as address Format: `email`. |
| `to` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `cc` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `bcc` | No | array of `string` or `null` | Recipients, each "Name <a@x.com>" or "a@x.com" |
| `subject` | No | `string` or `null` | Defaults to "Re: ..." when replying Maximum length: 998. |
| `bodyText` | No | `string` or `null` | Plain-text body. Line breaks appear in the sent email. Keep each prose paragraph on one continuous line and separate paragraphs with blank lines. |
| `bodyHtml` | No | `string` or `null` | HTML body |
| `replyToMessageId` | No | `string` or `null` | Message being replied to; threads correctly and computes recipients if "to" is omitted Minimum length: 1. Maximum length: 512. |
| `replyAll` | No | `boolean` or `null` | With replyToMessageId: reply to all original recipients |
| `attachments` | No | array of `object` or `null` | None |

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
    "from": {
      "description": "Connected address or an available send-as address",
      "anyOf": [
        {
          "type": "string",
          "format": "email"
        },
        {
          "type": "null"
        }
      ]
    },
    "to": {
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\"",
      "anyOf": [
        {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ]
    },
    "cc": {
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\"",
      "anyOf": [
        {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ]
    },
    "bcc": {
      "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\"",
      "anyOf": [
        {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "description": "Recipients, each \"Name <a@x.com>\" or \"a@x.com\""
        },
        {
          "type": "null"
        }
      ]
    },
    "subject": {
      "description": "Defaults to \"Re: ...\" when replying",
      "anyOf": [
        {
          "type": "string",
          "maxLength": 998
        },
        {
          "type": "null"
        }
      ]
    },
    "bodyText": {
      "description": "Plain-text body. Line breaks appear in the sent email. Keep each prose paragraph on one continuous line and separate paragraphs with blank lines.",
      "type": [
        "string",
        "null"
      ]
    },
    "bodyHtml": {
      "description": "HTML body",
      "type": [
        "string",
        "null"
      ]
    },
    "replyToMessageId": {
      "description": "Message being replied to; threads correctly and computes recipients if \"to\" is omitted",
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
    "replyAll": {
      "description": "With replyToMessageId: reply to all original recipients",
      "type": [
        "boolean",
        "null"
      ]
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
                "minLength": 1,
                "maxLength": 255
              },
              "mimeType": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "content": {
                "type": "string",
                "description": "base64"
              },
              "contentId": {
                "description": "Content-ID for an inline image, referenced from bodyHtml as cid:<contentId>",
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "disposition": {
                "description": "Defaults to attachment",
                "type": "string",
                "enum": [
                  "inline",
                  "attachment"
                ]
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
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

</details>
