#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  legacyReleaseConfig,
  loadReleasePackages,
  loadReleaseVersion,
  releaseConfig,
  repositoryRoot,
} from './release-config.mjs';
import { checkClaudePlugin, syncClaudePlugin } from './claude-code-plugin.mjs';
import {
  classifyNpmChannel,
  compareReleaseVersions,
  inspectDockerReleaseTags,
  inspectNpmReleaseState,
  run,
} from './publish.mjs';

const changelogPath = path.join(repositoryRoot, 'CHANGELOG.md');

export async function main(args = process.argv.slice(2)) {
  const [command, ...commandArgs] = args;

  switch (command) {
    case 'inventory':
      await inventory(commandArgs);
      break;
    case 'doctor':
      await doctor(commandArgs);
      break;
    case 'prepare':
      await prepare(commandArgs);
      break;
    case 'validate':
      await validate(commandArgs);
      break;
    case 'notes':
      await notes(commandArgs);
      break;
    case 'status':
      await status(commandArgs);
      break;
    case 'publish':
      await publish(commandArgs);
      break;
    case 'verify':
      await verify(commandArgs);
      break;
    default:
      printHelp();
      if (command) throw new Error(`Unknown release command: ${command}`);
  }
}

async function inventory(args) {
  const options = parseOptions(args, { boolean: ['json'] });
  const packages = await loadReleasePackages();
  const output = packages.map(({ directory, manifest }) => ({
    directory,
    name: manifest.name,
    version: manifest.version,
  }));

  if (options.json) console.log(JSON.stringify(output, null, 2));
  else output.forEach((entry) => console.log(`${entry.name}@${entry.version}\t${entry.directory}`));
}

async function doctor(args) {
  const options = parseOptions(args, { boolean: ['json', 'npm-trust'] });
  const packages = await loadReleasePackages();
  const checks = [];

  for (const command of ['git', 'gh', 'node', 'npm', 'npx', 'pnpm']) {
    const available = await commandExists(command);
    checks.push({
      id: `tool:${command}`,
      status: available ? 'pass' : 'fail',
      message: available ? `${command} is available.` : `${command} is not installed.`,
    });
  }

  const missingTools = checks.filter(({ status }) => status === 'fail');
  if (missingTools.length === 0) {
    checks.push(await inspectGitHubAuthentication());
    checks.push(await inspectReleaseWorkflow());
    checks.push(await inspectReleaseEnvironment());
    checks.push(await inspectGhcrAccess());
  }

  if (options.npmTrust && missingTools.length === 0) {
    checks.push(...(await inspectNpmTrustedPublishers(packages)));
  } else {
    checks.push({
      id: 'npm-trusted-publishers',
      status: 'skipped',
      message: 'Use --npm-trust only when configuring or troubleshooting npm trusted publishers.',
    });
  }

  const report = buildDoctorReport(checks);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printDoctorReport(report);
  if (!report.ok) throw new Error('Release preflight needs attention.');
}

export function buildDoctorReport(checks) {
  return {
    ok: checks.every(({ status }) => status === 'pass' || status === 'skipped'),
    checks,
  };
}

async function inspectGitHubAuthentication() {
  const result = await run('gh', ['auth', 'status', '--hostname', 'github.com'], {
    output: 'capture',
    allowFailure: true,
  });
  return result.code === 0
    ? { id: 'github-auth', status: 'pass', message: 'GitHub CLI authentication is valid.' }
    : { id: 'github-auth', status: 'fail', message: 'Authenticate the GitHub CLI with `gh auth login`.' };
}

async function inspectReleaseWorkflow() {
  const endpoint = `repos/${releaseConfig.githubRepository}/contents/.github/workflows/${releaseConfig.githubWorkflow}?ref=main`;
  const result = await run('gh', ['api', endpoint], { output: 'capture', allowFailure: true });
  return result.code === 0
    ? {
        id: 'github-workflow',
        status: 'pass',
        message: `${releaseConfig.githubWorkflow} exists on main.`,
      }
    : {
        id: 'github-workflow',
        status: 'fail',
        message: `${releaseConfig.githubWorkflow} must be merged to main before publishing.`,
      };
}

async function inspectReleaseEnvironment() {
  const endpoint = `repos/${releaseConfig.githubRepository}/environments/${releaseConfig.githubEnvironment}`;
  const result = await run('gh', ['api', endpoint], { output: 'capture', allowFailure: true });
  if (result.code !== 0) {
    return {
      id: 'github-environment',
      status: 'fail',
      message: `Create the ${releaseConfig.githubEnvironment} GitHub environment and restrict it to main.`,
    };
  }

  const environment = JSON.parse(result.stdout);
  const policy = environment.deployment_branch_policy;
  let branchPolicies = [];
  if (policy?.custom_branch_policies) {
    const policies = await run('gh', ['api', `${endpoint}/deployment-branch-policies`, '--paginate', '--slurp'], {
      output: 'capture',
      allowFailure: true,
    });
    if (policies.code === 0) {
      branchPolicies = JSON.parse(policies.stdout).flatMap((page) => page.branch_policies ?? []);
    }
  }
  const restricted = isMainOnlyEnvironmentPolicy(policy, branchPolicies);
  return {
    id: 'github-environment',
    status: restricted ? 'pass' : 'fail',
    message: restricted
      ? `The ${releaseConfig.githubEnvironment} environment only permits main.`
      : `Restrict the ${releaseConfig.githubEnvironment} environment to main.`,
  };
}

export function isMainOnlyEnvironmentPolicy(policy, branchPolicies = []) {
  return (
    policy?.custom_branch_policies === true &&
    policy?.protected_branches === false &&
    branchPolicies.length === 1 &&
    branchPolicies[0].name === 'main' &&
    (branchPolicies[0].type === undefined || branchPolicies[0].type === 'branch')
  );
}

async function inspectGhcrAccess() {
  const [owner, repository] = releaseConfig.githubRepository.split('/');
  const packageName = releaseConfig.dockerImage.split('/').at(-1);
  let result = await run('gh', ['api', `users/${owner}/packages/container/${packageName}`], {
    output: 'capture',
    allowFailure: true,
  });
  if (result.code !== 0) {
    result = await run('gh', ['api', `orgs/${owner}/packages/container/${packageName}`], {
      output: 'capture',
      allowFailure: true,
    });
  }
  if (result.code !== 0) {
    return {
      id: 'ghcr-actions-access',
      status: 'fail',
      message: `Connect the ${packageName} container package to ${releaseConfig.githubRepository}.`,
    };
  }

  const packageMetadata = JSON.parse(result.stdout);
  const linkedRepository = packageMetadata.repository?.full_name;
  return {
    id: 'ghcr-actions-access',
    status: linkedRepository === releaseConfig.githubRepository ? 'pass' : 'fail',
    message:
      linkedRepository === releaseConfig.githubRepository
        ? `GHCR inherits Actions access from ${releaseConfig.githubRepository}.`
        : `Connect the ${packageName} container package to ${owner}/${repository}.`,
  };
}

async function inspectNpmTrustedPublishers(packages) {
  const checks = [];

  for (const { manifest } of packages) {
    const result = await run('npx', ['--yes', 'npm@11', 'trust', 'list', manifest.name, '--json'], {
      output: 'capture',
      allowFailure: true,
    });
    if (result.code !== 0) {
      const check = buildNpmTrustFailureCheck(manifest.name, result);
      checks.push(check);
      if (check.status === 'action_required') {
        for (const remaining of packages.slice(checks.length)) {
          checks.push({
            id: `npm-trusted-publisher:${remaining.manifest.name}`,
            status: 'skipped',
            message: 'Waiting for npm authentication.',
          });
        }
        break;
      }
      continue;
    }

    const config = extractJson(result.stdout);
    const valid = isExpectedNpmTrustedPublisher(config);
    checks.push({
      id: `npm-trusted-publisher:${manifest.name}`,
      status: valid ? 'pass' : 'fail',
      message: valid
        ? `${manifest.name} trusts the release workflow.`
        : `${manifest.name} does not have the expected trusted publisher.`,
    });
  }

  return checks;
}

export function buildNpmTrustFailureCheck(packageName, result) {
  const error = extractJson(result.stdout) ?? extractJson(result.stderr);
  const authUrl = error?.error?.authUrl;
  const loginRequired = error?.error?.code === 'E401';
  return {
    id: `npm-trusted-publisher:${packageName}`,
    status: authUrl || loginRequired ? 'action_required' : 'fail',
    message: authUrl
      ? `Authenticate npm for ${packageName}, then rerun the preflight.`
      : loginRequired
        ? 'Log in to npm, then rerun the preflight.'
        : `Could not inspect the trusted publisher for ${packageName}.`,
    ...(authUrl ? { authUrl } : {}),
  };
}

export function isExpectedNpmTrustedPublisher(config) {
  const configs = Array.isArray(config) ? config : [config];
  return configs.some((entry) => {
    const claims = entry?.claims;
    return (
      entry?.type === 'github' &&
      (claims?.workflow_ref?.file ?? entry.file) === releaseConfig.githubWorkflow &&
      (claims?.repository ?? entry.repository) === releaseConfig.githubRepository &&
      (claims?.environment ?? entry.environment) === releaseConfig.githubEnvironment &&
      Array.isArray(entry.permissions) &&
      entry.permissions.includes('createPackage')
    );
  });
}

function extractJson(output) {
  try {
    return JSON.parse(output.trim());
  } catch {
    return undefined;
  }
}

function printDoctorReport(report) {
  for (const check of report.checks) {
    console.log(`${check.status.padEnd(15)} ${check.id}: ${check.message}`);
    if (check.authUrl) console.log(`                ${check.authUrl}`);
  }
}

async function prepare(args) {
  const [version, ...optionArgs] = args;
  assertVersion(version);
  const options = parseOptions(optionArgs, { values: ['date', 'previous-tag'] });
  await ensureCleanWorkingTree();

  const { version: currentVersion } = await loadReleaseVersion();
  if (currentVersion === version) throw new Error(`Workspace packages already use version ${version}.`);

  await run('git', ['fetch', 'origin', '--tags']);
  const previousTag = options.previousTag ?? (await nearestPublishedTag({ includePrereleases: version.includes('-') }));
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  assertDate(date);
  await validatePreviousTag(previousTag);
  const updatedServer = await buildRegistryMetadata(version);
  const updatedChangelog = await buildChangelog({ version, date, previousTag });

  await run('pnpm', ['version:bump', version]);
  await syncClaudePlugin();
  await writeFile(path.join(repositoryRoot, 'server.json'), updatedServer);
  await writeFile(changelogPath, updatedChangelog);

  console.log(`Prepared Fluxmail ${version}.`);
  console.log(`Previous tag: ${previousTag || '<none>'}`);
  console.log('Review and curate the new CHANGELOG.md entry before opening the release pull request.');
}

async function validate(args) {
  const options = parseOptions(args, { values: ['version', 'sha'] });
  const { packages, version } = await loadReleaseVersion();
  const expectedVersion = options.version ?? version;
  if (version !== expectedVersion) {
    throw new Error(`Workspace version ${version} does not match requested version ${expectedVersion}.`);
  }

  await validateVersionMetadata(expectedVersion, packages);
  const changelog = await readFile(changelogPath, 'utf8');
  validateChangelogEntry(changelog, expectedVersion);
  if (options.sha) await assertReleaseCommitOnMain(options.sha);
  console.log(`Fluxmail ${expectedVersion} release metadata and changelog are valid.`);
}

async function notes(args) {
  const options = parseOptions(args, { values: ['version'], boolean: ['json'] });
  const version = options.version ?? (await loadReleaseVersion()).version;
  const changelog = await readFile(changelogPath, 'utf8');
  const body = renderReleaseNotes(changelog, version);
  const sha256 = sha256Text(body);

  if (options.json) console.log(JSON.stringify({ version, title: `v${version}`, sha256, body }, null, 2));
  else console.log(body);
}

async function status(args) {
  const options = parseOptions(args, { values: ['version', 'npm-tag', 'docker-image'], boolean: ['json'] });
  const version = options.version ?? (await loadReleaseVersion()).version;
  const releaseStatus = await inspectReleaseStatus(version, {
    dockerImage: options.dockerImage,
    npmTag: options.npmTag,
    attempts: 1,
  });

  if (options.json) console.log(JSON.stringify(releaseStatus, null, 2));
  else printStatus(releaseStatus);
}

async function publish(args) {
  const options = parseOptions(args, {
    values: ['version', 'sha', 'npm-tag', 'docker-image', 'docker-digests'],
    boolean: ['ci', 'resume', 'skip-checks'],
  });
  const version = requiredOption(options, 'version');
  const releaseSha = options.sha ?? (await capture('git', ['rev-parse', 'HEAD'])).trim();
  const npmTag = options.npmTag ?? defaultNpmTag(version);
  const dockerImage = options.dockerImage ?? releaseConfig.dockerImage;

  assertNpmTagMatchesVersion(version, npmTag);

  if (options.ci && process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('--ci is reserved for GitHub Actions.');
  }
  if (options.skipChecks && !options.ci) {
    throw new Error('--skip-checks requires the validated GitHub Actions release job.');
  }
  if (!options.resume) {
    throw new Error('Live releases require --resume so retries follow the destination-state rules.');
  }

  await assertPublishSource({ version, releaseSha });
  let releaseStatus = await inspectReleaseStatus(version, { dockerImage, npmTag, attempts: 3 });
  await assertExistingGitState(releaseStatus, version, releaseSha);
  let plan = planRelease(releaseStatus);
  if (plan.inconsistent) throw new Error(plan.message);

  if (plan.publishNpmOrDocker) {
    if (!options.ci) await authenticateLocalGhcr();
    const publishArgs = ['scripts/publish.mjs', '--tag', npmTag, '--docker-image', dockerImage, '--resume'];
    if (options.dockerDigests) publishArgs.push('--docker-digests', options.dockerDigests);
    if (options.skipChecks) publishArgs.push('--skip-checks');
    if (options.ci) publishArgs.push('--npm-oidc');
    await run('node', publishArgs);
    releaseStatus = await inspectReleaseStatus(version, { dockerImage, npmTag, attempts: 6 });
    plan = planRelease(releaseStatus);
    if (plan.inconsistent || plan.publishNpmOrDocker) {
      throw new Error(plan.message ?? 'npm or Docker publishing did not complete.');
    }
  }

  if (plan.publishRegistry) {
    await run('mcp-publisher', ['validate', 'server.json']);
    await run('mcp-publisher', ['login', options.ci ? 'github-oidc' : 'github']);
    await run('mcp-publisher', ['publish']);
    releaseStatus = await inspectReleaseStatus(version, { dockerImage, npmTag, attempts: 6 });
    plan = planRelease(releaseStatus);
    if (plan.inconsistent || plan.publishRegistry) {
      throw new Error(plan.message ?? 'The MCP Registry did not confirm the published version.');
    }
  }

  if (plan.publishGitHubRelease) {
    await publishGitHubRelease({ version, releaseSha, releaseStatus, historical: plan.historical });
  }

  await verifyRelease({ version, releaseSha, npmTag, dockerImage });
}

async function verify(args) {
  const options = parseOptions(args, {
    values: ['version', 'sha', 'npm-tag', 'docker-image'],
  });
  const version = requiredOption(options, 'version');
  const releaseSha = options.sha ?? (await capture('git', ['rev-parse', `v${version}^{commit}`])).trim();
  await verifyRelease({
    version,
    releaseSha,
    npmTag: options.npmTag ?? defaultNpmTag(version),
    dockerImage: options.dockerImage ?? releaseConfig.dockerImage,
  });
}

async function verifyRelease({ version, releaseSha, npmTag, dockerImage }) {
  const releaseStatus = await inspectReleaseStatus(version, { dockerImage, npmTag, attempts: 6 });
  const plan = planRelease(releaseStatus);
  if (plan.inconsistent || !plan.complete) {
    throw new Error(plan.message ?? `Fluxmail ${version} is incomplete.`);
  }

  const versionedDockerDigest = await inspectDockerDigest(`${dockerImage}:${version}`);
  const expectedChannelDigest = plan.historical
    ? await inspectDockerDigest(`${dockerImage}:${plan.channelVersion}`)
    : versionedDockerDigest;
  const channelDockerDigest = await inspectDockerDigest(`${dockerImage}:${npmTag}`);
  if (channelDockerDigest !== expectedChannelDigest) {
    throw new Error(`Docker tag ${dockerImage}:${npmTag} does not match ${dockerImage}:${plan.channelVersion}.`);
  }
  if (releaseStatus.gitTag.sha !== releaseSha) {
    throw new Error(`Git tag v${version} points to ${releaseStatus.gitTag.sha}, expected ${releaseSha}.`);
  }

  const changelog = await readFile(changelogPath, 'utf8');
  const expectedBody = normalizeText(renderReleaseNotes(changelog, version));
  if (releaseStatus.githubRelease.tag !== `v${version}` || releaseStatus.githubRelease.title !== `v${version}`) {
    throw new Error(`GitHub Release v${version} has the wrong tag or title.`);
  }
  if (releaseStatus.githubRelease.prerelease !== version.includes('-')) {
    throw new Error(`GitHub Release v${version} has the wrong prerelease state.`);
  }
  if (releaseStatus.githubRelease.assetCount !== 0) {
    throw new Error(`GitHub Release v${version} has unexpected uploaded assets.`);
  }
  if (normalizeText(releaseStatus.githubRelease.body) !== expectedBody) {
    throw new Error(`GitHub Release v${version} does not match CHANGELOG.md.`);
  }

  console.log(`Verified Fluxmail ${version} on npm, GHCR, the MCP Registry, and GitHub Releases.`);
}

export async function inspectReleaseStatus(
  version,
  { dockerImage = releaseConfig.dockerImage, npmTag = defaultNpmTag(version), attempts = 1 } = {},
) {
  assertVersion(version);
  const packages = (await loadReleasePackages()).map((releasePackage) => ({
    ...releasePackage,
    manifest: { ...releasePackage.manifest, version },
  }));

  const npmStatePromise = inspectNpmReleaseState(packages, version, {
    attempts,
    initialDelayMs: 1_000,
    npmTag,
  });
  const registryPromise = inspectRegistryStatus(version, attempts);
  const githubReleasePromise = inspectGitHubRelease(version);
  const gitTagPromise = inspectGitTag(version);
  const { npmStates: npm, npmChannel } = await npmStatePromise;
  const channelVersion = npmChannel.channelVersion ?? version;
  const [dockerTags, registry, githubRelease, gitTag] = await Promise.all([
    inspectDockerReleaseTags(
      `${dockerImage}:${version}`,
      `${dockerImage}:${channelVersion}`,
      `${dockerImage}:${npmTag}`,
      { attempts, initialDelayMs: 1_000 },
    ),
    registryPromise,
    githubReleasePromise,
    gitTagPromise,
  ]);

  const docker = {
    ...dockerTags.dockerVersion,
    channel: dockerTags.dockerChannel,
    channelTarget: dockerTags.dockerChannelVersion,
    channelVersion,
    channelMatches:
      dockerTags.dockerChannelVersion.published &&
      dockerTags.dockerChannel.published &&
      dockerTags.dockerChannelVersion.digest === dockerTags.dockerChannel.digest,
  };

  return { version, npmTag, npm, docker, registry, githubRelease, gitTag };
}

export function planRelease(status) {
  const missingNpm = status.npm.filter(({ published }) => !published);
  const npmChannel = classifyNpmChannel(status.npm, status.version, status.npmTag);
  if (npmChannel.inconsistent) {
    return {
      complete: false,
      inconsistent: true,
      message: npmChannel.message,
    };
  }

  const updateChannel = !npmChannel.historical;
  if (npmChannel.historical && !status.docker.channelMatches) {
    return {
      complete: false,
      historical: true,
      inconsistent: true,
      message: `Docker tag ${status.npmTag} does not match the newer npm channel version ${npmChannel.channelVersion}.`,
    };
  }
  const missingCoreDestination =
    missingNpm.length > 0 ||
    !status.docker.published ||
    !status.docker.channelMatches ||
    !status.registry.published ||
    !status.gitTag.published;

  if (status.docker.published && missingNpm.length > 0) {
    return {
      complete: false,
      inconsistent: true,
      message: `Docker exists while npm packages are missing: ${missingNpm.map(({ name }) => name).join(', ')}`,
    };
  }
  if (status.githubRelease.state === 'published' && missingCoreDestination) {
    return {
      complete: false,
      inconsistent: true,
      message: 'The GitHub Release is published while another release destination is missing.',
    };
  }
  if (status.githubRelease.state === 'draft' && status.githubRelease.assetCount !== 0) {
    return {
      complete: false,
      inconsistent: true,
      message: 'The draft GitHub Release has uploaded assets and cannot be published automatically.',
    };
  }

  return {
    complete:
      missingNpm.length === 0 &&
      status.docker.published &&
      status.docker.channelMatches &&
      status.registry.published &&
      status.githubRelease.state === 'published' &&
      status.gitTag.published,
    channelVersion: npmChannel.channelVersion,
    historical: npmChannel.historical,
    inconsistent: false,
    publishNpmOrDocker:
      missingNpm.length > 0 || !status.docker.published || (updateChannel && !status.docker.channelMatches),
    publishRegistry: !status.registry.published,
    publishGitHubRelease: status.githubRelease.state !== 'published' || !status.gitTag.published,
    updateChannel,
  };
}

export function validateChangelogEntry(changelog, version) {
  const section = extractChangelogSection(changelog, version);
  const errors = [];
  const groupOrder = new Map([
    ['Changed', 1],
    ['Added', 2],
    ['Removed', 3],
    ['Fixed', 4],
  ]);
  let previousGroup = 0;
  let bulletCount = 0;

  for (const line of section.body.split('\n')) {
    const heading = line.match(/^###\s+(.+)\s*$/);
    if (heading) {
      const currentGroup = groupOrder.get(heading[1]);
      if (!currentGroup) errors.push(`Unsupported changelog group: ${heading[1]}.`);
      else if (currentGroup <= previousGroup)
        errors.push('Use changelog groups in this order: Changed, Added, Removed, Fixed.');
      else previousGroup = currentGroup;
      continue;
    }
    if (/^##\s+/.test(line)) errors.push('Use H3 headings inside CHANGELOG.md release entries.');
    if (/^-\s+/.test(line)) {
      bulletCount += 1;
      if (!/\(\[[^\]]+\]\(https?:\/\/[^)]+\)\)\s*$/.test(line)) {
        errors.push(`Changelog bullets must end with a linked reference: ${line}`);
      }
    }
  }

  const noUserChanges = section.body.trim() === '_No user-facing changes._';
  if (bulletCount === 0 && !noUserChanges)
    errors.push('Add at least one referenced change or `_No user-facing changes._`.');
  const versionLink = changelog.match(new RegExp(`^\\[${escapeRegExp(version)}\\]:\\s*(\\S+)\\s*$`, 'm'))?.[1];
  const releaseTarget = `v${version}`;
  const previousVersion = String.raw`v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
  const repositories = new Set([releaseConfig.githubRepository, releaseIdentityForVersion(version).githubRepository]);
  const validReleaseLink = [...repositories].some((repository) => {
    const compareLink = new RegExp(
      `^https://github\\.com/${escapeRegExp(repository)}/compare/${previousVersion}\\.\\.\\.${escapeRegExp(releaseTarget)}$`,
    );
    const firstReleaseLink = `https://github.com/${repository}/releases/tag/${releaseTarget}`;
    return compareLink.test(versionLink) || versionLink === firstReleaseLink;
  });
  if (!versionLink) errors.push(`Add the [${version}] release link to CHANGELOG.md.`);
  else if (!validReleaseLink) {
    errors.push(`The [${version}] release link must target ${releaseTarget} in the Fluxmail repository.`);
  }
  if (/[\u2013\u2014]/.test(section.body)) errors.push('Replace en dashes and em dashes in the changelog entry.');
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return section;
}

export function renderReleaseNotes(changelog, version) {
  const section = validateChangelogEntry(changelog, version);
  const body = section.body.replace(/^###\s+/gm, '## ').trim();
  const compareUrl = changelog.match(new RegExp(`^\\[${escapeRegExp(version)}\\]:\\s*(\\S+)\\s*$`, 'm'))?.[1];
  return `${body}${compareUrl ? `\n\n**Full Changelog**: ${compareUrl}` : ''}\n`;
}

function extractChangelogSection(changelog, version) {
  const headingPattern = new RegExp(`^## \\[${escapeRegExp(version)}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`, 'm');
  const heading = headingPattern.exec(changelog);
  if (!heading) throw new Error(`CHANGELOG.md does not contain a ${version} release entry.`);
  assertDate(heading[1]);

  const bodyStart = heading.index + heading[0].length;
  const rest = changelog.slice(bodyStart);
  const nextHeading = rest.search(/^## \[/m);
  const linkDefinitions = rest.search(/^\[[^\]]+\]:\s+/m);
  const candidates = [nextHeading, linkDefinitions].filter((index) => index >= 0);
  const bodyEnd = candidates.length > 0 ? Math.min(...candidates) : rest.length;
  return { date: heading[1], body: rest.slice(0, bodyEnd).trim() };
}

async function buildRegistryMetadata(version) {
  const serverPath = path.join(repositoryRoot, 'server.json');
  const server = JSON.parse(await readFile(serverPath, 'utf8'));
  server.version = version;
  const registryPackage = server.packages?.find(
    (entry) => entry.registryType === 'npm' && entry.identifier === 'fluxmail',
  );
  if (!registryPackage) throw new Error('server.json does not contain the fluxmail npm package.');
  registryPackage.version = version;
  return `${JSON.stringify(server, null, 2)}\n`;
}

async function buildChangelog({ version, date, previousTag }) {
  const changelog = await readFile(changelogPath, 'utf8');
  const existingBody = extractUnreleasedBody(changelog);
  const generatedBody = existingBody || (await generateChangeBullets(previousTag));
  const updated = insertReleaseEntry(changelog, { version, date, previousTag, body: generatedBody });
  return `${updated.trimEnd()}\n`;
}

export function insertReleaseEntry(changelog, { version, date, previousTag, body }) {
  assertVersion(version);
  assertDate(date);
  if (new RegExp(`^## \\[${escapeRegExp(version)}\\]`, 'm').test(changelog)) {
    throw new Error(`CHANGELOG.md already contains version ${version}.`);
  }

  const unreleasedHeading = /^## \[Unreleased\]\s*$/m.exec(changelog);
  if (!unreleasedHeading) throw new Error('CHANGELOG.md must contain an [Unreleased] section.');
  const bodyStart = unreleasedHeading.index + unreleasedHeading[0].length;
  const rest = changelog.slice(bodyStart);
  const nextRelease = rest.search(/^## \[/m);
  const firstLink = rest.search(/^\[[^\]]+\]:\s+/m);
  const candidates = [nextRelease, firstLink].filter((index) => index >= 0);
  const unreleasedEnd = candidates.length > 0 ? Math.min(...candidates) : rest.length;
  const prefix = changelog.slice(0, bodyStart).trimEnd();
  const suffix = rest.slice(unreleasedEnd).trimStart();
  let updated = `${prefix}\n\n## [${version}] - ${date}\n\n${body}\n\n${suffix}`.trimEnd();

  const releaseUrl = previousTag
    ? `https://github.com/${releaseConfig.githubRepository}/compare/${previousTag}...v${version}`
    : `https://github.com/${releaseConfig.githubRepository}/releases/tag/v${version}`;
  const unreleasedUrl = `https://github.com/${releaseConfig.githubRepository}/compare/v${version}...HEAD`;
  updated = setLinkDefinition(updated, 'Unreleased', unreleasedUrl);
  updated = setLinkDefinition(updated, version, releaseUrl);
  return updated;
}

function extractUnreleasedBody(changelog) {
  const unreleasedHeading = /^## \[Unreleased\]\s*$/m.exec(changelog);
  if (!unreleasedHeading) throw new Error('CHANGELOG.md must contain an [Unreleased] section.');
  const bodyStart = unreleasedHeading.index + unreleasedHeading[0].length;
  const rest = changelog.slice(bodyStart);
  const nextRelease = rest.search(/^## \[/m);
  const firstLink = rest.search(/^\[[^\]]+\]:\s+/m);
  const candidates = [nextRelease, firstLink].filter((index) => index >= 0);
  const bodyEnd = candidates.length > 0 ? Math.min(...candidates) : rest.length;
  return rest.slice(0, bodyEnd).trim();
}

async function generateChangeBullets(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
  const output = await capture('git', ['log', '--first-parent', '--reverse', '--format=%s%x1f%H', range]);
  const changes = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [rawSubject, commit] = line.split('\x1f');
      const pullRequest = rawSubject.match(/\s+\(#(\d+)\)$/);
      const subject = rawSubject
        .replace(/\s+\(#\d+\)$/, '')
        .replace(/^(feat|fix|docs|refactor|perf|build|ci|test|chore)(\([^)]+\))?!?:\s*/i, '');
      const reference = pullRequest
        ? `[#${pullRequest[1]}](https://github.com/${releaseConfig.githubRepository}/pull/${pullRequest[1]})`
        : `[${commit.slice(0, 7)}](https://github.com/${releaseConfig.githubRepository}/commit/${commit})`;
      return `- ${subject} (${reference})`;
    });

  return changes.length > 0 ? `### Changed\n\n${changes.join('\n')}` : '_No user-facing changes._';
}

function setLinkDefinition(changelog, label, url) {
  const pattern = new RegExp(`^\\[${escapeRegExp(label)}\\]:\\s*\\S+\\s*$`, 'm');
  const definition = `[${label}]: ${url}`;
  return pattern.test(changelog) ? changelog.replace(pattern, definition) : `${changelog.trimEnd()}\n${definition}`;
}

async function validateVersionMetadata(version, packages) {
  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  if (rootPackage.version !== version) throw new Error(`package.json must use version ${version}.`);
  for (const { manifest, directory } of packages) {
    if (manifest.version !== version) throw new Error(`${directory}/package.json must use version ${version}.`);
  }

  await run('node', ['scripts/check-package-licenses.mjs', ...packages.map(({ directory }) => directory)]);
  await run('node', ['scripts/check-registry-metadata.mjs']);
  await checkClaudePlugin();
  if (await commandExists('mcp-publisher')) await run('mcp-publisher', ['validate', 'server.json']);
}

async function assertPublishSource({ version, releaseSha }) {
  await ensureCleanWorkingTree();
  const { packages, version: workspaceVersion } = await loadReleaseVersion();
  if (workspaceVersion !== version) {
    throw new Error(`Workspace version ${workspaceVersion} does not match release version ${version}.`);
  }
  await validateVersionMetadata(version, packages);
  const changelog = await readFile(changelogPath, 'utf8');
  validateChangelogEntry(changelog, version);

  await assertReleaseCommitOnMain(releaseSha);
}

async function assertReleaseCommitOnMain(releaseSha) {
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) throw new Error('The release commit must be a full lowercase SHA.');
  const head = (await capture('git', ['rev-parse', 'HEAD'])).trim();
  if (head !== releaseSha) throw new Error(`HEAD is ${head}, expected release commit ${releaseSha}.`);
  await run('git', ['fetch', 'origin', 'main:refs/remotes/origin/main', '--tags']);
  const ancestry = await run('git', ['merge-base', '--is-ancestor', releaseSha, 'origin/main'], {
    output: 'capture',
    allowFailure: true,
  });
  if (ancestry.code !== 0) throw new Error(`Release commit ${releaseSha} is not reachable from origin/main.`);
}

async function assertExistingGitState(status, version, releaseSha) {
  if (status.gitTag.published && status.gitTag.sha !== releaseSha) {
    throw new Error(`Git tag v${version} points to ${status.gitTag.sha}, expected ${releaseSha}.`);
  }
  if (status.githubRelease.state !== 'draft' || status.gitTag.published) return;

  const target = status.githubRelease.targetCommitish;
  if (target === releaseSha) return;
  const candidates = target === 'main' ? ['origin/main'] : [target, `origin/${target}`];
  for (const candidate of candidates) {
    const resolved = await run('git', ['rev-parse', '--verify', `${candidate}^{commit}`], {
      output: 'capture',
      allowFailure: true,
    });
    if (resolved.code === 0) {
      if (resolved.stdout.trim() === releaseSha) return;
      break;
    }
  }
  throw new Error(`Draft GitHub Release v${version} does not target the approved release commit ${releaseSha}.`);
}

async function publishGitHubRelease({ version, releaseSha, releaseStatus, historical }) {
  const tag = `v${version}`;
  if (releaseStatus.gitTag.published && releaseStatus.gitTag.sha !== releaseSha) {
    throw new Error(`${tag} points to ${releaseStatus.gitTag.sha}, expected ${releaseSha}.`);
  }
  if (!releaseStatus.gitTag.published) await run('git', ['push', 'origin', `${releaseSha}:refs/tags/${tag}`]);

  const changelog = await readFile(changelogPath, 'utf8');
  const body = renderReleaseNotes(changelog, version);
  const directory = await mkdtemp(path.join(tmpdir(), 'fluxmail-release-notes-'));
  const notesPath = path.join(directory, 'notes.md');
  const prerelease = version.includes('-');
  const historicalBackfill = historical || (await isHistoricalBackfill(releaseSha, prerelease));
  const latestArgs = historicalBackfill ? ['--latest=false'] : [];
  const prereleaseArgs = prerelease ? ['--prerelease'] : [];

  try {
    await writeFile(notesPath, body);
    if (releaseStatus.githubRelease.state === 'missing') {
      await run('gh', [
        'release',
        'create',
        tag,
        '--repo',
        releaseConfig.githubRepository,
        '--verify-tag',
        '--title',
        tag,
        '--notes-file',
        notesPath,
        ...prereleaseArgs,
        ...latestArgs,
      ]);
    } else if (releaseStatus.githubRelease.state === 'draft') {
      if (releaseStatus.githubRelease.assetCount !== 0) {
        throw new Error(`Draft release ${tag} has uploaded assets and cannot be published automatically.`);
      }
      await run('gh', [
        'release',
        'edit',
        tag,
        '--repo',
        releaseConfig.githubRepository,
        '--verify-tag',
        '--target',
        releaseSha,
        '--title',
        tag,
        '--notes-file',
        notesPath,
        `--prerelease=${prerelease}`,
        '--draft=false',
        ...latestArgs,
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function isHistoricalBackfill(releaseSha, prerelease) {
  const output = await capture('gh', [
    'release',
    'list',
    '--repo',
    releaseConfig.githubRepository,
    '--limit',
    '100',
    '--json',
    'tagName,isDraft,isPrerelease',
  ]);
  const releases = JSON.parse(output).filter((release) => !release.isDraft && (prerelease || !release.isPrerelease));

  for (const release of releases) {
    const candidate = await run('git', ['rev-parse', '--verify', `${release.tagName}^{commit}`], {
      output: 'capture',
      allowFailure: true,
    });
    if (candidate.code !== 0 || candidate.stdout.trim() === releaseSha) continue;
    const ancestry = await run('git', ['merge-base', '--is-ancestor', releaseSha, candidate.stdout.trim()], {
      output: 'capture',
      allowFailure: true,
    });
    if (ancestry.code === 0) return true;
  }
  return false;
}

async function inspectDockerDigest(image) {
  const output = await capture('docker', ['buildx', 'imagetools', 'inspect', image, '--format', '{{json .Manifest}}']);
  const manifest = JSON.parse(output);
  if (!manifest.digest) throw new Error(`Docker did not return a digest for ${image}.`);
  return manifest.digest;
}

function releaseIdentityForVersion(version) {
  assertVersion(version);
  return compareReleaseVersions(version, legacyReleaseConfig.lastVersion) <= 0 ? legacyReleaseConfig : releaseConfig;
}

export async function inspectRegistryStatus(version, attempts) {
  const { registryName } = releaseIdentityForVersion(version);
  const name = encodeURIComponent(registryName);
  const url = `${releaseConfig.registryUrl}/v0.1/servers/${name}/versions/${version}`;
  let delayMs = 1_000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      const body = await response.json();
      const published = body.server?.name === registryName && body.server?.version === version;
      return { published, url };
    }
    if (response.status !== 404) throw new Error(`MCP Registry returned HTTP ${response.status} for ${url}.`);
    if (attempt < attempts) await wait(delayMs);
    delayMs = Math.min(delayMs * 2, 4_000);
  }
  return { published: false, url };
}

async function inspectGitHubRelease(version) {
  const tag = `v${version}`;
  const result = await run(
    'gh',
    [
      'release',
      'view',
      tag,
      '--repo',
      releaseConfig.githubRepository,
      '--json',
      'tagName,name,body,targetCommitish,isDraft,isPrerelease,assets,url',
    ],
    { output: 'capture', allowFailure: true },
  );
  if (result.code === 0) {
    const release = JSON.parse(result.stdout);
    return {
      state: release.isDraft ? 'draft' : 'published',
      tag: release.tagName,
      title: release.name,
      body: release.body,
      targetCommitish: release.targetCommitish,
      prerelease: release.isPrerelease,
      assetCount: release.assets.length,
      url: release.url,
    };
  }
  if (/release not found|not found/i.test(result.stderr)) return { state: 'missing', tag };
  throw new Error(`Could not inspect GitHub Release ${tag}: ${result.stderr.trim()}`);
}

async function inspectGitTag(version) {
  const tag = `v${version}`;
  const output = await capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const refs = output.trim().split('\n').filter(Boolean);
  const peeled = refs.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const base = refs.find((line) => line.endsWith(`refs/tags/${tag}`));
  const sha = (peeled ?? base)?.split(/\s+/)[0];
  return { published: Boolean(sha), tag, sha };
}

function printStatus(status) {
  for (const packageState of status.npm) {
    console.log(
      `npm ${packageState.name}@${packageState.version}: ${packageState.published ? 'published' : 'missing'}`,
    );
  }
  console.log(`Docker ${status.docker.image}: ${status.docker.published ? 'published' : 'missing'}`);
  console.log(
    `Docker ${status.docker.channel.image}: ${
      status.docker.channel.published
        ? status.docker.channelMatches
          ? `matches ${status.docker.channelTarget.image}`
          : 'points to another image'
        : 'missing'
    }`,
  );
  console.log(`MCP Registry ${status.version}: ${status.registry.published ? 'published' : 'missing'}`);
  console.log(`Git tag v${status.version}: ${status.gitTag.published ? status.gitTag.sha : 'missing'}`);
  console.log(`GitHub Release v${status.version}: ${status.githubRelease.state}`);
}

async function nearestPublishedTag({ includePrereleases }) {
  const filter = includePrereleases
    ? '.[] | select(.draft == false) | .tag_name'
    : '.[] | select(.draft == false and .prerelease == false) | .tag_name';
  const output = await capture('gh', [
    'api',
    '--paginate',
    `repos/${releaseConfig.githubRepository}/releases?per_page=100`,
    '--jq',
    filter,
  ]);
  let nearest = '';
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const tag of output.split('\n').filter(Boolean)) {
    const commit = await run('git', ['rev-parse', '--verify', `${tag}^{commit}`], {
      output: 'capture',
      allowFailure: true,
    });
    if (commit.code !== 0) throw new Error(`Published release tag ${tag} is missing after fetching tags.`);
    const ancestry = await run('git', ['merge-base', '--is-ancestor', commit.stdout.trim(), 'HEAD'], {
      output: 'capture',
      allowFailure: true,
    });
    if (ancestry.code !== 0) continue;
    const distance = Number.parseInt((await capture('git', ['rev-list', '--count', `${tag}..HEAD`])).trim(), 10);
    if (distance < nearestDistance) {
      nearest = tag;
      nearestDistance = distance;
    }
  }
  return nearest;
}

async function validatePreviousTag(previousTag) {
  if (!previousTag) return;
  const tag = await run('git', ['rev-parse', '--verify', `${previousTag}^{commit}`], {
    output: 'capture',
    allowFailure: true,
  });
  if (tag.code !== 0) throw new Error(`Previous release tag ${previousTag} does not exist.`);
  const ancestry = await run('git', ['merge-base', '--is-ancestor', tag.stdout.trim(), 'HEAD'], {
    output: 'capture',
    allowFailure: true,
  });
  if (ancestry.code !== 0) throw new Error(`Previous release tag ${previousTag} is not an ancestor of HEAD.`);
}

async function authenticateLocalGhcr() {
  const response = await capture('gh', ['api', '--include', 'user']);
  const scopes = response.match(/^x-oauth-scopes:\s*(.+)$/im)?.[1] ?? '';
  if (
    !scopes
      .split(',')
      .map((scope) => scope.trim())
      .includes('write:packages')
  ) {
    throw new Error('GitHub CLI authentication requires the `write:packages` scope before publishing GHCR.');
  }

  const login = JSON.parse(response.slice(response.indexOf('{'))).login;
  const token = (await capture('gh', ['auth', 'token'])).trim();
  await run('docker', ['login', 'ghcr.io', '--username', login, '--password-stdin'], {
    input: `${token}\n`,
    output: 'capture',
  });
}

async function ensureCleanWorkingTree() {
  const status = await capture('git', ['status', '--porcelain']);
  if (status.trim()) throw new Error('The Git working tree must be clean before preparing or publishing a release.');
}

async function commandExists(command) {
  const result = await run('sh', ['-c', `command -v ${command}`], { output: 'capture', allowFailure: true });
  return result.code === 0;
}

async function capture(command, args) {
  const result = await run(command, args, { output: 'capture' });
  return result.stdout;
}

function parseOptions(args, schema = {}) {
  const values = new Set(schema.values ?? []);
  const booleans = new Set(schema.boolean ?? []);
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (booleans.has(name)) options[key] = true;
    else if (values.has(name)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[key] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function requiredOption(options, name) {
  const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  if (!options[key]) throw new Error(`--${name} is required.`);
  return options[key];
}

function defaultNpmTag(version) {
  return version.includes('-') ? 'next' : 'latest';
}

export function assertNpmTagMatchesVersion(version, npmTag) {
  const expectedTag = defaultNpmTag(version);
  if (npmTag !== expectedTag) {
    throw new Error(`Fluxmail ${version} must use the ${expectedTag} npm tag.`);
  }
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error(`Invalid release version: ${version ?? '<missing>'}.`);
  }
}

function assertDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`Invalid release date: ${date}.`);
  }
}

function normalizeText(value) {
  return `${value ?? ''}`.replace(/\r\n/g, '\n').trim();
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`Usage: pnpm release <command> [options]

Commands:
  inventory [--json]                    List publishable workspace packages
  doctor [--json] [--npm-trust]         Check release tools and external setup
  prepare <version> [options]           Bump versions and draft CHANGELOG.md
  validate [--version <version>]        Validate release metadata and changelog
  notes [--version <version>] [--json]  Render the GitHub Release body
  status [--version <version>]          Inspect every release destination
  publish --version <version> --resume  Publish or resume every destination
  verify --version <version>            Verify every published destination`);
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
