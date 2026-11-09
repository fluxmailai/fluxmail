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
// content must match the reviewed files.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK_RELATIVE_PATH = join('.claude', 'hooks', 'require-code-review.mjs');
const MARKER_NAME = 'claude-code-review-tree';
const IN_PROGRESS_NAMES = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
];
// Words that can precede the real command name in a simple command.
const PREFIX_WORDS = new Set([
  '!',
  '{',
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
  const out = git(top, [
    'rev-parse',
    ...names.flatMap(name => ['--git-path', name]),
  ]).split('\n');
  return Object.fromEntries(
    names.map((name, i) => [name, resolve(top, out[i])])
  );
}

// Trees for the staged content and for the whole working tree, built in a
// throwaway index so the real index and staging area are never touched.
function snapshotTrees(top, indexPath) {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-review-'));
  const index = join(tmp, 'index');
  try {
    if (existsSync(indexPath)) copyFileSync(indexPath, index);
    const env = { GIT_INDEX_FILE: index };
    const staged = git(top, ['write-tree'], env);
    git(top, ['add', '--all', '--', '.'], env);
    return { staged, working: git(top, ['write-tree'], env) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function changedPaths(top, from, to) {
  const args = from
    ? ['diff-tree', '-r', '--name-only', '-z', from, to]
    : ['ls-tree', '-r', '--name-only', '-z', to];
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
  // appended to this.commands before the command that contains them.
  scan(close, scope) {
    let words = [];
    let word = null;
    const endWord = () => {
      if (word) words.push(word);
      word = null;
    };
    const endCommand = () => {
      endWord();
      if (words.length) this.commands.push({ words, scope });
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

function expandPath(base, word) {
  if (word.dynamic) return null;
  let path = word.text;
  if (path === '~' || path.startsWith('~/'))
    path = join(homedir(), path.slice(1));
  return resolve(base, path);
}

// Returns where a `git ... commit` command runs, or null for other git commands.
function gitCommitTarget(words, start, dir) {
  let gitDir = dir;
  let unresolved = false;
  const setDir = word => {
    const path = word ? expandPath(gitDir, word) : null;
    if (path) gitDir = path;
    else unresolved = true;
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
    } else if (
      ['-c', '--git-dir', '--namespace', '--exec-path'].includes(opt)
    ) {
      i += 2;
    } else if (opt.startsWith('-')) {
      i++;
    } else {
      break;
    }
  }
  return words[i]?.text === 'commit' ? { dir: gitDir, unresolved } : null;
}

// Returns [{ dir, unresolved }] for each `git commit` in the command.
function findCommitTargets(command, cwd) {
  const scanner = new Scanner(command);
  const root = { parent: null };
  scanner.scan(null, root);
  const dirs = new Map([[root, cwd]]);
  const dirOf = scope => {
    if (!dirs.has(scope)) dirs.set(scope, dirOf(scope.parent));
    return dirs.get(scope);
  };
  const targets = [];

  for (const { words, scope } of scanner.commands) {
    const dir = dirOf(scope);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text))
      i++;
    while (i < words.length && PREFIX_WORDS.has(words[i].text)) i++;
    const name = words[i]?.text;
    if (name === undefined) continue;
    const base = name.slice(name.lastIndexOf('/') + 1);

    if (name === 'cd' || name === 'pushd') {
      const arg = words.slice(i + 1).find(w => !w.text.startsWith('-'));
      dirs.set(scope, arg ? (expandPath(dir, arg) ?? dir) : homedir());
    } else if (base === 'git') {
      const target = gitCommitTarget(words, i + 1, dir);
      if (target) targets.push(target);
    } else if (SHELLS.has(base)) {
      const flag = words.findIndex(
        (w, j) => j > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text)
      );
      if (flag !== -1 && words[flag + 1])
        targets.push(...findCommitTargets(words[flag + 1].text, dir));
    } else if (name === 'eval') {
      const script = words
        .slice(i + 1)
        .map(w => w.text)
        .join(' ');
      targets.push(...findCommitTargets(script, dir));
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
    `1. Run /code-review --fix on all uncommitted changes in ${top}: the output of \`git -C ${JSON.stringify(top)} diff HEAD\` plus every untracked file that \`git -C ${JSON.stringify(top)} status --short\` lists.`,
    '2. Fix every issue it flags. If you leave one unfixed on purpose, tell the user which one and why.',
    '3. Run the checks the change needs again.',
    `4. Record the review: ${mark}`,
    '5. Retry the commit.',
    '',
    'Recording a review ties it to the current files. Any later edit needs another review.',
  ].join('\n');
}

function checkRepo(top) {
  if (!existsSync(join(top, HOOK_RELATIVE_PATH))) return { ok: true };
  const paths = gitPaths(top, ['index', MARKER_NAME, ...IN_PROGRESS_NAMES]);
  if (IN_PROGRESS_NAMES.some(name => existsSync(paths[name])))
    return { ok: true };

  const { staged, working } = snapshotTrees(top, paths.index);
  const head = tryGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']);
  if (staged === head && working === head) return { ok: true };
  if (readMarker(paths[MARKER_NAME]) !== working)
    return { ok: false, reason: blockReason(top) };

  const stagedChanges = new Set(changedPaths(top, head, staged));
  const unreviewed = changedPaths(top, staged, working).filter(path =>
    stagedChanges.has(path)
  );
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
    })
  );
}

function runHook() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    console.error(
      `require-code-review: couldn't parse hook input: ${error.message}`
    );
    return;
  }
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !/\bcommit\b/.test(command)) return;
  const cwd = input.cwd || process.cwd();

  const reasons = [];
  const seen = new Set();
  for (const target of findCommitTargets(command, cwd)) {
    if (target.unresolved) {
      reasons.push(
        'Commit blocked: the review gate could not tell which repository this `git commit` runs in. Use a literal path with `git -C` or `cd`, without shell variables.'
      );
      continue;
    }
    if (!existsSync(target.dir)) {
      reasons.push(
        `Commit blocked: ${target.dir} doesn't exist yet, so the review gate can't check it. Create it in one command, then commit in a separate one.`
      );
      continue;
    }
    const top = repoTop(target.dir);
    if (!top || seen.has(top)) continue;
    seen.add(top);
    try {
      const result = checkRepo(top);
      if (!result.ok) reasons.push(result.reason);
    } catch (error) {
      console.error(
        `require-code-review: check failed in ${top}: ${error.message}`
      );
      reasons.push(
        `Commit blocked: the review gate failed in ${top}: ${error.message}. Fix the cause, or ask the user how to proceed.`
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
  console.log(
    `Recorded the code review for the current changes in ${top} (tree ${working}).`
  );
} else if (mode === '--status') {
  const top = repoFromArgs(arg);
  const result = checkRepo(top);
  console.log(result.ok ? `Commits allowed in ${top}.` : result.reason);
  process.exit(result.ok ? 0 : 1);
} else if (mode === undefined) {
  runHook();
} else {
  console.error(
    `Unknown option: ${mode}. Use --mark or --status, or no option to run as a hook.`
  );
  process.exit(2);
}
