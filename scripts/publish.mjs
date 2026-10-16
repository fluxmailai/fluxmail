#!/usr/bin/env node

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadReleaseVersion, releaseConfig, repositoryRoot } from './release-config.mjs';

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const { packages, version } = await loadReleaseVersion();
  const dockerImage = options.dockerImage ?? process.env.DOCKER_IMAGE ?? releaseConfig.dockerImage;
  const npmTag = options.tag ?? process.env.NPM_TAG ?? 'latest';
  const dockerPlatforms = process.env.DOCKER_PLATFORMS ?? 'linux/amd64,linux/arm64';

  console.log(`Publishing Fluxmail ${version}`);
  console.log(`npm tag: ${npmTag}`);
  console.log(`Docker image: ${dockerImage}`);
  console.log(`Docker platforms: ${dockerPlatforms}`);

  if (options.skipChecks && process.env.GITHUB_ACTIONS !== 'true') {
    fail('--skip-checks is reserved for the validated GitHub Actions publish job.');
  }

  await run('node', ['scripts/check-package-licenses.mjs', ...packages.map(({ directory }) => directory)]);
  await run('node', ['scripts/check-registry-metadata.mjs']);
  await ensureCleanWorkingTree();

  if (!options.dryRun) await ensureNpmAuthentication(options.npmOidc);

  if (!options.skipChecks) {
    await run('pnpm', ['build']);
    await run('pnpm', ['typecheck']);
    await run('pnpm', ['test']);
  }

  await run('docker', ['info'], { output: 'ignore' });

  const { npmStates, npmChannel } = await inspectNpmReleaseState(packages, version, {
    attempts: options.resume ? 3 : 1,
    npmTag,
  });
  const channelVersion = npmChannel.channelVersion ?? version;
  const { dockerVersion, dockerChannelVersion, dockerChannel } = await inspectDockerReleaseTags(
    `${dockerImage}:${version}`,
    `${dockerImage}:${channelVersion}`,
    `${dockerImage}:${npmTag}`,
  );
  const plan = planNpmAndDockerRelease({
    npmStates,
    dockerVersion,
    dockerChannelVersion,
    dockerChannel,
    npmTag,
    version,
  });

  if (plan.inconsistent) fail(plan.message);
  if (plan.complete) {
    if (!options.resume) fail(`Docker image ${dockerImage}:${version} is already published.`);
    console.log(`Fluxmail ${version} is already published to npm and ${dockerImage}.`);
    return;
  }

  const dockerTags = plan.updateChannel ? [...new Set([version, npmTag])] : [version];
  const dockerBuildArgs = [
    'buildx',
    'build',
    '--progress',
    'plain',
    '--platform',
    dockerPlatforms,
    ...dockerTags.flatMap((tag) => ['--tag', `${dockerImage}:${tag}`]),
  ];

  if (plan.publishDocker) await run('docker', [...dockerBuildArgs, '--pull', '.']);

  for (const packageState of plan.missingPackages) {
    await run('pnpm', [
      '--filter',
      packageState.name,
      'publish',
      '--access',
      'public',
      '--tag',
      npmTag,
      '--no-git-checks',
      '--dry-run',
    ]);
  }

  if (options.dryRun) {
    console.log('\nDry run complete. Nothing was pushed or published.');
    return;
  }

  for (const packageState of plan.missingPackages) {
    const releasePackage = packages.find(({ manifest }) => manifest.name === packageState.name);
    await publishPackage(releasePackage, npmTag, { npmOidc: options.npmOidc });
  }

  const { npmStates: publishedNpmStates, npmChannel: publishedNpmChannel } = await inspectNpmReleaseState(
    packages,
    version,
    { ...NPM_PUBLISH_CONFIRMATION_RETRY, npmTag },
  );
  const missingAfterPublish = publishedNpmStates.filter(({ published }) => !published);
  if (missingAfterPublish.length > 0) {
    fail(
      `npm did not confirm these packages after publishing: ${missingAfterPublish.map(({ name }) => name).join(', ')}`,
    );
  }
  if (
    publishedNpmChannel.inconsistent ||
    publishedNpmChannel.historical !== plan.historical ||
    publishedNpmChannel.channelVersion !== plan.channelVersion
  ) {
    fail(publishedNpmChannel.message ?? `npm tag ${npmTag} changed while publishing ${version}.`);
  }

  if (plan.publishDocker) {
    await run('docker', [...dockerBuildArgs, '--push', '.']);
  } else if (plan.repairDockerChannel) {
    await run('docker', [
      'buildx',
      'imagetools',
      'create',
      '--tag',
      `${dockerImage}:${npmTag}`,
      `${dockerImage}:${version}`,
    ]);
  }

  const {
    dockerVersion: publishedDockerVersion,
    dockerChannelVersion: publishedDockerChannelVersion,
    dockerChannel: publishedDockerChannel,
  } = await inspectDockerReleaseTags(
    `${dockerImage}:${version}`,
    `${dockerImage}:${plan.channelVersion}`,
    `${dockerImage}:${npmTag}`,
    { attempts: 6, initialDelayMs: 1_000 },
  );
  if (!publishedDockerVersion.published) {
    fail(`Docker image ${dockerImage}:${version} was not found after publishing.`);
  }
  if (
    !publishedDockerChannelVersion.published ||
    !publishedDockerChannel.published ||
    publishedDockerChannelVersion.digest !== publishedDockerChannel.digest
  ) {
    fail(`Docker tag ${dockerImage}:${npmTag} does not match ${dockerImage}:${plan.channelVersion}.`);
  }
  console.log(`\nPublished Fluxmail ${version} to npm and ${dockerImage}.`);
}

export function parseArgs(args) {
  const parsed = {
    dryRun: false,
    dockerImage: undefined,
    npmOidc: false,
    resume: false,
    skipChecks: false,
    tag: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--resume') parsed.resume = true;
    else if (arg === '--skip-checks') parsed.skipChecks = true;
    else if (arg === '--npm-oidc') parsed.npmOidc = true;
    else if (arg === '--docker-image') parsed.dockerImage = requiredValue(args, ++index, arg);
    else if (arg === '--tag') parsed.tag = requiredValue(args, ++index, arg);
    else fail(`Unknown option: ${arg}`);
  }

  if (parsed.dryRun && parsed.skipChecks) fail('--dry-run cannot be combined with --skip-checks.');
  if (parsed.dryRun && parsed.npmOidc) fail('--dry-run does not use npm OIDC authentication.');

  return parsed;
}

export function planNpmAndDockerRelease({
  npmStates,
  dockerVersion,
  dockerChannelVersion = dockerVersion,
  dockerChannel,
  npmTag = 'latest',
  version,
}) {
  const releaseVersion = version ?? npmStates[0]?.version;
  const missingPackages = npmStates.filter(({ published }) => !published);
  const dockerChannelMatches =
    dockerChannelVersion.published && dockerChannel.published && dockerChannelVersion.digest === dockerChannel.digest;

  if (dockerVersion.published && missingPackages.length > 0) {
    return {
      complete: false,
      inconsistent: true,
      message: `The Docker image exists while npm packages are missing: ${missingPackages.map(({ name }) => name).join(', ')}`,
      missingPackages,
    };
  }

  const npmChannel = classifyNpmChannel(npmStates, releaseVersion, npmTag);
  if (npmChannel.inconsistent) {
    return {
      complete: false,
      inconsistent: true,
      message: npmChannel.message,
      missingPackages,
    };
  }

  const updateChannel = !npmChannel.historical;
  if (npmChannel.historical && !dockerChannelMatches) {
    return {
      complete: false,
      historical: true,
      inconsistent: true,
      message: `Docker tag ${npmTag} does not match the newer npm channel version ${npmChannel.channelVersion}.`,
      missingPackages,
    };
  }

  return {
    channelVersion: npmChannel.channelVersion,
    complete: dockerVersion.published && dockerChannelMatches && missingPackages.length === 0,
    historical: npmChannel.historical,
    inconsistent: false,
    missingPackages,
    publishDocker: !dockerVersion.published,
    repairDockerChannel: updateChannel && dockerVersion.published && !dockerChannelMatches,
    updateChannel,
  };
}

export function classifyNpmChannel(npmStates, version, npmTag = 'latest') {
  const missingPackages = npmStates.filter(({ published }) => !published);
  const publishedPackages = npmStates.filter(({ published }) => published);
  const mismatchedPublished = publishedPackages.filter(({ tagVersion }) => tagVersion !== version);
  const newerTags = npmStates.filter(({ tagVersion }) => {
    if (!tagVersion) return false;
    const comparison = compareReleaseVersions(tagVersion, version);
    return comparison !== undefined && comparison > 0;
  });

  if (missingPackages.length === 0 && mismatchedPublished.length === publishedPackages.length) {
    const activeVersions = new Set(mismatchedPublished.map(({ tagVersion }) => tagVersion));
    const allNewer = mismatchedPublished.every(({ tagVersion }) => {
      const comparison = compareReleaseVersions(tagVersion, version);
      return comparison !== undefined && comparison > 0;
    });
    if (allNewer && activeVersions.size === 1) {
      return { channelVersion: mismatchedPublished[0].tagVersion, historical: true, inconsistent: false };
    }
  }

  if (mismatchedPublished.length > 0) {
    return {
      historical: false,
      inconsistent: true,
      message: `npm tag ${npmTag} does not point to ${version} for these published packages: ${mismatchedPublished.map(({ name }) => name).join(', ')}. Repair the npm tags before resuming.`,
    };
  }

  if (missingPackages.length > 0 && newerTags.length > 0) {
    return {
      historical: false,
      inconsistent: true,
      message: `npm tag ${npmTag} already points to a newer version for these packages: ${newerTags.map(({ name }) => name).join(', ')}. Publishing ${version} would move the channel backward.`,
    };
  }

  return { channelVersion: version, historical: false, inconsistent: false };
}

async function publishPackage(releasePackage, npmTag, { npmOidc }) {
  const { directory, manifest } = releasePackage;
  if (!npmOidc) {
    await run('pnpm', ['--filter', manifest.name, 'publish', '--access', 'public', '--tag', npmTag, '--no-git-checks']);
    return;
  }

  const packDirectory = await mkdtemp(path.join(tmpdir(), 'fluxmail-release-'));
  try {
    await run('pnpm', ['--dir', directory, 'pack', '--pack-destination', packDirectory]);
    const tarballs = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      fail(`Expected one tarball for ${manifest.name}, found ${tarballs.length}.`);
    }
    await run('npm', ['publish', path.join(packDirectory, tarballs[0]), '--access', 'public', '--tag', npmTag]);
  } finally {
    await rm(packDirectory, { recursive: true, force: true });
  }
}

async function ensureCleanWorkingTree() {
  const result = await run('git', ['status', '--porcelain'], { output: 'capture', allowFailure: true });
  if (result.code !== 0) fail('Could not inspect the Git working tree.');
  if (result.stdout.trim()) fail('The Git working tree must be clean before publishing.');
}

async function ensureNpmAuthentication(npmOidc) {
  if (npmOidc) {
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
      !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    ) {
      fail('npm OIDC publishing requires GitHub Actions with `id-token: write`.');
    }
    return;
  }

  const result = await run('npm', ['whoami'], { output: 'capture', allowFailure: true });
  if (result.code !== 0) {
    fail('npm authentication failed. Run `npm login`, then confirm it with `npm whoami` before publishing.');
  }
}

export async function inspectNpmPackages(packages, retryOptions = {}) {
  const { expectedTagVersion, npmTag, ...inspectionOptions } = retryOptions;
  return Promise.all(
    packages.map(async ({ manifest }) => {
      const [published, tagVersion] = await Promise.all([
        isPublished(manifest, inspectionOptions),
        npmTag ? inspectNpmTag(manifest, npmTag, { ...inspectionOptions, expectedTagVersion }) : undefined,
      ]);
      return {
        name: manifest.name,
        version: manifest.version,
        published,
        ...(npmTag ? { tagVersion } : {}),
      };
    }),
  );
}

// npm can take several minutes to serve a newly published version. With the 4 second
// retry cap, this waits about five minutes before reporting the publish as unconfirmed.
export const NPM_PUBLISH_CONFIRMATION_RETRY = { attempts: 80, initialDelayMs: 1_000 };

export async function inspectNpmReleaseState(packages, version, options = {}) {
  const { attempts = 1, initialDelayMs = 500, npmTag = 'latest' } = options;
  let npmStates = await inspectNpmPackages(packages, { attempts: 1, initialDelayMs, npmTag });
  let npmChannel = classifyNpmChannel(npmStates, version, npmTag);
  const needsRetry = attempts > 1 && (npmChannel.inconsistent || npmStates.some(({ published }) => !published));

  if (needsRetry) {
    npmStates = await inspectNpmPackages(packages, {
      attempts,
      expectedTagVersion: npmChannel.channelVersion ?? version,
      initialDelayMs,
      npmTag,
    });
    npmChannel = classifyNpmChannel(npmStates, version, npmTag);
  }

  return { npmStates, npmChannel };
}

async function isPublished(manifest, { attempts = 1, initialDelayMs = 500 } = {}) {
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run('npm', ['view', `${manifest.name}@${manifest.version}`, 'version', '--json'], {
      output: 'capture',
      allowFailure: true,
    });

    if (result.code === 0) return JSON.parse(result.stdout) === manifest.version;
    if (!isMissingNpmResult(result)) {
      throw new Error(`Could not inspect ${manifest.name}@${manifest.version}: ${result.stderr.trim()}`);
    }
    if (attempt < attempts) await wait(delayMs);
    delayMs = Math.min(delayMs * 2, 4_000);
  }

  return false;
}

export async function inspectNpmTag(
  manifest,
  npmTag,
  { attempts = 1, expectedTagVersion, initialDelayMs = 500, runCommand = run, waitFor = wait } = {},
) {
  let delayMs = initialDelayMs;
  let tagVersion;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runCommand('npm', ['view', manifest.name, 'dist-tags', '--json'], {
      output: 'capture',
      allowFailure: true,
    });

    if (result.code === 0) {
      tagVersion = JSON.parse(result.stdout)[npmTag];
      if (expectedTagVersion === undefined || tagVersion === expectedTagVersion) return tagVersion;
    } else if (!isMissingNpmResult(result)) {
      throw new Error(`Could not inspect npm tag ${manifest.name}@${npmTag}: ${result.stderr.trim()}`);
    }
    if (attempt < attempts) await waitFor(delayMs);
    delayMs = Math.min(delayMs * 2, 4_000);
  }

  return tagVersion;
}

export function compareReleaseVersions(left, right) {
  const leftVersion = parseReleaseVersion(left);
  const rightVersion = parseReleaseVersion(right);
  if (!leftVersion || !rightVersion) return undefined;

  for (const field of ['major', 'minor', 'patch']) {
    if (leftVersion[field] !== rightVersion[field]) return leftVersion[field] > rightVersion[field] ? 1 : -1;
  }
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0;
  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function parseReleaseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value ?? '');
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.'),
  };
}

function isMissingNpmResult(result) {
  return /E404|404 Not Found|is not in this registry|No match found/i.test(`${result.stdout}\n${result.stderr}`);
}

export async function inspectDockerTags(versionImage, channelImage, { attempts = 1, initialDelayMs = 500 } = {}) {
  let delayMs = initialDelayMs;
  let states;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [dockerVersion, dockerChannel] = await Promise.all([
      inspectDockerImage(versionImage),
      inspectDockerImage(channelImage),
    ]);
    states = { dockerVersion, dockerChannel };
    if (dockerVersion.published && dockerChannel.published && dockerVersion.digest === dockerChannel.digest) break;
    if (attempt < attempts) await wait(delayMs);
    delayMs = Math.min(delayMs * 2, 4_000);
  }

  return states;
}

export async function inspectDockerReleaseTags(versionImage, channelVersionImage, channelImage, options = {}) {
  if (versionImage === channelVersionImage) {
    const { dockerVersion, dockerChannel } = await inspectDockerTags(versionImage, channelImage, options);
    return { dockerVersion, dockerChannelVersion: dockerVersion, dockerChannel };
  }

  const [dockerVersion, channelTags] = await Promise.all([
    inspectDockerImage(versionImage),
    inspectDockerTags(channelVersionImage, channelImage, options),
  ]);
  return {
    dockerVersion,
    dockerChannelVersion: channelTags.dockerVersion,
    dockerChannel: channelTags.dockerChannel,
  };
}

async function inspectDockerImage(image) {
  const result = await run('docker', ['buildx', 'imagetools', 'inspect', image, '--format', '{{json .Manifest}}'], {
    output: 'capture',
    allowFailure: true,
  });
  if (result.code === 0) {
    const manifest = JSON.parse(result.stdout);
    if (!manifest.digest) fail(`Docker did not return a digest for ${image}.`);
    return { digest: manifest.digest, image, published: true };
  }
  if (/manifest unknown|no such manifest|not found/i.test(result.stderr)) return { image, published: false };
  fail(`Could not verify whether Docker image ${image} is already published.`);
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) fail(`${option} requires a value.`);
  return value;
}

export function run(command, args, { output = 'inherit', allowFailure = false, cwd = repositoryRoot, input } = {}) {
  return new Promise((resolve, reject) => {
    const stdio =
      output === 'capture'
        ? [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
        : input === undefined
          ? output
          : ['pipe', output, output];
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio,
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    if (input !== undefined) child.stdin.end(input);
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${result.code}`));
      } else {
        resolve(result);
      }
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(message) {
  throw new Error(message);
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
