import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundleName, publishDecision, runReady, smitheryServer } from './smithery-publish.mjs';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const sha = 'a'.repeat(40);
const run = { headSha: sha, status: 'completed', conclusion: 'success', url: 'https://github.com/o/r/actions/runs/1' };

describe('publishDecision', () => {
  it('publishes the current release, skips older ones and waits for npm to catch up', () => {
    expect(publishDecision('0.30.0', '0.30.0')).toEqual({ action: 'publish' });
    expect(publishDecision('0.29.0', '0.30.0')).toMatchObject({ action: 'skip' });
    expect(publishDecision('0.9.0', '0.10.0')).toMatchObject({ action: 'skip' });
    expect(publishDecision('0.31.0', '0.30.0')).toEqual({ action: 'wait' });
    expect(publishDecision('0.10.0', '0.9.0')).toEqual({ action: 'wait' });
    expect(publishDecision('0.31.0-next.0', '0.30.0')).toMatchObject({ action: 'skip' });
  });
});

describe('runReady', () => {
  it('waits for the release commit run and needs it to pass', () => {
    expect(runReady(run, sha)).toBe(true);
    expect(runReady({ ...run, status: 'in_progress', conclusion: '' }, sha)).toBe(false);
    expect(() => runReady({ ...run, conclusion: 'failure' }, sha)).toThrow(/ended with failure/);
    expect(() => runReady({ ...run, headSha: 'b'.repeat(40) }, sha)).toThrow(/not a{40}/);
    expect(() => runReady(undefined, sha)).toThrow(/No MCP bundle run/);
  });
});

describe('bundleName', () => {
  it('names the Smithery archive the bundle build writes', () => {
    expect(bundleName('0.30.0')).toBe('fluxmail-0.30.0-smithery.mcpb');
    expect(read('scripts/build-mcpb.mjs')).toContain('`fluxmail-${packageJson.version}-smithery.mcpb`');
  });
});

describe('Smithery workflow', () => {
  const workflow = read('.github/workflows/smithery.yml');
  const step = (name: string) => {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    const end = workflow.indexOf('\n      - name:', start + 1);
    expect(start).toBeGreaterThan(-1);
    return workflow.slice(start, end === -1 ? undefined : end);
  };

  it('gives the API key only to the step that runs the pinned CLI', () => {
    expect(workflow.match(/secrets\.SMITHERY_API_KEY/g)).toHaveLength(2);
    expect(workflow).toMatch(/workflow_call:[\s\S]*secrets:\n {6}SMITHERY_API_KEY:\n {8}required: false\n/);
    expect(step('Download the verified bundle')).toContain(
      "SMITHERY_CONFIGURED: ${{ secrets.SMITHERY_API_KEY != '' }}",
    );
    expect(step('Publish to Smithery')).toContain('SMITHERY_API_KEY: ${{ secrets.SMITHERY_API_KEY }}');
    expect(step('Install the Smithery CLI')).toContain('npm ci --ignore-scripts');
    expect(step('Install the Smithery CLI')).not.toContain('secrets.');
  });

  it('publishes to the Fluxmail listing and counts only a successful release', () => {
    const publish = step('Publish to Smithery');
    expect(publish).toContain(`--table mcp publish "$BUNDLE" -n ${smitheryServer} < /dev/null`);
    expect(publish).toContain("grep -q 'Release successful'");
    expect(publish).toContain('shell: bash');
    expect(publish).toContain('timeout-minutes: 15');
  });

  it('runs in the release environment without OIDC or write access', () => {
    expect(workflow).toContain('    environment: release\n');
    expect(workflow).toMatch(/\n {4}permissions:\n {6}actions: read\n {6}contents: read\n {4}steps:/);
    expect(workflow).not.toContain('id-token');
    expect(workflow).not.toMatch(/: write\b/);
    expect(step('Check out the publishing scripts')).toContain('persist-credentials: false');
  });

  it('pins the CLI with an integrity hash', () => {
    const manifest = JSON.parse(read('mcpb/smithery/package.json'));
    const lock = JSON.parse(read('mcpb/smithery/package-lock.json'));
    const version = manifest.dependencies.smithery;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages['node_modules/smithery']).toMatchObject({
      version,
      resolved: `https://registry.npmjs.org/smithery/-/smithery-${version}.tgz`,
    });
    for (const [name, entry] of Object.entries(lock.packages as Record<string, { integrity?: string }>)) {
      if (name) expect(entry.integrity, name).toMatch(/^sha512-/);
    }
  });

  it('publishes after a stable release without failing the release run', () => {
    const release = read('.github/workflows/publish-release.yml');
    const start = release.indexOf('\n  smithery:\n');
    const job = release.slice(start);
    expect(start).toBeGreaterThan(-1);
    expect(job).toContain('needs: publish\n');
    expect(job).toContain("if: inputs.npm_tag == 'latest'\n");
    expect(job).toContain('uses: ./.github/workflows/smithery.yml\n');
    expect(job).toContain('soft_fail: true\n');
    expect(job).toContain('secrets:\n      SMITHERY_API_KEY: ${{ secrets.SMITHERY_API_KEY }}\n');
    expect(job).not.toContain('inherit');
  });
});

describe('MCP bundle workflow', () => {
  it('lets each push to main finish, so the release commit keeps its bundle', () => {
    const workflow = read('.github/workflows/mcpb.yml');
    expect(workflow).toContain("group: mcpb-${{ github.event_name == 'pull_request' && github.ref || github.sha }}\n");
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n");
  });
});
