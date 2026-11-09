import { googleAuthLibrary } from 'googleapis-common';

// googleapis-common pins google-auth-library to an exact version. Re-export that
// copy so callers create OAuth clients the Gmail API accepts without installing
// a second copy whose version has to be kept in sync.
export { OAuth2Client } from 'googleapis-common';
export const CodeChallengeMethod = googleAuthLibrary.CodeChallengeMethod;
export type CodeChallengeMethod = googleAuthLibrary.CodeChallengeMethod;
export type Credentials = googleAuthLibrary.Credentials;
