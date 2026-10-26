/**
 * Fluxmail's multitenant Microsoft Entra app for local CLI authorization. It is
 * separate from Fluxmail Cloud's confidential app. The loopback flow is a public
 * client and uses PKCE, so no client secret ships.
 */
export const DEFAULT_MICROSOFT_CLIENT_ID = 'b37dcad7-5397-445c-884e-7ff9bcf13217';
export const DEFAULT_MICROSOFT_TENANT_ID = 'common';
