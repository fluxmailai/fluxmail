import {
  findByFolderName,
  isEmailError,
  type EmailProvider,
  type Folder,
  type ModifyAction,
  type Provider,
  type ProviderFailure,
} from '@fluxmail/core';
import { ModifyRejectionError } from './publicErrors.js';

const ROLE_ACTIONS = { archive: 'archive', trash: 'trash', untrash: 'trash' } as const;
const ACTION_VERBS = { archive: 'archive', trash: 'trash', untrash: 'restore' } as const;

// Every provider refuses a move into these two. Views such as all mail are left out: IMAP accepts a move into
// one, so a rejection there has another cause.
const DESTINATION_REJECTIONS: Record<string, string> = {
  archive: "That folder is this mailbox's archive. Archive these messages instead of moving them there.",
  trash: "That folder is this mailbox's trash. Trash these messages instead of moving them there.",
};

/**
 * Some rejections have nothing to do with the messages: a move targets the archive or trash under a name the
 * literal-name guard doesn't know, or the mailbox has no folder Fluxmail can use as its trash or archive.
 * Providers report these with the codes they use for a rejected message, and callers never see a provider's
 * wording. So after such a rejection the mailbox's folders are read once, and when they explain it the whole
 * change fails with that reason in place of the same bare code on every message. Folders are matched the ways
 * providers resolve one: by id, by name ignoring case, or by role. When the folders can't be listed or don't
 * explain the rejection, this returns and each message reports its own outcome.
 *
 * A mailbox with no trash folder gets no suggestion to move the mail instead: a move needs only the organize
 * capability, and trashing needs its own.
 */
export async function rejectForFolders(
  provider: EmailProvider,
  action: ModifyAction,
  error: unknown,
  account: { id: string; provider: Provider },
): Promise<void> {
  if (!isEmailError(error)) return;
  const move = typeof action === 'object' && 'move' in action ? action.move : undefined;
  const roleAction =
    typeof action === 'string' && action in ROLE_ACTIONS ? (action as keyof typeof ROLE_ACTIONS) : undefined;
  // Outlook reports a mailbox without an archive folder as not_found, the code it uses for a missing message.
  // Only an archive is checked after one, so a stale message id costs other actions no folder listing.
  const explainable =
    move !== undefined
      ? error.code === 'invalid_request'
      : roleAction !== undefined &&
        (error.code === 'unsupported_capability' || (roleAction === 'archive' && error.code === 'not_found'));
  if (!explainable) return;
  let folders: Folder[];
  try {
    folders = await provider.listFolders();
  } catch {
    return;
  }
  if (roleAction) {
    const role = ROLE_ACTIONS[roleAction];
    if (folders.some((folder) => folder.role === role)) return;
    // The owner of an IMAP mailbox can name the folder to use.
    const hint =
      account.provider === 'imap'
        ? ` Run "fluxmail accounts configure ${account.id} --${role}-folder <path>" to choose the folder.`
        : '';
    throw new ModifyRejectionError(
      'unsupported_capability',
      `Fluxmail can't tell which folder is this mailbox's ${role}, so it can't ${ACTION_VERBS[roleAction]} these messages.${hint}`,
      error.failure,
    );
  }
  const rejection = DESTINATION_REJECTIONS[findDestination(folders, move!)?.role ?? ''];
  if (rejection) throw new ModifyRejectionError('invalid_request', rejection, error.failure);
}

/**
 * The folder a move names, in the order providers resolve one: its id, a role in the spelling given, its name
 * ignoring case, then a role in any case. An ordinary folder named like a role wins over the folder with that role.
 */
function findDestination(folders: Folder[], move: string): Folder | undefined {
  const destination = move.trim();
  return (
    folders.find((folder) => folder.id === move) ??
    folders.find((folder) => folder.role === destination) ??
    findByFolderName(folders, destination, (folder) => folder.name, true) ??
    folders.find((folder) => folder.role === destination.toLowerCase())
  );
}

/** How many of a change's messages are read to learn whether they are in the trash. */
const TRASH_SAMPLE = 3;

/**
 * Providers refuse to move or archive a message that is in the trash, and report it as a rejected message.
 * When every message of a change was rejected that way, a few of them, spread across the change, are read to
 * learn whether this is why. Any that is elsewhere, or can't be read, leaves each message its own outcome.
 */
export async function rejectTrashedSource(
  provider: EmailProvider,
  action: ModifyAction,
  messageIds: readonly string[],
  failure?: ProviderFailure,
): Promise<void> {
  if (action !== 'archive' && !(typeof action === 'object' && 'move' in action)) return;
  const last = messageIds.length - 1;
  const sample = [...new Set([0, Math.floor(last / 2), last])]
    .slice(0, TRASH_SAMPLE)
    .map((index) => messageIds[index]!);
  try {
    const messages = await Promise.all(sample.map((id) => provider.getMessage(id)));
    if (!messages.every((message) => message.folder?.role === 'trash')) return;
  } catch {
    return;
  }
  throw new ModifyRejectionError(
    'invalid_request',
    'These messages are in the trash. Restore them before moving or archiving them.',
    failure,
  );
}
