---
title: 'GET /api/v1/accounts/{accountId}/messages/{messageId}/attachments/{attachmentId}'
description: 'Download one attachment as raw bytes.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Download one attachment as raw bytes.

## Authentication

Pass a Fluxmail member session or API key as a bearer token. API keys apply their mailbox scope and permissions to the request.

## Request

```bash
curl 'http://localhost:8977/api/v1/accounts/acct_123/messages/msg_123/attachments/part%3A1.2' \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

### Parameters

| Name | Location | Required | Type | Details |
| --- | --- | --- | --- | --- |
| `accountId` | path | Yes | `string` | Minimum length: 1. |
| `messageId` | path | Yes | `string` | Minimum length: 1. |
| `attachmentId` | path | Yes | `string` | Opaque attachment ID returned by message metadata Minimum length: 1. |

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | Attachment bytes | `application/octet-stream` |
| `400` | Invalid request | `application/json` |
| `401` | Authentication required | `application/json` |
| `403` | Permission or plan denied | `application/json` |
| `404` | Resource not found | `application/json` |
| `409` | Request conflict | `application/json` |
| `422` | Unsupported capability | `application/json` |
| `429` | Provider rate limit | `application/json` |
| `500` | Internal error | `application/json` |
| `503` | Provider unavailable | `application/json` |

### 200 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "string",
  "format": "binary"
}
```

</details>
