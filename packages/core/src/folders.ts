import { EmailError, type ProviderFailure } from './errors.js';
import type { FolderRole } from './types.js';

/**
 * A folder name Fluxmail or the mail provider refused, with a message Fluxmail wrote. The message names only the
 * requested folder and folders in the same mailbox, never provider response text, so a product can return it to
 * the caller instead of a generic refusal.
 */
export class FolderNameError extends EmailError {
  constructor(message: string, failure?: ProviderFailure) {
    super('invalid_request', message, undefined, failure);
  }
}

// A record, so adding a role to FolderRole without listing it here fails to compile.
const ROLE_RECORD: Record<FolderRole, true> = {
  inbox: true,
  sent: true,
  drafts: true,
  trash: true,
  spam: true,
  archive: true,
  starred: true,
  all: true,
};

/** Every folder role. Each names a system folder or view, which callers reach by role rather than create. */
export const FOLDER_ROLES = Object.keys(ROLE_RECORD) as readonly FolderRole[];

const FOLDER_ROLE_NAMES = new Set<string>(FOLDER_ROLES);

/** Whether a name is a folder role word, such as Inbox or TRASH, which searches and moves read as the role. */
export function isFolderRoleName(name: string): boolean {
  return FOLDER_ROLE_NAMES.has(name.trim().toLowerCase());
}

/**
 * The name of a folder to create, trimmed, after the checks every provider shares. The name can't be blank,
 * contain control characters, or be a folder role such as inbox or trash, in any case, since searches and
 * moves read those words as the system folder. Providers add their own checks for names that would take a role.
 */
export function newFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new FolderNameError('The folder name is empty.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new FolderNameError('Folder names cannot contain control characters.');
  }
  if (isFolderRoleName(trimmed)) {
    throw new FolderNameError(`"${trimmed}" is a system folder. Choose another name.`);
  }
  return trimmed;
}

/**
 * The levels of a folder path, split at the mailbox's hierarchy separator. A mailbox without one has a single
 * level. Spaces around a level are dropped, so "Projects / 2026" names the same folder as "Projects/2026". A path
 * with an empty level, such as "Projects/" or "Projects//2026", is rejected.
 */
export function folderPathLevels(path: string, separator: string | undefined): string[] {
  const levels = (separator ? path.split(separator) : [path]).map((level) => level.trim());
  if (levels.some((level) => !level)) {
    throw new FolderNameError(
      separator
        ? `Every level of the folder path "${path}" needs a name. This mailbox separates levels with "${separator}".`
        : `The folder name "${path}" is empty.`,
    );
  }
  return levels;
}
