import type { Account } from '@fluxmail/core';
import type { OAuthClient } from '../storage/oauth.js';
import type { McpCapability } from '../permissions.js';
import { isLocalRedirectUri } from '../oauth/redirectUris.js';

export const OAUTH_PAGE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // same-origin keeps the Origin header on the consent form and hides this page from the client.
  'referrer-policy': 'same-origin',
} as const;

const icon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// Lucide icon paths, drawn inline because the page CSP blocks external images.
const SCOPE_LABELS: Record<McpCapability, { label: string; detail: string; icon: string; sensitive?: boolean }> = {
  'mail.read': {
    label: 'Read mail',
    detail: 'Search and read messages, folders, labels, and attachments.',
    icon: icon(
      '<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>',
    ),
  },
  'mail.drafts': {
    label: 'Manage drafts',
    detail: 'Create, edit, and delete drafts, and cancel scheduled sends.',
    icon: icon(
      '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
    ),
  },
  'mail.organize': {
    label: 'Organize mail',
    detail: 'Mark read or unread, star, archive, move, and label messages.',
    icon: icon(
      '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
    ),
  },
  'mail.trash': {
    label: 'Use Trash',
    detail: 'Move messages to Trash and restore them.',
    icon: icon(
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    ),
  },
  'mail.delete': {
    label: 'Permanently delete mail',
    detail: 'Delete messages so they cannot be recovered.',
    icon: icon('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
    sensitive: true,
  },
  'mail.send': {
    label: 'Send mail',
    detail: 'Send and schedule messages from your mailboxes.',
    icon: icon(
      '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    ),
    sensitive: true,
  },
};

const SHIELD_ICON = icon(
  '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
);

const LOGO = `<svg viewBox="3.1 52.3 58.7 71.9" aria-hidden="true"><path fill-rule="evenodd" d="M53.299999,56.049999q-3.74,-2.92,-8.77,-2.92q-6.74,0,-11.28,5.98q-4.54,5.98,-4.59,18.67q-0.05,3.08,-0.19,7.82q-0.15,4.73,-0.32,10.15q-0.0013,0.0416,-0.0026,0.0831q-3.8057,-0.6569,-6.6374,-2.5231q-4.37,-2.88,-6.52,-7.47q-2.15,-4.59,-2.15,-9.67q0,-3.51,1.2,-7.35q1.19,-3.83,4.12,-7.25q2.93,-3.42,8.11,-5.76q-0.15,-0.49,-0.46,-1.39q-0.32,-0.9,-0.71,-1.49q-6.79,1.95,-11.01,5.03q-4.23,3.08,-6.47,6.66q-2.25,3.59,-3.08,7.11q-0.83,3.51,-0.83,6.4q0,4.1,1.44,8.2q1.44,4.1,4.64,7.54q3.2,3.44,8.52,5.52q4.0998,1.5952,9.6545,1.9611q-0.0888,2.5464,-0.1845,5.0489q-0.19,5.22,-0.44,9.4q-0.24,4.17,-0.48,6.32q0.92,1.02,1.8,1.51q1.91,-0.83,4.54,-1.71q2.64,-0.88,4.4,-1.51q-0.25,-2.69,-0.47,-7.08q-0.22,-4.39,-0.34,-9.59q-0.0305,-1.3233,-0.0598,-2.6481q5.2473,-0.749,9.7798,-3.0219q6.76,-3.39,10.72,-9.79q3.95,-6.4,3.95,-15.38q0,-4.83,-2.07,-9.37q-2.08,-4.55,-5.81,-7.48zm-16.6787,39.9042q7.1362,-0.8769,11.3287,-5.0142q5.32,-5.25,5.32,-14.91q0,-4.64,-1.71,-8.5q-1.71,-3.86,-4.32,-6.15q-2.61,-2.3,-5.44,-2.3q-1.81,0,-3.03,0.95q-1.22,0.96,-1.83,4.2q-0.61,3.25,-0.61,10.04l0,2.49q0.05,2.68,0.1,7.05q0.04,4.37,0.14,9.55q0.0251,1.2976,0.0513,2.5942z"/></svg>`;

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]!);
}

// Matches the Fluxmail website and Cloud consent page. Inter and Newsreader are used when installed.
const STYLE = `
:root{--paper:oklch(0.988 0.002 85);--ink:oklch(0.23 0.025 268);--accent:oklch(0.51 0.195 264);--accent-strong:oklch(0.44 0.205 264);--line:oklch(0.23 0.025 268/0.08);--soft:oklch(0.23 0.025 268/0.6);color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--paper) radial-gradient(60rem 28rem at 50% -8rem,oklch(0.51 0.195 264/0.1),transparent) no-repeat;color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
header{max-width:64rem;margin:0 auto;padding:20px 24px}
.brand{display:flex;width:fit-content;align-items:baseline;gap:.25em;font:24px/1.2 Newsreader,"Iowan Old Style",Georgia,serif;letter-spacing:-.02em}
.brand svg{height:.9em;width:auto;transform:translateY(.11em);fill:currentColor}
main{max-width:32rem;margin:0 auto;padding:8px 16px 64px}
.card{overflow:hidden;border:1px solid var(--line);border-radius:24px;background:oklch(1 0 0/0.85);box-shadow:0 1px 2px rgb(0 0 0/.04),0 12px 28px -16px rgb(0 0 0/.12)}
.head{padding:32px 32px 24px;text-align:center}
.logos{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:24px}
.avatar{display:flex;width:56px;height:56px;align-items:center;justify-content:center;border-radius:16px;font-size:20px;font-weight:600;box-shadow:0 0 0 1px var(--line),0 1px 2px rgb(0 0 0/.04)}
.avatar-client{background:#fff;color:oklch(0.23 0.025 268/0.7)}
.avatar-fluxmail{background:var(--accent);color:#fff}
.avatar-fluxmail svg{height:28px;width:auto;fill:currentColor}
.bridge{width:40px;border-top:2px dotted oklch(0.23 0.025 268/0.2)}
h1{margin:0;font:400 34px/1.15 Newsreader,"Iowan Old Style",Georgia,serif;letter-spacing:-.02em;text-wrap:balance;overflow-wrap:anywhere}
p{margin:0;color:var(--soft);line-height:1.6}
.head p{margin-top:12px;font-size:14px}
.head strong{font-weight:500;color:var(--ink);overflow-wrap:anywhere}
.notice{display:flex;gap:12px;margin-top:24px;padding:16px;border:1px solid oklch(0.92 0.08 85);border-radius:16px;background:oklch(0.987 0.022 95/0.7);text-align:left}
.notice svg{flex:none;width:20px;height:20px;margin-top:2px;color:oklch(0.555 0.163 49)}
.head .notice p{margin:0;color:oklch(0.28 0.07 46/0.85)}
.notice strong{color:inherit}
.section{margin:0;padding:24px 32px;border:0;border-top:1px solid var(--line);min-width:0}
.label{float:left;width:100%;margin:0;padding:0;font-size:14px;font-weight:600}
.label+*{clear:both}
.sub{margin-top:2px;font-size:14px;color:oklch(0.23 0.025 268/0.55)}
.field{display:block;margin:16px 0 6px;font-size:14px;font-weight:500}
input[type=email],input[type=password]{width:100%;padding:10px 14px;border:1px solid oklch(0.23 0.025 268/0.12);border-radius:12px;background:#fff;color:inherit;font:inherit;box-shadow:0 1px 2px rgb(0 0 0/.04)}
input[type=email]:focus,input[type=password]:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px oklch(0.51 0.195 264/0.15)}
input[type=checkbox],input[type=radio]{width:16px;height:16px;flex:none;margin:0;accent-color:var(--accent)}
.segment{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:16px;padding:4px;border-radius:12px;background:oklch(0.23 0.025 268/0.05)}
.segment label{display:flex;cursor:pointer;align-items:center;justify-content:center;padding:8px 12px;border-radius:8px;font-size:14px;font-weight:500;color:var(--soft)}
.segment label:has(:checked){background:#fff;color:var(--ink);box-shadow:0 1px 3px rgb(0 0 0/.08)}
.segment label:has(:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.segment input{position:absolute;opacity:0;pointer-events:none}
.list{margin-top:12px;overflow:hidden;border:1px solid oklch(0.23 0.025 268/0.1);border-radius:16px;background:#fff}
.option{display:flex;cursor:pointer;align-items:center;gap:12px;padding:12px 16px;font-size:14px}
.option+.option{border-top:1px solid var(--line)}
.option:hover{background:oklch(0.23 0.025 268/0.02)}
.option-icon{display:flex;width:36px;height:36px;flex:none;align-items:center;justify-content:center;border-radius:12px;background:oklch(0.23 0.025 268/0.05);color:oklch(0.23 0.025 268/0.45)}
.option-icon svg{width:16px;height:16px}
.option:has(:checked) .option-icon{background:oklch(0.51 0.195 264/0.1);color:var(--accent)}
.option-text{display:flex;min-width:0;flex:1;flex-direction:column}
.option-text strong{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-weight:500;overflow-wrap:anywhere}
.option-text span{color:oklch(0.23 0.025 268/0.55)}
.tag{padding:1px 8px;border-radius:999px;background:oklch(0.987 0.022 95);box-shadow:0 0 0 1px oklch(0.924 0.12 95);color:oklch(0.47 0.137 46);font-size:11px;font-weight:600}
.empty{padding:12px 16px;font-size:14px}
.all-note{display:none;margin-top:12px;font-size:14px}
form:has(input[name=all_mailboxes][value="1"]:checked) .mailbox-list{display:none}
form:has(input[name=all_mailboxes][value="1"]:checked) .all-note{display:block}
.footer{padding:24px 32px;border-top:1px solid var(--line);background:oklch(0.988 0.002 85/0.7)}
.actions{display:flex;flex-direction:row-reverse;gap:12px}
button{display:inline-flex;flex:1;height:44px;cursor:pointer;align-items:center;justify-content:center;border:0;border-radius:999px;background:var(--accent);color:#fff;font:600 14px/1 inherit;font-family:inherit;box-shadow:0 1px 3px rgb(0 0 0/.08)}
button:hover{background:var(--accent-strong)}
button.secondary{border:1px solid oklch(0.23 0.025 268/0.12);background:#fff;color:var(--ink)}
button.secondary:hover{background:oklch(0.23 0.025 268/0.04)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.hint{margin-top:16px;text-align:center;font-size:12px;color:oklch(0.23 0.025 268/0.55)}
.hint+.hint{margin-top:6px}
code{font:0.92em ui-monospace,SFMono-Regular,Menlo,monospace}
.error{margin-top:16px;padding:12px 16px;border-radius:12px;background:oklch(0.971 0.013 17);color:oklch(0.505 0.213 27.518);font-size:14px}
.head .error{text-align:left}
@media (max-width:480px){.head{padding:28px 24px 20px}.section,.footer{padding:20px 24px}h1{font-size:30px}}
`;

function layout(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
    `<body><header><div class="brand">${LOGO}<span>Fluxmail</span></div></header>` +
    `<main><section class="card">${body}</section></main></body></html>`
  );
}

export function oauthErrorPage(title: string, message: string): string {
  return layout(title, `<div class="head"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`);
}

function redirectTarget(url: URL): string {
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : `${url.protocol}//`;
}

function clientIdentity(client: OAuthClient, redirectUri: string): string {
  const url = new URL(redirectUri);
  const target = redirectTarget(url);
  if (client.kind === 'metadata_document' && client.metadataHost) {
    return target === client.metadataHost
      ? `<p>After you approve, Fluxmail returns you to <strong>${escapeHtml(target)}</strong>.</p>`
      : `<p>The app's details come from <strong>${escapeHtml(client.metadataHost)}</strong>. ` +
          `After you approve, Fluxmail sends you to <strong>${escapeHtml(target)}</strong>.</p>`;
  }
  if (isLocalRedirectUri(url)) {
    // A self-reported name can't hand the connection to anyone else when the code stays on this computer.
    return `<p>After you approve, Fluxmail returns you to an app on this computer.</p>`;
  }
  return (
    `<div class="notice">${SHIELD_ICON}<p>Fluxmail cannot verify who made this app. Continue only if you just ` +
    `started connecting it. After you approve, Fluxmail sends you to <strong>${escapeHtml(target)}</strong>.</p></div>`
  );
}

function clientHead(client: OAuthClient, redirectUri: string, extra = ''): string {
  const initial = escapeHtml(client.name.trim().charAt(0).toUpperCase() || '?');
  return (
    `<div class="head"><div class="logos" aria-hidden="true"><span class="avatar avatar-client">${initial}</span>` +
    `<span class="bridge"></span><span class="avatar avatar-fluxmail">${LOGO}</span></div>` +
    `<h1>Connect ${escapeHtml(client.name)} to Fluxmail</h1>${extra}${clientIdentity(client, redirectUri)}</div>`
  );
}

function hidden(requestId: string, csrf: string, step: 'sign_in' | 'approve'): string {
  return (
    `<input type="hidden" name="request_id" value="${escapeHtml(requestId)}">` +
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<input type="hidden" name="step" value="${step}">`
  );
}

const EXPIRY_NOTE = '<p class="hint">This request expires 10 minutes after it starts.</p>';

function errorNote(error: string | undefined): string {
  return error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
}

export function oauthSignInPage(input: {
  action: string;
  client: OAuthClient;
  redirectUri: string;
  requestId: string;
  csrf: string;
  email?: string;
  error?: string;
}): string {
  return layout(
    `Connect ${input.client.name} to Fluxmail`,
    clientHead(input.client, input.redirectUri) +
      `<form method="post" action="${escapeHtml(input.action)}">${hidden(input.requestId, input.csrf, 'sign_in')}` +
      `<div class="section"><p class="sub">Sign in with your Fluxmail member account.</p>${errorNote(input.error)}` +
      `<label class="field" for="email">Email</label>` +
      `<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(input.email ?? '')}">` +
      `<label class="field" for="password">Password</label>` +
      `<input id="password" name="password" type="password" autocomplete="current-password" required></div>` +
      // The primary button comes first so pressing Enter continues; the row is reversed for display.
      `<div class="footer"><div class="actions"><button type="submit" name="action" value="continue">Continue</button>` +
      `<button class="secondary" type="submit" name="action" value="deny" formnovalidate>Cancel</button></div>` +
      `${EXPIRY_NOTE}</div></form>`,
  );
}

export function oauthApprovePage(input: {
  action: string;
  client: OAuthClient;
  redirectUri: string;
  requestId: string;
  csrf: string;
  memberName: string;
  scopes: readonly McpCapability[];
  checkedScopes?: readonly McpCapability[];
  accounts: readonly Account[];
  checkedAccountIds?: readonly string[];
  allMailboxes?: boolean;
  error?: string;
}): string {
  // Permanent deletion is opt-in even when the client asks for it.
  const checkedScopes = new Set(input.checkedScopes ?? input.scopes.filter((scope) => scope !== 'mail.delete'));
  const checkedAccounts = new Set(
    input.checkedAccountIds ?? (input.accounts.length === 1 ? [input.accounts[0]!.id] : []),
  );
  const scopeOptions = input.scopes
    .map((scope) => {
      const { label, detail, icon: scopeIcon, sensitive } = SCOPE_LABELS[scope];
      return (
        `<label class="option"><span class="option-icon">${scopeIcon}</span><span class="option-text">` +
        `<strong>${label}${sensitive ? '<span class="tag">Sensitive</span>' : ''}</strong><span>${detail}</span></span>` +
        `<input type="checkbox" name="scope" value="${scope}"${checkedScopes.has(scope) ? ' checked' : ''}></label>`
      );
    })
    .join('');
  const accountOptions = input.accounts
    .map(
      (account) =>
        `<label class="option"><input type="checkbox" name="account" value="${escapeHtml(account.id)}"${
          checkedAccounts.has(account.id) ? ' checked' : ''
        }><span class="option-text"><strong>${escapeHtml(account.email)}</strong></span></label>`,
    )
    .join('');
  const all = Boolean(input.allMailboxes);
  return layout(
    `Connect ${input.client.name} to Fluxmail`,
    clientHead(
      input.client,
      input.redirectUri,
      `<p>Signed in as <strong>${escapeHtml(input.memberName)}</strong>.</p>${errorNote(input.error)}`,
    ) +
      `<form method="post" action="${escapeHtml(input.action)}">${hidden(input.requestId, input.csrf, 'approve')}` +
      `<fieldset class="section"><legend class="label">Mailboxes</legend>` +
      `<p class="sub">Choose which mailboxes this app can use.</p>` +
      `<div class="segment"><label><input type="radio" name="all_mailboxes" value="0"${all ? '' : ' checked'}>Selected</label>` +
      `<label><input type="radio" name="all_mailboxes" value="1"${all ? ' checked' : ''}>All mailboxes</label></div>` +
      `<div class="list mailbox-list">${accountOptions || '<p class="empty">You do not have any mailboxes yet.</p>'}</div>` +
      `<p class="all-note">Includes every mailbox you can use now, plus any you get access to later.</p></fieldset>` +
      `<fieldset class="section"><legend class="label">Permissions</legend>` +
      `<p class="sub">Uncheck anything you don't want this app to do.</p>` +
      `<div class="list">${scopeOptions}</div></fieldset>` +
      `<div class="footer"><div class="actions"><button type="submit" name="action" value="approve">Approve</button>` +
      `<button class="secondary" type="submit" name="action" value="deny">Deny</button></div>` +
      `${EXPIRY_NOTE}<p class="hint">You can disconnect this app later with <code>fluxmail connections revoke</code>.</p></div></form>`,
  );
}
