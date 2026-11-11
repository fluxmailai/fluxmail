import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { measureStep, type TimedStep } from '../operationTiming.js';

type Exec = (command: string, ...rest: unknown[]) => Promise<unknown>;

/** The step an IMAP command's time counts toward. */
export function imapCommandStep(command: string): TimedStep {
  switch (command.toUpperCase().replace(/^UID /, '')) {
    case 'LIST':
    case 'XLIST':
    case 'LSUB':
    case 'STATUS':
      return 'imap_list';
    case 'SELECT':
    case 'EXAMINE':
      return 'imap_select';
    case 'SEARCH':
    case 'SORT':
      return 'imap_search';
    case 'FETCH':
      return 'imap_fetch';
    default:
      return 'imap_other';
  }
}

/** An IMAP client that counts each command's time toward the operation that sent it. */
export class TimedImapFlow extends ImapFlow {
  private connecting = false;

  constructor(options: ImapFlowOptions) {
    super(options);
    // imapflow sends every command through exec, which its types leave out.
    // Commands sent while connecting count toward the connection instead.
    // Timing is only telemetry, so a changed imapflow leaves commands as they are.
    const self = this as unknown as { exec?: Exec };
    if (typeof self.exec !== 'function') return;
    const exec = self.exec.bind(this);
    self.exec = (command, ...rest) =>
      this.connecting || typeof command !== 'string'
        ? exec(command, ...rest)
        : measureStep(imapCommandStep(command), () => exec(command, ...rest));
  }

  override async connect(): Promise<void> {
    this.connecting = true;
    try {
      await measureStep('imap_connect', () => super.connect());
    } finally {
      this.connecting = false;
    }
  }
}
