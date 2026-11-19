import { realpathSync, statSync } from 'node:fs';
import { open, readFile, realpath, rm, stat } from 'node:fs/promises';
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
 * The one folder a local MCP connection may attach files from and save attachments to. Mail is untrusted, so an
 * instruction in a message could ask for any local file. Paths are resolved through symbolic links and must stay
 * inside the folder, which the user chose when starting the connection.
 */
export class AttachmentFolder {
  private constructor(readonly root: string) {}

  /** Opens the folder at startup, so a missing folder is reported before the connection serves requests. */
  static open(directory: string): AttachmentFolder {
    const root = realpathSync(expandHome(directory));
    if (!statSync(root).isDirectory()) throw new Error(`${root} is not a folder.`);
    return new AttachmentFolder(root);
  }

  private contains(resolved: string): boolean {
    const relative = path.relative(this.root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
    return new ClientInputError('invalid_request', `"${file}" is outside the attachment folder, ${this.root}.`);
  }

  /** Reads a file to attach, refusing one larger than maxBytes before reading it. */
  async read(input: AttachmentFileInput, maxBytes: number): Promise<AttachmentInput> {
    let resolved: string;
    try {
      resolved = await realpath(this.requested(input.path));
    } catch (error) {
      if (error instanceof ClientInputError) throw error;
      throw new ClientInputError('invalid_request', `No file "${input.path}" in the attachment folder, ${this.root}.`);
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
   * Saves content as a new file and returns its path. The file must not exist yet, and its folder must already
   * exist inside the attachment folder.
   */
  async write(file: string, content: Buffer): Promise<string> {
    const requested = this.requested(file);
    const name = path.basename(requested);
    let parent: string;
    try {
      parent = await realpath(path.dirname(requested));
    } catch {
      throw new ClientInputError('invalid_request', `The folder for "${file}" doesn't exist in the attachment folder.`);
    }
    if (!this.contains(parent) || requested === this.root) throw this.outside(file);
    const target = path.join(parent, name);
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
    return target;
  }
}
