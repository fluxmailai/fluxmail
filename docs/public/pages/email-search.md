---
title: 'Email search'
description: 'Use the same portable search syntax with Fluxmail CLI, MCP, and REST clients.'
updated: '2026-11-11'
---

Fluxmail has one portable search syntax for Gmail, Outlook, and IMAP mailboxes. You can use it with `fluxmail emails search`, `fluxmail emails search-batch`, the `query` argument of the `list_emails` and `list_emails_batch` MCP tools, or the REST search operations. `search_emails` and `search_emails_batch` are other names for those two tools.

```text
from:ann@example.com in:archive is:unread after:2026-07-01 quarterly report
```

Search terms use implicit AND. Fluxmail does not interpret `AND`, `OR`, or parentheses as boolean expressions.

## Filters

| Syntax | Meaning |
| --- | --- |
| `from:value` | Sender |
| `to:value` | Recipient |
| `subject:value` | Subject |
| `in:role` | Portable folder role |
| `is:read` or `is:unread` | Read state |
| `is:starred` or `is:unstarred` | Starred state |
| `has:attachment` or `-has:attachment` | Non-inline attachment state |
| `after:YYYY-MM-DD` | Received on or after this UTC date |
| `before:YYYY-MM-DD` | Received before this UTC date |

Portable folder roles are `inbox`, `sent`, `drafts`, `archive`, `spam`, `trash`, and `all`. Custom folders are account specific. Use the structured `folder` filter after looking up the folder with `list_folders` or the REST folders endpoint.

Dates use the message's received or provider internal time. `after` is inclusive and `before` is exclusive. Both values must be calendar dates, and `after` must be earlier than `before`.

## Combine a query with structured filters

The `list_emails` and `list_emails_batch` MCP tools take all of their filters in `query`, plus `folder`. The REST operations also accept structured filters such as `from` and `read`, and `text`, whose words are joined with the words in the query. A filter can appear in both the query and a structured field if both have the same value. Fluxmail ignores case and surrounding spaces when it compares senders, recipients, and subjects. Folders must match exactly, apart from surrounding spaces, because an IMAP folder name in a different case can be a different folder. `INBOX` matches in any case. If the values differ, Fluxmail rejects the request with an error that names the operator and the field.

## Quotes and literal text

Double quotes group spaces inside a value:

```text
subject:"quarterly forecast" from:"Ann Example <ann@example.com>"
```

Inside quotes, escape `"` as `\"` and `\` as `\\`.

Free text is always literal. A search for `"from:ann@example.com"` looks for that text instead of activating a sender filter. URLs, times, unrelated values containing a colon, `AND`, `OR`, and parentheses also remain text.

Fluxmail may return a warning when a term looks like a mistyped operator. For example, `form:ann@example.com` remains literal text and produces a suggestion for `from:`. Quote the term when you intended it as text and do not want the warning.

## Provider-native search

Use `rawProviderQuery` when you need Gmail search syntax or Outlook KQL. Native queries are not portable and must target one compatible account. They are not part of the typed search string.

Search words cannot be combined with `rawProviderQuery`, whether they come from the typed query or the structured `text` field. Put the words in the native query instead. Filters combine with a native query using AND.

IMAP supports Gmail native syntax only when the server advertises `X-GM-EXT-1`. Account capabilities report whether native syntax and portable folder roles are available, unavailable, or still unknown.

Fluxmail rejects filters and native queries that the selected account reports as unavailable. Capabilities marked `unknown` are passed to the provider so it can discover support when the request runs.

## Attachments

Fluxmail treats a message as having an attachment when its hydrated metadata contains at least one part whose disposition is not `inline`. This definition is the same across providers.

Gmail's `has:attachment` operator has different behavior, so Fluxmail does not use it for portable attachment searches. Gmail may need to inspect several provider pages before it fills a result page, especially when searching for messages without attachments.

## Pagination

Pass `nextPageToken` back with the same account, query, page size, snippet setting, and search context setting. Search page tokens expire after one hour. They are signed to prevent changes, but their contents are not encrypted. Replacing the Fluxmail instance encryption key also invalidates existing tokens.

Every search page includes `exhausted`. A value of `true` means Fluxmail searched the full requested scope. When you omit the folder, that scope is all mail except Spam and Trash. An IMAP server's `\All` mailbox can define its own scope.

Some filters require local checks after Fluxmail receives provider candidates. A response can include:

```json
{
  "meta": {
    "nextPageToken": "...",
    "exhausted": false,
    "incomplete": true,
    "incompleteReason": "scan_limit",
    "inspectedCandidates": 1000
  }
}
```

An empty page confirms that there are no matches only when `exhausted` is `true`. Continue with `nextPageToken` when `incompleteReason` is `scan_limit` or `time_limit`. A provider can also return `provider_limit` when it cannot search beyond its own result cap.

Search work has a 15-second soft budget and a 25-second deadline. Fluxmail returns a continuation at a safe boundary when it can. If the provider stalls before Fluxmail has a continuation point, the request fails with `provider_unavailable` and `reason: "search_timeout"`.

## Message previews

Set `includeSnippet` to `true` to request previews or `false` to suppress them. If you omit it, Gmail and Outlook return their native previews while IMAP avoids extra body downloads.

For IMAP, Fluxmail downloads up to 16 KiB from the preferred text part and returns at most 300 characters. It prefers plain text and converts HTML when needed. A preview failure leaves the message metadata available and adds a warning to the page.

The `capabilities.snippets` field tells you whether a provider includes previews without fetching message bodies. A value of `false` does not prevent you from requesting a preview with `includeSnippet`.

## Search context

Set `includeSearchContext` to `true` to include a body excerpt around the search text. This option requires literal text from the typed query or the structured `text` field. Fluxmail rejects filter-only and provider-native searches that request context.

Search context is separate from `includeSnippet`. A message can contain both. Fluxmail prefers the complete search phrase, then uses the earliest matching term when the phrase does not appear in the body. Matching is case insensitive and treats punctuation as literal text.

Each message returns one of these values:

| Status | Meaning |
| --- | --- |
| `matched` | `excerpt` contains the matching line, cropped to 300 Unicode characters when needed. |
| `no_literal_match` | Fluxmail inspected the complete selected body but did not find the literal text. The provider may have matched headers, stemming, or other indexed content. |
| `scan_limit` | Fluxmail reached the 256 KiB decoded body scan limit before finding a literal match. |
| `unavailable` | Fluxmail could not read a suitable body or the optional body request failed. |

Fluxmail reads at most 256 KiB of decoded body content for each result. It prefers plain text and converts HTML to readable text when no plain-text body exists. Attachments and attached messages are excluded. Gmail and Outlook may transfer the complete body because their APIs do not support the same bounded partial read as IMAP.

Search context is off by default because it can add one body request per accepted result. On IMAP, Fluxmail uses a partial, non-marking body read. When an IMAP request asks for both a snippet and search context, Fluxmail derives both from the same download. An optional enrichment failure leaves the message metadata available, returns `unavailable`, and adds a warning to the page.

## Search several accounts

Use `list_emails_batch`, `POST /api/v1/messages/search`, or `fluxmail emails search-batch` to run the same portable search against several accounts. A batch accepts 1 through 20 distinct accounts and searches up to three at a time. Each account has its own page and continuation token.

The response keeps account groups in request order. One account can fail without discarding successful groups. The aggregate `exhausted` value is `true` only when every group is exhausted. To continue, send only the unfinished accounts with their tokens. Batch search accepts portable folder roles and rejects provider-native queries.
