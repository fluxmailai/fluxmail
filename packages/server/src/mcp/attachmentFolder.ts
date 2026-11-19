import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { lstat, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { lookup as lookupMimeType } from 'mime-types';
import type { AttachmentInput } from '@fluxmail/core';
import { expandHome } from '../deploymentConfig.js';
import { ClientInputError } from '../service/publicErrors.js';

/** A file in the attachment folder to attach, with optional overrides for its attachment metadata. */
export interface AttachmentFileInput {
  path: string;
  filename?: string;
  mimeType?: string;
  contentId?: string;
  disposition?: 'inline' | 'attachment';
}

/**
 * The one folder a local MCP connection may attach files from and save attachments to: the attachments folder in
 * the data directory, or one chosen with --attachment-dir. Mail is untrusted, so an instruction in a message could
 * ask for any local file. Paths are resolved through symbolic links and must stay inside the folder.
 */
export class AttachmentFolder {
  /** The folder as tools name it: under the home directory as ~/…, so the account name stays out of model context. */
  readonly label: string | undefined;

  private constructor(readonly root: string) {
    let home: string | undefined;
    try {
      home = realpathSync.native(homedir());
    } catch {
      // A service account's home directory may not exist. The folder is then named without a path.
    }
    const relative = home === undefined ? undefined : path.relative(home, root);
    this.label = relative && !isOutside(relative) ? `~/${relative.split(path.sep).join('/')}` : undefined;
  }

  /** Whether the folder holds the file or directory, so tools could reach it. */
  holds(location: string): boolean {
    return this.contains(resolvedPath(location));
  }

  /** Whether the folder is the directory or inside it. */
  isWithin(directory: string): boolean {
    const relative = path.relative(resolvedPath(directory), this.root);
    return relative === '' || !isOutside(relative);
  }

  /** Opens the folder at startup, so a missing folder is reported before the connection serves requests. */
  static open(directory: string): AttachmentFolder {
    // The native realpath returns the letter case on disk, as the fs/promises realpath used for each file does.
    const root = realpathSync.native(expandHome(directory));
    if (!statSync(root).isDirectory()) throw new Error(`${root} is not a folder.`);
    return new AttachmentFolder(root);
  }

  /**
   * A folder that isn't created yet, for a data directory that was never set up. Its connection lists the same
   * tools as one that is, and answers each call with the setup steps, so the folder is never read.
   */
  static planned(directory: string): AttachmentFolder {
    return new AttachmentFolder(path.resolve(expandHome(directory)));
  }

  /** The folder in a tool description: "the attachment folder", with its ~/… path when it has one. */
  get described(): string {
    return this.label ? `the attachment folder, ${this.label}` : 'the attachment folder';
  }

  private contains(resolved: string): boolean {
    const relative = path.relative(this.root, resolved);
    return relative === '' || !isOutside(relative);
  }

  /** A saved file as a tool result shows it: in the folder's ~/… path, or relative to the folder. */
  private shown(file: string): string {
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    return this.label ? `${this.label}/${relative}` : relative;
  }

  private requested(file: string): string {
    if (!file.trim() || file.includes('\0')) {
      throw new ClientInputError('invalid_request', 'Give a file path inside the attachment folder.');
    }
    const requested = path.resolve(this.root, file);
    // Checked before the file system is read, so a refusal doesn't tell whether a file outside the folder exists.
    if (!this.contains(requested)) throw this.outside(file);
    return requested;
  }

  private outside(file: string): ClientInputError {
    return new ClientInputError('invalid_request', `"${file}" is outside the attachment folder.`);
  }

  /** Reads a file to attach, refusing one larger than maxBytes before reading it. */
  async read(input: AttachmentFileInput, maxBytes: number): Promise<AttachmentInput> {
    let resolved: string;
    try {
      resolved = await realpath(this.requested(input.path));
    } catch (error) {
      if (error instanceof ClientInputError) throw error;
      throw new ClientInputError('invalid_request', `No file "${input.path}" in the attachment folder.`);
    }
    if (!this.contains(resolved)) throw this.outside(input.path);
    const info = await stat(resolved);
    if (!info.isFile()) throw new ClientInputError('invalid_request', `"${input.path}" is not a file.`);
    if (info.size > maxBytes) {
      throw new ClientInputError('invalid_request', `"${input.path}" is larger than the attachment limit.`, {
        sizeBytes: info.size,
        maxBytes,
      });
    }
    const filename = input.filename ?? path.basename(resolved);
    return {
      filename,
      mimeType: input.mimeType ?? (lookupMimeType(filename) || 'application/octet-stream'),
      content: (await readFile(resolved)).toString('base64'),
      ...(input.contentId ? { contentId: input.contentId } : {}),
      ...(input.disposition ? { disposition: input.disposition } : {}),
    };
  }

  /**
   * The path a new file would be saved at, refused when it is outside the folder, its folder is missing, or a
   * file has the name. A caller checks it before downloading, so a refused name costs no download.
   */
  async newFile(file: string): Promise<string> {
    const requested = this.requested(file);
    let parent: string;
    try {
      parent = await realpath(path.dirname(requested));
    } catch {
      throw new ClientInputError('invalid_request', `The folder for "${file}" doesn't exist in the attachment folder.`);
    }
    if (!this.contains(parent) || requested === this.root) throw this.outside(file);
    const target = path.join(parent, path.basename(requested));
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw new ClientInputError('invalid_request', `"${file}" already exists. Choose another name.`);
    return target;
  }

  /**
   * Saves content as a new file and returns its path as tools show it. The file must not exist yet, and its folder
   * must already exist inside the attachment folder.
   */
  async write(file: string, content: Buffer): Promise<string> {
    const target = await this.newFile(file);
    let handle;
    try {
      // wx fails when anything, including a symbolic link, already has the name.
      handle = await open(target, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ClientInputError('invalid_request', `"${file}" already exists. Choose another name.`);
      }
      throw error;
    }
    try {
      await handle.writeFile(content);
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(target, { force: true });
      throw error;
    }
    return this.shown(target);
  }
}

/** Whether a path relative to a folder leaves it. A name such as ..notes.pdf stays inside. */
function isOutside(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** A location through its symbolic links. A part that doesn't exist yet is joined to its nearest existing parent. */
function resolvedPath(location: string): string {
  const absolute = path.resolve(expandHome(location));
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(resolvedPath(parent), path.basename(absolute));
  }
}
