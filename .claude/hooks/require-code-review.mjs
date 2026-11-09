#!/usr/bin/env node
// Claude Code PreToolUse hook for Bash. It blocks `git commit` in a repository
// that contains this script until the current uncommitted changes have been
// reviewed with /code-review and the review has been recorded with --mark.
//
// Hook:   node require-code-review.mjs            (reads hook JSON on stdin)
// Record: node require-code-review.mjs --mark [repo-path]
// Check:  node require-code-review.mjs --status [repo-path]
//
// A review is tied to a snapshot of the whole working tree (tracked and
// untracked files that aren't ignored). Any edit after --mark needs a new
// review. Committing part of a reviewed snapshot leaves the snapshot
// unchanged, so the rest can be committed without another review. Staged
// content must match the reviewed files. The hook runs before the whole Bash
// call, so only read-only commands may come before `git commit` in it.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const HOOK_RELATIVE_PATH = join('.claude', 'hooks', 'require-code-review.mjs');
const MARKER_NAME = 'claude-code-review-tree';
const IN_PROGRESS_NAMES = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
// Words that can precede the real command name in a simple command.
const PREFIX_WORDS = new Set([
  '!',
  '{',
  'builtin',
  'command',
  'do',
  'elif',
  'else',
  'env',
  'exec',
  'if',
  'nohup',
  'then',
  'time',
  'until',
  'while',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
// Commands that may run before `git commit` in the same Bash call. Anything
// else could change files after the hook has checked them.
const READ_ONLY_COMMANDS = new Set([
  ':',
  '[',
  'cat',
  'cd',
  'echo',
  'export',
  'ls',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'set',
  'test',
  'true',
  'unset',
]);
const READ_ONLY_GIT = new Set(['diff', 'log', 'ls-files', 'rev-parse', 'show', 'status']);
// These change only the index. The hook replays them on its copy of the index.
const STAGING_GIT = new Set(['add', 'stage']);
const COMMIT_SHORT_OPTIONS_WITH_VALUE = 'mFCct';
// `-S<keyid>` and `-u<mode>` take an optional value in the same word.
const COMMIT_SHORT_OPTIONS_WITH_ATTACHED_VALUE = 'Su';
const COMMIT_LONG_OPTIONS_WITH_VALUE = new Set([
  '--author',
  '--cleanup',
  '--date',
  '--file',
  '--fixup',
  '--message',
  '--pathspec-from-file',
  '--reedit-message',
  '--reuse-message',
  '--squash',
  '--template',
  '--trailer',
]);

function git(cwd, args, extraEnv) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

// Resolves several repository paths with one git call.
function gitPaths(top, names) {
  const out = git(top, ['rev-parse', ...names.flatMap((name) => ['--git-path', name])]).split('\n');
  return Object.fromEntries(names.map((name, i) => [name, resolve(top, out[i])]));
}

// Trees for the staged content and for the whole working tree, built in a
// throwaway index so the real index and staging area are never touched.
// `adds` are `git add` commands that run before the commit in the same Bash
// call; they're replayed on the copy so `staged` matches what gets committed.
function snapshotTrees(top, indexPath, adds = []) {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-review-'));
  const index = join(tmp, 'index');
  try {
    if (existsSync(indexPath)) {
      copyFileSync(indexPath, index);
      // Git trusts cached file stats only for entries older than the index
      // file. A fresh mtime on the copy would hide edits made in the same
      // second as the last index write, so keep the original time, rounded
      // down so the copy is never newer.
      const { atimeMs, mtimeMs } = statSync(indexPath);
      utimesSync(index, atimeMs / 1000, Math.floor(mtimeMs - 1) / 1000);
    }
    const env = { GIT_INDEX_FILE: index };
    for (const add of adds) {
      if (repoTop(add.dir) !== top) continue;
      try {
        git(add.dir, ['add', ...add.args], env);
      } catch {
        // The real `git add` fails the same way and changes nothing.
      }
    }
    const staged = git(top, ['write-tree'], env);
    git(top, ['add', '--all', '--', '.'], env);
    return { staged, working: git(top, ['write-tree'], env) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function changedPaths(top, from, to) {
  const args = from ? ['diff-tree', '-r', '--name-only', '-z', from, to] : ['ls-tree', '-r', '--name-only', '-z', to];
  return git(top, args).split('\0').filter(Boolean);
}

function readMarker(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function repoTop(dir) {
  return tryGit(dir, ['rev-parse', '--show-toplevel']);
}

// --- Shell parsing -------------------------------------------------------
// Enough of POSIX shell to find simple commands without being fooled by
// quoted text, heredoc bodies or comments. Each command records the subshell
// scope it runs in, so a `cd` inside ( ... ) or $( ... ) stays inside it.

class Scanner {
  constructor(src) {
    this.src = src;
    this.i = 0;
    this.commands = [];
    this.pendingHeredocs = [];
  }

  // Scans until `close` (or end of input). Commands from nested scopes are
  // appended to this.commands before the command that contains them. Output
  // redirection targets are dropped from a command's words; `writes` records
  // whether any of them is a file other than /dev/null.
  scan(close, scope) {
    let words = [];
    let word = null;
    const endWord = () => {
      if (word) words.push(word);
      word = null;
    };
    const endCommand = () => {
      endWord();
      const writes = words.some((w) => w.redirect && w.text !== '/dev/null');
      const args = words.filter((w) => !w.redirect);
      if (args.length || writes) this.commands.push({ words: args, scope, writes });
      words = [];
    };
    const appendText = (text, dynamic = false) => {
      word ??= { text: '', dynamic: false };
      word.text += text;
      word.dynamic ||= dynamic;
    };

    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      const next = this.src[this.i + 1];

      if (close && ch === close) {
        this.i++;
        endCommand();
        return;
      }
      if (this.scanExpansion(appendText, scope)) continue;
      if (ch === '\\') {
        if (next !== '\n') appendText(next ?? '');
        this.i += 2;
        continue;
      }
      if (ch === "'") {
        const end = this.src.indexOf("'", this.i + 1);
        const stop = end === -1 ? this.src.length : end;
        appendText(this.src.slice(this.i + 1, stop));
        this.i = stop + 1;
        continue;
      }
      if (ch === '"') {
        this.i++;
        appendText('');
        this.scanDoubleQuoted(appendText, scope);
        continue;
      }
      if (ch === '#' && word === null) {
        while (this.i < this.src.length && this.src[this.i] !== '\n') this.i++;
        continue;
      }
      if (ch === '\n') {
        this.i++;
        endCommand();
        this.readPendingHeredocs();
        continue;
      }
      if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
        this.i++;
        if ((ch === '&' || ch === '|' || ch === ';') && next === ch) this.i++;
        endCommand();
        if (ch === '(') this.scan(')', { parent: scope });
        continue;
      }
      if (ch === '<' && next === '<') {
        endWord();
        if (this.src[this.i + 2] === '<') {
          this.i += 3;
          continue;
        }
        this.i += 2;
        const stripTabs = this.src[this.i] === '-';
        if (stripTabs) this.i++;
        while (this.src[this.i] === ' ' || this.src[this.i] === '\t') this.i++;
        const delimiter = this.readHeredocDelimiter();
        if (delimiter) this.pendingHeredocs.push({ delimiter, stripTabs });
        continue;
      }
      if (ch === '>') {
        // Digits right before `>` name a file descriptor, not an argument.
        if (word && !word.dynamic && /^\d+$/.test(word.text)) word = null;
        endWord();
        this.i++;
        if (this.src[this.i] === '>' || this.src[this.i] === '|') this.i++;
        if (this.src[this.i] === '&') {
          // `>&N` and `>&-` duplicate or close a descriptor.
          this.i++;
          while (/[\d-]/.test(this.src[this.i] ?? '')) this.i++;
          continue;
        }
        while (this.src[this.i] === ' ' || this.src[this.i] === '\t') this.i++;
        word = { text: '', dynamic: false, redirect: true };
        continue;
      }
      if (ch === ' ' || ch === '\t') {
        endWord();
        this.i++;
        continue;
      }
      appendText(ch);
      this.i++;
    }
    endCommand();
  }

  scanDoubleQuoted(appendText, scope) {
    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      if (ch === '"') {
        this.i++;
        return;
      }
      if (this.scanExpansion(appendText, scope)) continue;
      if (ch === '\\') {
        appendText(this.src[this.i + 1] ?? '');
        this.i += 2;
        continue;
      }
      appendText(ch);
      this.i++;
    }
  }

  // Handles $(...), $((...)), `...` and $ at the current position. Returns
  // false when the current character starts none of them.
  scanExpansion(appendText, scope) {
    const ch = this.src[this.i];
    if (ch === '`') {
      this.i++;
      this.scanBacktick(scope);
      appendText('`...`', true);
      return true;
    }
    if (ch !== '$') return false;
    if (this.src[this.i + 1] !== '(') {
      appendText('$', true);
      this.i++;
      return true;
    }
    this.i += 2;
    if (this.src[this.i] === '(') this.skipArithmetic();
    else this.scan(')', { parent: scope });
    appendText('$(...)', true);
    return true;
  }

  scanBacktick(scope) {
    let body = '';
    while (this.i < this.src.length && this.src[this.i] !== '`') {
      if (this.src[this.i] === '\\') {
        body += this.src[this.i + 1] ?? '';
        this.i += 2;
        continue;
      }
      body += this.src[this.i++];
    }
    this.i++;
    const inner = new Scanner(body);
    inner.scan(null, { parent: scope });
    this.commands.push(...inner.commands);
  }

  skipArithmetic() {
    let depth = 2;
    this.i++;
    while (this.i < this.src.length && depth > 0) {
      if (this.src[this.i] === '(') depth++;
      else if (this.src[this.i] === ')') depth--;
      this.i++;
    }
  }

  readHeredocDelimiter() {
    let delimiter = '';
    while (this.i < this.src.length && !/[\s;&|<>()]/.test(this.src[this.i])) {
      const ch = this.src[this.i];
      if (ch === "'" || ch === '"') {
        const end = this.src.indexOf(ch, this.i + 1);
        const stop = end === -1 ? this.src.length : end;
        delimiter += this.src.slice(this.i + 1, stop);
        this.i = stop + 1;
        continue;
      }
      if (ch === '\\') {
        delimiter += this.src[this.i + 1] ?? '';
        this.i += 2;
        continue;
      }
      delimiter += ch;
      this.i++;
    }
    return delimiter;
  }

  readPendingHeredocs() {
    while (this.pendingHeredocs.length) {
      const { delimiter, stripTabs } = this.pendingHeredocs.shift();
      while (this.i < this.src.length) {
        const end = this.src.indexOf('\n', this.i);
        const stop = end === -1 ? this.src.length : end;
        let line = this.src.slice(this.i, stop);
        this.i = stop + 1;
        if (stripTabs) line = line.replace(/^\t+/, '');
        if (line === delimiter) break;
      }
    }
  }
}

// Returns the absolute path for a word, or null when it can't be known
// statically. A null base means the current directory is unknown.
function expandPath(base, word) {
  if (word.dynamic) return null;
  let path = word.text;
  if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
  if (isAbsolute(path)) return resolve(path);
  return base === null ? null : resolve(base, path);
}

// Parses a git command line starting after `git`. Returns the subcommand, its
// arguments and the directory it runs in. A null dir means the directory is
// unknown.
function parseGit(words, start, dir) {
  let gitDir = dir;
  let unresolved = dir === null;
  const setDir = (word) => {
    const path = word ? expandPath(gitDir, word) : null;
    gitDir = path;
    unresolved = path === null;
  };
  let i = start;
  while (i < words.length) {
    const opt = words[i].text;
    if (opt === '-C' || opt === '--work-tree') {
      setDir(words[i + 1]);
      i += 2;
    } else if (opt.startsWith('--work-tree=')) {
      setDir({ ...words[i], text: opt.slice('--work-tree='.length) });
      i++;
    } else if (['-c', '--git-dir', '--namespace', '--exec-path'].includes(opt)) {
      i += 2;
    } else if (opt.startsWith('-')) {
      i++;
    } else {
      break;
    }
  }
  return {
    subcommand: words[i]?.text,
    args: words.slice(i + 1),
    dir: gitDir,
    unresolved,
  };
}

// Whether `git commit` with these arguments takes tracked files from the
// working tree instead of the index: `-a`, or pathspecs without `-i`.
function commitUsesWorkingTree(args) {
  let all = false;
  let include = false;
  let paths = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].text;
    if (arg === '--') {
      paths ||= i + 1 < args.length;
      break;
    }
    if (arg === '--all') all = true;
    else if (arg === '--include') include = true;
    else if (arg.startsWith('--')) {
      if (COMMIT_LONG_OPTIONS_WITH_VALUE.has(arg)) i++;
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === 'a') all = true;
        else if (arg[j] === 'i') include = true;
        else if (COMMIT_SHORT_OPTIONS_WITH_ATTACHED_VALUE.includes(arg[j])) break;
        else if (COMMIT_SHORT_OPTIONS_WITH_VALUE.includes(arg[j])) {
          // The value is the rest of this word, or the next word.
          if (j === arg.length - 1) i++;
          break;
        }
      }
    } else {
      paths = true;
    }
  }
  return all || (paths && !include);
}

// Returns [{ dir, unresolved, hidden, unsafeBefore, usesWorkingTree, adds }]
// for each `git commit` in the command. Once a directory change can't be
// followed (a shell variable, `cd -` or `popd`), the directory is null until
// an absolute `cd` makes it known again. `hidden` marks an eval or sh -c
// script that can't be read. `unsafeBefore` names the first earlier command
// that could change files, since the hook checks files before any of them
// run. `adds` lists the earlier `git add` commands.
function findCommitTargets(command, cwd, state = { unsafe: null, adds: [] }) {
  const scanner = new Scanner(command);
  const root = { parent: null };
  scanner.scan(null, root);
  const dirs = new Map([[root, cwd]]);
  const dirOf = (scope) => {
    if (!dirs.has(scope)) dirs.set(scope, dirOf(scope.parent));
    return dirs.get(scope);
  };
  const targets = [];

  for (const { words, scope, writes } of scanner.commands) {
    const dir = dirOf(scope);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text)) i++;
    while (i < words.length && PREFIX_WORDS.has(words[i].text)) i++;
    const name = words[i]?.text;
    const base = name?.slice(name.lastIndexOf('/') + 1);
    const git = base === 'git' ? parseGit(words, i + 1, dir) : null;
    let readOnly = name === undefined || READ_ONLY_COMMANDS.has(name) || READ_ONLY_GIT.has(git?.subcommand);

    if (name === undefined) {
      // Only variable assignments or redirections.
    } else if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const args = words.slice(i + 1);
      const arg = args.find((w) => !w.text.startsWith('-'));
      const usesStack =
        name === 'popd' || args.some((w) => w.text === '-') || (name === 'pushd' && (!arg || arg.text.startsWith('+')));
      if (usesStack) dirs.set(scope, null);
      else dirs.set(scope, arg ? expandPath(dir, arg) : homedir());
    } else if (git?.subcommand === 'commit') {
      targets.push({
        dir: git.dir,
        unresolved: git.unresolved,
        hidden: false,
        unsafeBefore: state.unsafe,
        usesWorkingTree: commitUsesWorkingTree(git.args),
        adds: [...state.adds],
      });
    } else if (STAGING_GIT.has(git?.subcommand)) {
      // A `git add` that can't be replayed exactly counts as unsafe.
      readOnly = !git.unresolved && !git.args.some((w) => w.dynamic);
      if (readOnly) state.adds.push({ dir: git.dir, args: git.args.map((w) => w.text) });
    } else if (SHELLS.has(base) || name === 'eval') {
      // The script's commands are checked one by one, like the outer ones.
      let script;
      if (name === 'eval') {
        script = words.slice(i + 1);
      } else {
        const flag = words.findIndex((w, j) => j > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text));
        script = flag === -1 ? null : words.slice(flag + 1, flag + 2);
      }
      if (script?.some((w) => w.dynamic)) {
        targets.push({ dir, hidden: true });
      } else if (script?.length) {
        const text = script.map((w) => w.text).join(' ');
        targets.push(...findCommitTargets(text, dir, state));
        readOnly = true;
      }
    }

    if ((writes || !readOnly) && !state.unsafe) {
      if (writes) state.unsafe = `${name ?? ''} >`.trim();
      else if (git) state.unsafe = `git ${git.subcommand ?? ''}`.trim();
      else state.unsafe = name;
    }
  }
  return targets;
}

// --- Gate ----------------------------------------------------------------

function blockReason(top) {
  const mark = `node ${JSON.stringify(join(top, HOOK_RELATIVE_PATH))} --mark ${JSON.stringify(top)}`;
  return [
    `Commit blocked: the uncommitted changes in ${top} haven't been through /code-review.`,
    '',
    'Before committing:',
    `1. Run /code-review high --fix on all uncommitted changes in ${top}: the output of \`git -C ${JSON.stringify(top)} diff HEAD\` plus every untracked file that \`git -C ${JSON.stringify(top)} status --short\` lists.`,
    '2. Fix every issue it flags. If you leave one unfixed on purpose, tell the user which one and why.',
    '3. Run the checks the change needs again.',
    `4. Record the review: ${mark}`,
    '5. Retry the commit.',
    '',
    'Recording a review ties it to the current files. Any later edit needs another review.',
  ].join('\n');
}

// `commit` describes the `git commit` being checked: the first earlier command
// in the same Bash call that could change files, and whether the commit takes
// tracked files from the working tree.
function checkRepo(top, commit = { unsafeBefore: null, usesWorkingTree: false, adds: [] }) {
  if (!existsSync(join(top, HOOK_RELATIVE_PATH))) return { ok: true };
  const paths = gitPaths(top, ['index', MARKER_NAME, ...IN_PROGRESS_NAMES]);
  if (IN_PROGRESS_NAMES.some((name) => existsSync(paths[name]))) return { ok: true };
  if (commit.unsafeBefore)
    return {
      ok: false,
      reason: `Commit blocked: \`${commit.unsafeBefore}\` runs before \`git commit\` in the same command and could change files after the review gate checked them. Run it on its own first. Only \`cd\`, \`git add\`, \`git status\`, \`git diff\` and other read-only commands can come before \`git commit\` in one command.`,
    };

  const { staged, working } = snapshotTrees(top, paths.index, commit.adds);
  const head = tryGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']);
  if (staged === head && working === head) return { ok: true };
  if (readMarker(paths[MARKER_NAME]) !== working) return { ok: false, reason: blockReason(top) };
  if (commit.usesWorkingTree) return { ok: true };

  const stagedChanges = new Set(changedPaths(top, head, staged));
  const unreviewed = changedPaths(top, staged, working).filter((path) => stagedChanges.has(path));
  if (unreviewed.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `Commit blocked: staged content in ${top} differs from the reviewed files: ${unreviewed.join(', ')}. Stage the reviewed versions with \`git add\`, or review the staged content and record the review again.`,
  };
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

function runHook() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    console.error(`require-code-review: couldn't parse hook input: ${error.message}`);
    return;
  }
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !/\bcommit\b/.test(command)) return;
  const cwd = input.cwd || process.cwd();

  const reasons = [];
  const seen = new Set();
  for (const target of findCommitTargets(command, cwd)) {
    if (target.hidden) {
      reasons.push(
        "Commit blocked: this command runs `eval` or `sh -c` on a shell variable or command substitution, so the review gate can't see whether it commits. Write the commands out, or run `git commit` directly.",
      );
      continue;
    }
    if (target.unresolved) {
      reasons.push(
        'Commit blocked: the review gate could not tell which repository this `git commit` runs in. Use a literal path with `git -C` or `cd`, without shell variables, `cd -`, `popd` or a `pushd` that uses the directory stack.',
      );
      continue;
    }
    if (!existsSync(target.dir)) {
      reasons.push(
        `Commit blocked: ${target.dir} doesn't exist yet, so the review gate can't check it. Create it in one command, then commit in a separate one.`,
      );
      continue;
    }
    const top = repoTop(target.dir);
    const key = JSON.stringify([top, target.unsafeBefore, target.usesWorkingTree, target.adds]);
    if (!top || seen.has(key)) continue;
    seen.add(key);
    try {
      const result = checkRepo(top, target);
      if (!result.ok) reasons.push(result.reason);
    } catch (error) {
      console.error(`require-code-review: check failed in ${top}: ${error.message}`);
      reasons.push(
        `Commit blocked: the review gate failed in ${top}: ${error.message}. Fix the cause, or ask the user how to proceed.`,
      );
    }
  }
  if (reasons.length) deny(reasons.join('\n\n'));
}

function repoFromArgs(arg) {
  const dir = resolve(arg ?? process.cwd());
  const top = repoTop(dir);
  if (!top) {
    console.error(`Not a git repository: ${dir}`);
    process.exit(1);
  }
  return top;
}

const [mode, arg] = process.argv.slice(2);
if (mode === '--mark') {
  const top = repoFromArgs(arg);
  const paths = gitPaths(top, ['index', MARKER_NAME]);
  const { working } = snapshotTrees(top, paths.index);
  writeFileSync(paths[MARKER_NAME], `${working}\n`);
  console.log(`Recorded the code review for the current changes in ${top} (tree ${working}).`);
} else if (mode === '--status') {
  const top = repoFromArgs(arg);
  const result = checkRepo(top);
  console.log(result.ok ? `Commits allowed in ${top}.` : result.reason);
  process.exit(result.ok ? 0 : 1);
} else if (mode === undefined) {
  runHook();
} else {
  console.error(`Unknown option: ${mode}. Use --mark or --status, or no option to run as a hook.`);
  process.exit(2);
}
