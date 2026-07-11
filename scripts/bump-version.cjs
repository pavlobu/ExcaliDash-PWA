#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');
const BACKEND_PKG = path.join(ROOT_DIR, 'backend/package.json');
const FRONTEND_PKG = path.join(ROOT_DIR, 'frontend/package.json');

const BUMP_FLAGS = ['--major', '--minor', '--patch'];
const BUMP_FLAG_SET = new Set(BUMP_FLAGS);
const HELP_FLAGS = new Set(['-h', '--help']);

function printHelp(stream) {
  stream.write(
    [
      'ExcaliDash version bumper',
      '',
      'Bumps the app version consistently across three files:',
      '  - VERSION',
      '  - backend/package.json',
      '  - frontend/package.json',
      '',
      'Usage:',
      '  node scripts/bump-version.cjs --patch   # 1.2.3 -> 1.2.4',
      '  node scripts/bump-version.cjs --minor   # 1.2.3 -> 1.3.0',
      '  node scripts/bump-version.cjs --major   # 1.2.3 -> 2.0.0',
      '',
      'Exactly one of --major, --minor, --patch is required.',
      '',
      'Options:',
      '  -h, --help    Show this help message',
      '',
    ].join('\n')
  );
}

function fail(message) {
  process.stderr.write(`error: ${message}\n\n`);
  printHelp(process.stderr);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { help: true };
  }
  if (args.some((a) => HELP_FLAGS.has(a))) {
    return { help: true };
  }
  const bumpFlags = args.filter((a) => BUMP_FLAG_SET.has(a));
  const unknown = args.filter((a) => !BUMP_FLAG_SET.has(a) && !HELP_FLAGS.has(a));
  if (unknown.length > 0) {
    fail(`unknown argument '${unknown[0]}'.`);
  }
  if (bumpFlags.length === 0) {
    fail('no bump flag provided. Pass exactly one of --major, --minor, --patch.');
  }
  if (bumpFlags.length > 1) {
    fail(`multiple bump flags provided (${bumpFlags.join(', ')}). Use exactly one.`);
  }
  return { bump: bumpFlags[0] };
}

function readCurrentVersion() {
  if (!fs.existsSync(VERSION_FILE)) {
    fail(`VERSION file not found at ${VERSION_FILE}`);
  }
  const raw = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    fail(`invalid version '${raw}' in VERSION (expected format X.Y.Z).`);
  }
  return raw;
}

function computeNextVersion(current, flag) {
  let [major, minor, patch] = current.split('.').map(Number);
  if (flag === '--patch') {
    patch += 1;
  } else if (flag === '--minor') {
    minor += 1;
    patch = 0;
  } else if (flag === '--major') {
    major += 1;
    minor = 0;
    patch = 0;
  }
  return `${major}.${minor}.${patch}`;
}

function updatePackageJson(pkgPath, version) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    fail(`failed to read/parse ${pkgPath}: ${err.message}`);
  }
  json.version = version;
  try {
    fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2) + '\n');
  } catch (err) {
    fail(`failed to write ${pkgPath}: ${err.message}`);
  }
}

function main() {
  const { help, bump } = parseArgs(process.argv);
  if (help) {
    printHelp(process.stdout);
    return;
  }
  const current = readCurrentVersion();
  const next = computeNextVersion(current, bump);
  if (next === current) {
    fail('computed version did not change.');
  }
  fs.writeFileSync(VERSION_FILE, next + '\n');
  updatePackageJson(BACKEND_PKG, next);
  updatePackageJson(FRONTEND_PKG, next);
  process.stdout.write(`Bumped version: ${current} -> ${next}\n`);
  process.stdout.write('  updated VERSION\n');
  process.stdout.write('  updated backend/package.json\n');
  process.stdout.write('  updated frontend/package.json\n');
}

main();
