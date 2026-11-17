import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareTools, issueBody, previousStableTag, recordedSince } from './mcpb-listing.mjs';

describe('previousStableTag', () => {
  it('picks the newest stable tag before the release', () => {
    const tags = ['v0.9.0', 'v0.30.0', 'v0.29.0', 'v0.29.1-next.0', 'v0.10.0', 'latest'];
    expect(previousStableTag(tags, '0.30.0')).toBe('v0.29.0');
    expect(previousStableTag(tags, '0.31.0')).toBe('v0.30.0');
    expect(previousStableTag(tags, '0.11.0')).toBe('v0.10.0');
    expect(previousStableTag(['v0.30.0'], '0.30.0')).toBeUndefined();
  });
});

describe('compareTools', () => {
  it('finds new, removed and reworded tools', () => {
    const before = [
      { name: 'create_folder', description: 'Create a folder.' },
      { name: 'old_name', description: 'Old.' },
      { name: 'get_email', description: 'Read one email.' },
    ];
    const after = [
      { name: 'create_folder', description: 'Create a folder in a mailbox.' },
      { name: 'delete_folder', description: 'Delete an empty folder from a mailbox.' },
      { name: 'get_email', description: 'Read one email.' },
    ];
    expect(compareTools(before, after)).toEqual({
      added: ['delete_folder'],
      removed: ['old_name'],
      changed: ['create_folder'],
    });
  });
});

describe('issueBody', () => {
  const unchanged = { added: [], removed: [], changed: [] };

  it('lists tool changes and the publish steps', () => {
    const body = issueBody({
      version: '0.30.0',
      previous: 'v0.29.0',
      changes: { ...unchanged, added: ['delete_folder'] },
      toolCount: 36,
      runUrl: 'https://github.com/fluxmailai/fluxmail/actions/runs/1',
    });
    expect(body).toContain('Tool changes since v0.29.0:');
    expect(body).toContain('- New: `delete_folder`');
    expect(body).toContain('[MCP bundle run](https://github.com/fluxmailai/fluxmail/actions/runs/1)');
    expect(body).toContain('smithery mcp publish fluxmail-0.30.0-smithery.mcpb -n fluxmail/fluxmail');
    expect(body).toContain('version 0.30.0 and 36 tools');
    expect(recordedSince(body)).toBe('v0.29.0');
  });

  it('keeps comparing with the release Smithery last got', () => {
    const body = issueBody({ version: '0.31.0', previous: 'v0.29.0', changes: unchanged, toolCount: 36 });
    expect(recordedSince(body)).toBe('v0.29.0');
    expect(recordedSince('Opened by hand.')).toBeUndefined();
    expect(recordedSince(undefined)).toBeUndefined();
  });

  it('still asks for a publish when the tools are unchanged', () => {
    const body = issueBody({ version: '0.30.1', previous: 'v0.30.0', changes: unchanged, toolCount: 36 });
    expect(body).toContain('The tool list is the same as in v0.30.0.');
    expect(body).toContain('`pnpm mcpb:build`');
  });
});

describe('publish-release workflow', () => {
  it('opens the issue after a stable publish without holding secrets', () => {
    const workflow = readFileSync(new URL('../.github/workflows/publish-release.yml', import.meta.url), 'utf8');
    const start = workflow.indexOf('\n  mcpb-listing:\n');
    const end = workflow.slice(start + 1).search(/\n  [a-z-]+:\n/);
    const job = workflow.slice(start, end === -1 ? undefined : start + 1 + end);
    expect(start).toBeGreaterThan(-1);
    expect(job).toContain('needs: publish\n');
    expect(job).toContain('continue-on-error: true\n');
    expect(job).toContain("if: inputs.npm_tag == 'latest'\n");
    expect(job).toMatch(/permissions:\n {6}actions: read\n {6}contents: read\n {6}issues: write\n/);
    expect(job).not.toContain('secrets.');
    expect(job).toContain('ref: ${{ inputs.release_sha }}\n');
    expect(job).toContain('fetch-depth: 0\n');
    expect(job).toContain('persist-credentials: false\n');
    expect(job).toContain('run: node scripts/mcpb-listing.mjs\n');
  });
});

describe('MCP bundle workflow', () => {
  it('lets a run on main finish so the release commit keeps its bundle', () => {
    const workflow = readFileSync(new URL('../.github/workflows/mcpb.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n");
  });
});
