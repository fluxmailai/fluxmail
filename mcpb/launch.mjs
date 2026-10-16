#!/usr/bin/env node

const supportedTargets = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'linuxmusl-arm64',
  'linuxmusl-x64',
  'win32-arm64',
  'win32-x64',
]);
const [major, minor] = process.versions.node.split('.').map(Number);
const platform =
  process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime
    ? 'linuxmusl'
    : process.platform;
const target = `${platform}-${process.arch}`;

if (major < 22 || (major === 22 && minor < 22)) {
  console.error('This Fluxmail bundle requires Node.js 22.22 or later.');
  process.exitCode = 1;
} else if (!supportedTargets.has(target)) {
  console.error(`This Fluxmail bundle does not support ${target}.`);
  process.exitCode = 1;
} else {
  try {
    const { runCli } = await import('./dist/cli.js');
    await runCli();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
