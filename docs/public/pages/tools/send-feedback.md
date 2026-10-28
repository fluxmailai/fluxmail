---
title: 'send_feedback'
description: 'Submit feedback about Fluxmail with your approval, optional reply address and supported diagnostics.'
updated: '2026-07-15'
---

<!-- This page is generated from the MCP tool definitions. Run pnpm docs:generate to update it. -->

Submit feedback only when you explicitly ask. Review and approve the message, diagnostics and exact optional reply address before sending. The client must never select a mailbox address automatically or invent diagnostics. Feedback requires authentication but no mail permissions or mailbox access, and remains available after a subscription ends. See [sending feedback](/docs/tools#send-feedback) for consent rules, field limits and submission controls, and [feedback privacy](/docs/telemetry#feedback-you-choose-to-send) for recipients and retention.

## Permissions

Required capabilities: None.

## Inputs

| Name | Required | Type | Details |
| --- | --- | --- | --- |
| `message` | Yes | `string` | The feedback text approved by the user. Minimum length: 1. Maximum length: 4000. |
| `category` | No | `bug` or `feature` or `other` | None |
| `contactEmail` | No | `string` | Optional reply address confirmed by the user. Never choose a connected mailbox address automatically. Format: `email`. Maximum length: 320. |
| `requestId` | No | `string` | The related failed request ID, when available. Do not invent one. Format: `uuid`. |
| `toolName` | No | `string` | The tool involved in the reported problem. |
| `errorCode` | No | `string` | The safe error code returned by that tool, without its error message. |
| `expectedBehavior` | No | `string` | What the user expected. Exclude mail contents and credentials. Minimum length: 1. Maximum length: 1000. |
| `actualBehavior` | No | `string` | What happened instead. Exclude mail contents and credentials. Minimum length: 1. Maximum length: 1000. |

<details>
<summary>JSON input schema</summary>

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?!\\s*$)[^\\0]+$",
      "maxLength": 4000,
      "description": "The feedback text approved by the user."
    },
    "category": {
      "type": "string",
      "enum": [
        "bug",
        "feature",
        "other"
      ],
      "default": "other"
    },
    "contactEmail": {
      "type": "string",
      "maxLength": 320,
      "format": "email",
      "pattern": "^[^\\s\\x00-\\x1f\\x7f]+$",
      "description": "Optional reply address confirmed by the user. Never choose a connected mailbox address automatically."
    },
    "requestId": {
      "type": "string",
      "format": "uuid",
      "description": "The related failed request ID, when available. Do not invent one."
    },
    "toolName": {
      "type": "string",
      "pattern": "^[a-z_]{1,64}$",
      "description": "The tool involved in the reported problem."
    },
    "errorCode": {
      "type": "string",
      "pattern": "^[a-z_]{1,64}$",
      "description": "The safe error code returned by that tool, without its error message."
    },
    "expectedBehavior": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?!\\s*$)[^\\0]+$",
      "maxLength": 1000,
      "description": "What the user expected. Exclude mail contents and credentials."
    },
    "actualBehavior": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?!\\s*$)[^\\0]+$",
      "maxLength": 1000,
      "description": "What happened instead. Exclude mail contents and credentials."
    }
  },
  "required": [
    "message"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>
