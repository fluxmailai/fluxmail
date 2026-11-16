import { FOLDER_ROLES, findByFolderName, type Folder, type FolderRole } from '@fluxmail/core';
import type { ListResponse } from 'imapflow';
import { specialUse } from 'imapflow/lib/special-use.js';
import type { FolderWarning, ImapCredentials } from './types.js';

type ConfigurableRole = 'sent' | 'drafts' | 'trash' | 'archive' | 'spam';

const SPECIAL_USE: Record<string, ConfigurableRole> = {
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Archive': 'archive',
  '\\Junk': 'spam',
};

const NAMES: Record<ConfigurableRole, Set<string>> = {
  sent: new Set(['sent', 'sent mail', 'sent items']),
  drafts: new Set(['draft', 'drafts', 'draft messages']),
  trash: new Set(['trash', 'deleted', 'deleted items', 'deleted messages']),
  archive: new Set(['archive', 'archives']),
  spam: new Set(['spam', 'junk', 'junk email', 'junk mail']),
};

export interface ResolvedFolders {
  folders: Folder[];
  paths: Partial<Record<FolderRole, string>>;
  warnings: FolderWarning[];
  selectablePaths: string[];
  /** Every mailbox path that exists, including ones that can't hold messages, such as a \Noselect parent. */
  listedPaths: string[];
  /** The hierarchy separator the server reported, when it has one. */
  delimiter?: string;
  allMailPaths: string[];
  /** The LIST response these folders were resolved from. */
  listing: ListResponse[];
}

function specialUseRole(entry: ListResponse): ConfigurableRole | undefined {
  return SPECIAL_USE[entry.specialUse ?? ''];
}

function samePath(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

/**
 * The listed mailbox path a requested name refers to, in the server's own spelling for IMAP commands.
 * An exact match wins; otherwise the name matches in either Unicode form. Case still matters, because
 * IMAP servers can keep mailboxes that differ only in case.
 */
export function findMailboxPath(paths: readonly string[], name: string): string | undefined {
  return findByFolderName(paths, name, (path) => path);
}

export function resolveFolders(
  listing: ListResponse[],
  overrides: ImapCredentials['folderOverrides'] = {},
): ResolvedFolders {
  const selectable = listing.filter((entry) => !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'));
  const roles = new Map<string, { role: FolderRole; source: Folder['roleSource'] }>();
  const paths: Partial<Record<FolderRole, string>> = {};
  const warnings: FolderWarning[] = [];

  const inbox = selectable.find((entry) => /^inbox$/i.test(entry.path));
  if (inbox) {
    roles.set(inbox.path, { role: 'inbox', source: 'extension' });
    paths.inbox = inbox.path;
  }

  for (const role of ['sent', 'drafts', 'trash', 'archive', 'spam'] as const) {
    const override = overrides?.[role];
    if (override) {
      const match = selectable.find((entry) => samePath(entry.path, override));
      if (match) {
        roles.set(match.path, { role, source: 'user' });
        paths[role] = match.path;
      } else {
        warnings.push({
          role,
          reason: 'stale_override',
          message: `${role} folder override "${override}" does not match a selectable mailbox`,
        });
      }
      continue;
    }

    // ImapFlow also guesses specialUse from localized folder names. Only flags the server reports count here;
    // its guesses go through the same ambiguity check as Fluxmail's own name matches.
    const extensionMatches = selectable.filter(
      (entry) => specialUseRole(entry) === role && entry.specialUseSource !== 'name',
    );
    if (extensionMatches.length === 1) {
      const match = extensionMatches[0]!;
      roles.set(match.path, { role, source: 'extension' });
      paths[role] = match.path;
      continue;
    }
    if (extensionMatches.length > 1) {
      warnings.push({
        role,
        reason: 'ambiguous',
        message: `multiple mailboxes advertise the ${role} role; configure the folder path explicitly`,
      });
      continue;
    }

    const nameMatches = selectable.filter(
      (entry) =>
        NAMES[role].has(entry.name.trim().toLowerCase()) ||
        (specialUseRole(entry) === role && entry.specialUseSource === 'name'),
    );
    if (nameMatches.length === 1) {
      const match = nameMatches[0]!;
      roles.set(match.path, { role, source: 'name' });
      paths[role] = match.path;
    } else if (nameMatches.length > 1) {
      warnings.push({
        role,
        reason: 'ambiguous',
        message: `multiple mailbox names look like the ${role} folder; configure the folder path explicitly`,
      });
    } else {
      warnings.push({ role, reason: 'missing', message: `no ${role} folder could be resolved` });
    }
  }

  const all = selectable.find((entry) => entry.specialUse === '\\All');
  if (all) {
    roles.set(all.path, { role: 'all', source: all.specialUseSource === 'name' ? 'name' : 'extension' });
    paths.all = all.path;
  }

  const folders = selectable.map((entry) => {
    const resolved = roles.get(entry.path);
    return {
      id: entry.path,
      name: entry.path,
      ...(resolved ? { role: resolved.role, roleSource: resolved.source } : {}),
      ...(typeof entry.status?.unseen === 'number' ? { unreadCount: entry.status.unseen } : {}),
    } satisfies Folder;
  });

  const excludedRoots = [paths.spam, paths.trash].filter((path): path is string => Boolean(path));
  const allMailPaths = selectable
    .filter(
      (entry) =>
        !excludedRoots.some(
          (root) => entry.path === root || (entry.delimiter && entry.path.startsWith(`${root}${entry.delimiter}`)),
        ),
    )
    .map((entry) => entry.path);

  const delimiter = listing.find((entry) => entry.delimiter)?.delimiter;
  return {
    folders,
    paths,
    warnings,
    selectablePaths: selectable.map((entry) => entry.path),
    listedPaths: listing.filter((entry) => !entry.flags.has('\\NonExistent')).map((entry) => entry.path),
    ...(delimiter ? { delimiter } : {}),
    allMailPaths,
    listing,
  };
}

/**
 * Why new mailboxes at `paths` would change which folders hold a role, or undefined when they wouldn't. A server
 * that doesn't flag its special folders has them resolved by name, so a new folder named Junk or Sent Items
 * could become the spam or sent folder, or leave two candidates so that archiving or trashing stops working.
 * A folder that a configured override names is expected to take its role.
 */
export function newFolderRoleConflict(
  resolved: ResolvedFolders,
  paths: readonly string[],
  overrides: ImapCredentials['folderOverrides'] = {},
): string | undefined {
  const delimiter = resolved.delimiter;
  const entries = paths.map((path): ListResponse => {
    const cut = delimiter ? path.lastIndexOf(delimiter) : -1;
    const parentPath = cut >= 0 ? path.slice(0, cut) : '';
    const name = cut >= 0 ? path.slice(cut + delimiter!.length) : path;
    // The next listing guesses roles from localized names such as Papierkorb, so the new mailbox gets the same guess.
    const guess = specialUse(false, { flags: new Set(), name });
    return {
      path,
      pathAsListed: path,
      name,
      delimiter: delimiter ?? '',
      parent: parentPath && delimiter ? parentPath.split(delimiter) : [],
      parentPath,
      flags: new Set(),
      listed: true,
      subscribed: true,
      ...(guess.flag ? { specialUse: guess.flag, specialUseSource: 'name' as const } : {}),
    };
  });
  const after = resolveFolders([...resolved.listing, ...entries], overrides);
  const overridden = (path: string | undefined) =>
    path !== undefined && after.folders.find((folder) => folder.id === path)?.roleSource === 'user';
  for (const path of paths) {
    const role = after.folders.find((folder) => folder.id === path)?.role;
    if (role && !overridden(path)) {
      return `A folder named "${path}" would be used as the ${role} folder. Choose another name.`;
    }
  }
  const changed = FOLDER_ROLES.find(
    (role) => resolved.paths[role] !== after.paths[role] && !overridden(after.paths[role]),
  );
  if (changed) {
    return `Creating "${paths.at(-1)}" would make it unclear which folder is the ${changed} folder. Choose another name.`;
  }
  return undefined;
}
