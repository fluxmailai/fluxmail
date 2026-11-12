#!/usr/bin/env node
// Claude Code PreToolUse hook for Bash. It blocks `gh pr create` in a
// repository that contains this script until the branch has been reviewed
// (by the code-reviewer or code-reviewer-complex agent, or /code-review and
// /security-review when the agent can't run, as REVIEW.md directs where the
// repo has one) and the review has been recorded with --mark.
//
// Hook:   node require-code-review.mjs            (reads hook JSON on stdin)
// Record: node require-code-review.mjs --mark [repo-path]
// Check:  node require-code-review.mjs --status [repo-path]
//
// A review is tied to a snapshot of the whole working tree (committed,
// uncommitted and untracked files that aren't ignored), so committing reviewed
// files keeps the review valid and any later edit needs a new one. Other git
// and gh commands pass through.

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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK_RELATIVE_PATH = join('.claude', 'hooks', 'require-code-review.mjs');
const AGENT_RELATIVE_PATH = join('.claude', 'agents', 'code-reviewer.md');
const COMPLEX_AGENT_RELATIVE_PATH = join('.claude', 'agents', 'code-reviewer-complex.md');
const MARKER_NAME = 'claude-code-review-tree';
// gh accepts flags such as `-R owner/repo` between its words, and `new` is an
// alias of `pr create`. `gh stack submit` opens pull requests for a stack.
const FLAGS = String.raw`(?:\s+-{1,2}[\w-]+(?:[=\s](?!-)\S+)?)*`;
const PR_CREATE = new RegExp(String.raw`\bgh${FLAGS}\s+(?:pr${FLAGS}\s+(?:create|new)|stack${FLAGS}\s+submit)\b`);
const DIR_CHANGE = /(?:^|[\s;&|(])(?:cd|pushd|popd)\b/;
// A leading `cd <dir> &&` (or `;`) moves where `gh` runs. Anything subtler
// than one literal path is rejected instead of guessed at.
const LEADING_CD = /^\s*cd\s+("[^"$`]*"|'[^']*'|[^\s;&|$`"']+)\s*(?:&&|;)/;

// The command with quoted text and heredoc bodies blanked out, so a commit
// message or `echo` that mentions `gh pr create` isn't mistaken for one.
function unquoted(command) {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' ')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function git(cwd, args, extraEnv) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function repoTop(dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

function gitPath(top, name) {
  return resolve(top, git(top, ['rev-parse', '--git-path', name]));
}

// The tree of the whole working tree, built in a throwaway copy of the index
// so the real index and staging area are never touched.
function workingTree(top) {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-review-'));
  const index = join(tmp, 'index');
  try {
    const indexPath = gitPath(top, 'index');
    if (existsSync(indexPath)) {
      copyFileSync(indexPath, index);
      // Git trusts cached file stats only for entries older than the index
      // file, so keep the original time, rounded down so the copy is never
      // newer, or edits made in the same second as the last index write
      // would be missed.
      const { atimeMs, mtimeMs } = statSync(indexPath);
      utimesSync(index, atimeMs / 1000, Math.floor(mtimeMs - 1) / 1000);
    }
    const env = { GIT_INDEX_FILE: index };
    git(top, ['add', '--all', '--', '.'], env);
    return git(top, ['write-tree'], env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readMarker(top) {
  try {
    return readFileSync(gitPath(top, MARKER_NAME), 'utf8').trim();
  } catch {
    return null;
  }
}

// A branch that deletes REVIEW.md still owes the review its base asks for.
function hasReviewGuide(top) {
  if (existsSync(join(top, 'REVIEW.md'))) return true;
  for (const base of ['origin/HEAD', 'origin/main']) {
    try {
      git(top, ['cat-file', '-e', `${base}:REVIEW.md`]);
      return true;
    } catch {
      // Try the next base, then fall back to a plain review.
    }
  }
  return false;
}

function blockReason(top) {
  const mark = `node ${JSON.stringify(join(top, HOOK_RELATIVE_PATH))} --mark ${JSON.stringify(top)}`;
  const agent = join(top, AGENT_RELATIVE_PATH);
  const complexAgent = join(top, COMPLEX_AGENT_RELATIVE_PATH);
  const scope = `everything the pull request will contain (the branch's changes against its base, plus uncommitted and untracked files in ${JSON.stringify(top)})`;
  const modelNote = "If your session isn't on the model REVIEW.md selects, tell the user which model ran the review.";
  const skill = hasReviewGuide(top)
    ? `/code-review high on ${scope}, told to read REVIEW.md first, plus /security-review when REVIEW.md calls for one. When the base's REVIEW.md differs from the branch's, or the branch deletes it, read the base's version with git show and follow the stricter rules. ${modelNote}`
    : `/code-review high on ${scope}.`;
  const review = existsSync(agent)
    ? `1. Select the Claude reviewer using the working and base versions of REVIEW.md: code-reviewer (${JSON.stringify(agent)}) for ordinary PRs, or code-reviewer-complex (${JSON.stringify(complexAgent)}) for complex PRs. Start it without model or effort overrides; both use high effort. Have the selected agent review the branch, naming ${JSON.stringify(top)} as the repository and the pull request's base branch. If code-reviewer replies that the PR is complex, start code-reviewer-complex instead. If you can't start the selected agent, or it says no review happened for another reason, run /code-review high on ${scope} yourself, following code-reviewer.md's steps for REVIEW.md and the security review (its read-only rules, its step that turns complex PRs away and its reply rules are for the agent only). ${modelNote} If no review can run, tell the user instead of recording one.`
    : `1. Run ${skill}`;
  return [
    `Pull request blocked: the branch in ${top} hasn't been reviewed.`,
    '',
    'Before opening the pull request:',
    review,
    '2. Fix every issue it flags. If you leave one unfixed on purpose, tell the user which one and why.',
    '3. Run the checks the change needs again.',
    `4. Record the review: ${mark}`,
    '5. Retry creating the pull request.',
    '',
    'Recording a review ties it to the current files. Any later edit needs another review before the pull request is opened.',
  ].join('\n');
}

function checkRepo(top) {
  if (!existsSync(join(top, HOOK_RELATIVE_PATH))) return { ok: true };
  if (readMarker(top) === workingTree(top)) return { ok: true };
  return { ok: false, reason: blockReason(top) };
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

// `command` is the unquoted text; `raw` keeps the quoted `cd` path.
function targetDir(command, raw, cwd) {
  const before = command.slice(0, command.search(PR_CREATE));
  const cd = raw.match(LEADING_CD);
  if (!cd) return DIR_CHANGE.test(before) ? null : cwd;
  if (DIR_CHANGE.test(before.slice(command.match(LEADING_CD)?.[0].length ?? 0))) return null;
  const dir = cd[1].replace(/^(["'])(.*)\1$/, '$2');
  if (dir === '-' || dir.startsWith('~')) return null;
  return resolve(cwd, dir);
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
  if (typeof command !== 'string') return;
  const plain = unquoted(command);
  if (!PR_CREATE.test(plain)) return;
  const dir = targetDir(plain, command, input.cwd || process.cwd());
  const top = dir && existsSync(dir) ? repoTop(dir) : null;
  if (!top) {
    deny(
      'Pull request blocked: the review gate could not tell which repository this pull request comes from. Run `gh pr create` from inside the repository, on its own or after one `cd` with a literal path.',
    );
    return;
  }
  try {
    const result = checkRepo(top);
    if (!result.ok) deny(result.reason);
  } catch (error) {
    console.error(`require-code-review: check failed in ${top}: ${error.message}`);
    deny(
      `Pull request blocked: the review gate failed in ${top}: ${error.message}. Fix the cause, or ask the user how to proceed.`,
    );
  }
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
  const tree = workingTree(top);
  writeFileSync(gitPath(top, MARKER_NAME), `${tree}\n`);
  console.log(`Recorded the code review for ${top} (tree ${tree}).`);
} else if (mode === '--status') {
  const top = repoFromArgs(arg);
  const result = checkRepo(top);
  console.log(result.ok ? `Pull requests allowed in ${top}.` : result.reason);
  process.exit(result.ok ? 0 : 1);
} else if (mode === undefined) {
  runHook();
} else {
  console.error(`Unknown option: ${mode}. Use --mark or --status, or no option to run as a hook.`);
  process.exit(2);
}
