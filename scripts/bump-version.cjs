#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');
const BACKEND_PKG = path.join(ROOT_DIR, 'backend/package.json');
const FRONTEND_PKG = path.join(ROOT_DIR, 'frontend/package.json');
const VERSION_FILES = [VERSION_FILE, BACKEND_PKG, FRONTEND_PKG];

const BUMP_FLAGS = ['--major', '--minor', '--patch'];
const BUMP_FLAG_SET = new Set(BUMP_FLAGS);
const SKIP_FLAGS = ['--no-commit', '--no-tag'];
const SKIP_FLAG_SET = new Set(SKIP_FLAGS);
const HELP_FLAGS = new Set(['-h', '--help']);
const ALL_KNOWN_FLAGS = new Set([...BUMP_FLAGS, ...SKIP_FLAGS, ...HELP_FLAGS]);

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
      'By default it also commits the changed files and creates an',
      'annotated git tag (e.g. v1.2.3), matching the release workflow.',
      '',
      'Usage:',
      '  node scripts/bump-version.cjs --patch   # 1.2.3 -> 1.2.4',
      '  node scripts/bump-version.cjs --minor   # 1.2.3 -> 1.3.0',
      '  node scripts/bump-version.cjs --major   # 1.2.3 -> 2.0.0',
      '',
      'Exactly one of --major, --minor, --patch is required.',
      '',
      'Options:',
      '  --no-commit    Bump files without creating a git commit',
      '  --no-tag       Commit without creating a git tag',
      '  -h, --help     Show this help message',
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
  const skipFlags = args.filter((a) => SKIP_FLAG_SET.has(a));
  const unknown = args.filter((a) => !ALL_KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    fail(`unknown argument '${unknown[0]}'.`);
  }
  if (bumpFlags.length === 0) {
    fail('no bump flag provided. Pass exactly one of --major, --minor, --patch.');
  }
  if (bumpFlags.length > 1) {
    fail(`multiple bump flags provided (${bumpFlags.join(', ')}). Use exactly one.`);
  }
  return {
    bump: bumpFlags[0],
    noCommit: skipFlags.includes('--no-commit'),
    noTag: skipFlags.includes('--no-tag'),
  };
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

function isGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: ROOT_DIR,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function gitTagExists(tag) {
  try {
    execFileSync('git', ['rev-parse', tag], {
      cwd: ROOT_DIR,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function commitVersionFiles(version) {
  const tag = `v${version}`;
  const message = `chore: release ${tag}`;
  // Stage only the three version files — never `git add -A` so unrelated
  // working-tree changes don't sneak into the version commit.
  for (const file of VERSION_FILES) {
    const rel = path.relative(ROOT_DIR, file);
    execFileSync('git', ['add', rel], { cwd: ROOT_DIR, stdio: 'inherit' });
  }
  execFileSync('git', ['commit', '-m', message], { cwd: ROOT_DIR, stdio: 'inherit' });
  process.stdout.write(`  committed: ${message}\n`);
}

function createGitTag(version) {
  const tag = `v${version}`;
  if (gitTagExists(tag)) {
    fail(`git tag '${tag}' already exists. Remove it or pick a different version.`);
  }
  execFileSync('git', ['tag', '-a', tag, '-m', `Release ${tag}`], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  process.stdout.write(`  tagged: ${tag}\n`);
}

function main() {
  const { help, bump, noCommit, noTag } = parseArgs(process.argv);
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

  if (noCommit && noTag) return;

  if (!isGitRepo()) {
    process.stdout.write('  (not a git repo — skipping commit/tag)\n');
    return;
  }

  if (!noCommit) {
    commitVersionFiles(next);
  }
  if (!noTag) {
    createGitTag(next);
  }
}

main();
