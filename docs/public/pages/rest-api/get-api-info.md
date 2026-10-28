---
title: 'GET /api/v1'
description: 'Return the Fluxmail version and the URL of the OpenAPI document.'
updated: '2026-07-15'
---

<!-- This page is generated from the OpenAPI schema. Run pnpm docs:generate to update it. -->

Return the Fluxmail version and the URL of the OpenAPI document.

## Authentication

This endpoint does not require authentication.

## Request

```bash
curl 'http://localhost:8977/api/v1'
```

This endpoint has no parameters or request body.

## Responses

| Status | Description | Content type |
| --- | --- | --- |
| `200` | REST API discovery | `application/json` |

### 200 response

<details>
<summary>JSON schema</summary>

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "enum": [
            "fluxmail"
          ]
        },
        "version": {
          "type": "string"
        },
        "openapi": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "version",
        "openapi"
      ],
      "additionalProperties": false
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "data"
  ],
  "additionalProperties": false
}
```

</details>
