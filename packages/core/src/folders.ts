import { EmailError, type EmailErrorCode, type ProviderFailure } from './errors.js';
import type { FolderRole } from './types.js';

/**
 * A folder or label name Fluxmail or the mail provider refused, with a message Fluxmail wrote. The message names
 * only the requested folder or label and others in the same mailbox, never provider response text, so a product can return it to
 * the caller instead of a generic refusal.
 */
export class FolderNameError extends EmailError {
  constructor(message: string, failure?: ProviderFailure, code: FolderErrorCode = 'invalid_request') {
    super(code, message, undefined, failure);
  }
}

/** The codes a FolderNameError can carry. Every one has a message Fluxmail wrote. */
export type FolderErrorCode = Extract<EmailErrorCode, 'invalid_request' | 'not_found' | 'permission_denied'>;

/** No folder has the requested ID or name. The message names only what the caller asked for. */
export class FolderNotFoundError extends FolderNameError {
  constructor(folder: string) {
    super(`This mailbox has no folder named "${folder}".`, undefined, 'not_found');
  }
}

/** What a provider calls its labels in messages Fluxmail writes. */
export type LabelNoun = 'label' | 'category';

/** No label has the requested ID or name. The message names only what the caller asked for. */
export class LabelNotFoundError extends FolderNameError {
  constructor(label: string, noun: LabelNoun = 'label') {
    super(`This mailbox has no ${noun} named "${label}".`, undefined, 'not_found');
  }
}

/** The name of a label to create, trimmed. The name can't be blank or contain control characters. */
export function newLabelName(name: string, noun: LabelNoun = 'label'): string {
  const trimmed = name.trim();
  if (!trimmed) throw new FolderNameError(`The ${noun} name is empty.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new FolderNameError(`${noun === 'label' ? 'Label' : 'Category'} names cannot contain control characters.`);
  }
  return trimmed;
}

/**
 * A folder delete_folder refused because the folder isn't empty, is a system folder, or a setting relies on it.
 * Nothing in the mailbox changed.
 */
export class FolderDeleteRefusedError extends FolderNameError {}

/**
 * The refusal for a folder that still holds messages, so deleting it could lose mail. A Gmail label is emptied by
 * removing it from its messages, since moving or trashing a message keeps its other labels.
 */
export function folderHasMessages(name: string, count: number, label = false): FolderDeleteRefusedError {
  const messages = count === 1 ? '1 message' : `${count} messages`;
  const them = count === 1 ? 'it' : 'them';
  const nextStep = label ? `Remove the label from ${them} first.` : `Move or trash ${them} first.`;
  return new FolderDeleteRefusedError(`"${name}" still has ${messages}. ${nextStep}`);
}

/** The refusal for a folder with subfolders, which deleting it would remove too. */
export function folderHasSubfolders(name: string): FolderDeleteRefusedError {
  return new FolderDeleteRefusedError(`"${name}" has subfolders. Delete them first.`);
}

/**
 * A folder rename_folder refused because the folder is a system folder, a setting relies on it, or the new name
 * is taken. Nothing in the mailbox changed.
 */
export class FolderRenameRefusedError extends FolderNameError {}

/** The refusal for renaming a system folder, such as the inbox or trash, or a view such as Starred. */
export function systemFolderNotRenamable(name: string): FolderRenameRefusedError {
  return new FolderRenameRefusedError(`"${name}" is a system folder and can't be renamed.`);
}

/**
 * A folder move_folder refused because the folder is a system folder, a setting relies on it, or the destination
 * can't take it. Nothing in the mailbox changed.
 */
export class FolderMoveRefusedError extends FolderNameError {}

/** The refusal for moving a system folder, such as the inbox or trash, or a view such as Starred. */
export function systemFolderNotMovable(name: string): FolderMoveRefusedError {
  return new FolderMoveRefusedError(`"${name}" is a system folder and can't be moved.`);
}

/** The refusal for moving a folder into itself or into one of its own subfolders. */
export function folderMovedIntoItself(name: string, parent: string): FolderMoveRefusedError {
  return new FolderMoveRefusedError(
    parent === name
      ? `"${name}" can't be moved into itself.`
      : `"${parent}" is inside "${name}", so "${name}" can't be moved into it.`,
  );
}

/** The refusal for a destination that already holds a folder with the moved folder's name. */
export function folderAlreadyThere(name: string, failure?: ProviderFailure): FolderMoveRefusedError {
  return new FolderMoveRefusedError(
    `A folder named "${name}" already exists there. Rename one of the two before moving.`,
    failure,
  );
}

/** The refusal for a move that would give the folder a name searches and moves read as a system folder. */
export function movedFolderTakesRole(name: string): FolderMoveRefusedError {
  return new FolderMoveRefusedError(
    `At its new place the folder would be named "${name}", which is a system folder name. Rename the folder before moving it.`,
  );
}

/** The refusal for a new name another folder already has. */
export function folderNameTaken(name: string, failure?: ProviderFailure): FolderRenameRefusedError {
  return new FolderRenameRefusedError(`A folder named "${name}" already exists. Choose another name.`, failure);
}

/** The refusal for a system folder, such as the inbox or trash, or a view such as Starred. */
export function systemFolderNotDeletable(name: string): FolderDeleteRefusedError {
  return new FolderDeleteRefusedError(`"${name}" is a system folder and can't be deleted.`);
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
 * The new name for a folder being renamed, trimmed. A rename changes the folder's own name and leaves it under
 * the same parent, so the name is one level: it can't be blank, contain control characters, or contain the
 * mailbox's hierarchy separator. Providers check the full path the name makes against system folder names.
 */
export function renamedFolderName(name: string, separator: string | undefined): string {
  const trimmed = name.trim();
  if (!trimmed) throw new FolderNameError('The new folder name is empty.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new FolderNameError('Folder names cannot contain control characters.');
  }
  if (separator && trimmed.includes(separator)) {
    throw new FolderNameError(
      `The new name can't contain "${separator}", which this mailbox uses between folder levels. A rename keeps the folder under the same parent, so give only the folder's own name.`,
    );
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
