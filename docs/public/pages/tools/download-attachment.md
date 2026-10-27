---
title: 'Download attachment'
description: 'Get metadata and a resource link for one attachment. With inline, the result also includes the content. For a PDF, inline adds extracted text, and pages returns the text of a page range such as 201-400. The size limit is 10 MB.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

`download_attachment`

Get metadata and a resource link for one attachment. With inline, the result also includes the content. For a PDF, inline adds extracted text, and pages returns the text of a page range such as 201-400. The size limit is 10 MB.

## Permissions

Required capabilities: `mail.read`.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `accountId` | No | `string` or `null` | Account to operate on. Optional when exactly one account is connected. Minimum length: 1. Maximum length: 512. |
| `messageId` | Yes | `string` | Minimum length: 1. Maximum length: 512. |
| `attachmentId` | Yes | `string` | Opaque attachment ID returned by message metadata Minimum length: 1. Maximum length: 512. |
| `inline` | No | `boolean` or `null` | None |
| `pages` | No | `string` or `null` | PDF page or page range to read as text, such as 201-400 |

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
    "messageId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "attachmentId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "description": "Opaque attachment ID returned by message metadata"
    },
    "inline": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "pages": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[1-9]\\d{0,5}(-[1-9]\\d{0,5})?$",
          "description": "PDF page or page range to read as text, such as 201-400"
        },
        {
          "type": "null"
        }
      ],
      "description": "PDF page or page range to read as text, such as 201-400"
    }
  },
  "required": [
    "messageId",
    "attachmentId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
