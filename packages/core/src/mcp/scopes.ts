import type { ModifyAction } from '../types.js';

/** Mail scopes shared by every Fluxmail product, in display order. */
export const MAIL_SCOPES = [
  'mail.read',
  'mail.drafts',
  'mail.organize',
  'mail.trash',
  'mail.delete',
  'mail.send',
] as const;

export type MailScope = (typeof MAIL_SCOPES)[number];

export const PERMISSION_PRESET_NAMES = ['read-only', 'read-write', 'full'] as const;
export type PermissionPreset = (typeof PERMISSION_PRESET_NAMES)[number];

export const PERMISSION_PRESETS: Record<PermissionPreset, readonly MailScope[]> = {
  'read-only': ['mail.read'],
  'read-write': ['mail.read', 'mail.drafts', 'mail.organize', 'mail.trash'],
  // Permanent deletion is never part of a preset; it must be allowed explicitly.
  full: MAIL_SCOPES.filter((scope) => scope !== 'mail.delete'),
};

export type ModifyActionName = Exclude<ModifyAction, object> | 'move' | 'addLabels' | 'removeLabels';

/** The scope each modify action needs. */
export const MODIFY_ACTION_SCOPES: Record<ModifyActionName, MailScope> = {
  markRead: 'mail.organize',
  markUnread: 'mail.organize',
  star: 'mail.organize',
  unstar: 'mail.organize',
  archive: 'mail.organize',
  move: 'mail.organize',
  addLabels: 'mail.organize',
  removeLabels: 'mail.organize',
  trash: 'mail.trash',
  untrash: 'mail.trash',
  delete: 'mail.delete',
};
