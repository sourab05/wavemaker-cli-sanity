'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GIB = 1024 ** 3;
const CACHE_NAMES = ['npm', 'yarn', 'gradle', 'xdg', 'webdriver', 'puppeteer', 'playwright', 'cypress'];
const WORKSPACE_OUTPUTS = [
  'Artifacts', 'src/Artifacts', 'src/rn-zips', 'downloaded-projects', '.test-cache',
  'node_modules', 'wm-reactnative-cli', 'wm-reactnative-cli-security',
];
const MARKER = '.jenkins-storage-owner.json';

function exists(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Check every ancestor; rm must never traverse a substituted parent symlink.
function checkedPath(base, relative) {
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Storage path escapes its root');
  let current = base;
  for (const part of ['', ...path.relative(base, target).split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    const stat = exists(current);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`Unsafe storage directory: ${current}`);
    }
  }
  return target;
}

function readJson(file) {
  const stat = exists(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`Missing or unsafe ownership/state file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  const stat = exists(file);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Unsafe state file: ${file}`);
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function owned(dir, identity, create = false) {
  const stat = exists(dir);
  if (!stat) {
    if (!create) return false;
    fs.mkdirSync(dir, { mode: 0o700 });
    writeJson(path.join(dir, MARKER), identity);
  } else {
    const actual = readJson(path.join(dir, MARKER));
    if (JSON.stringify(actual) !== JSON.stringify(identity)) throw new Error(`Storage ownership mismatch: ${dir}`);
  }
  return true;
}

function layout(env) {
  for (const key of ['JENKINS_HOME', 'WORKSPACE', 'JOB_NAME', 'BUILD_NUMBER', 'BUILD_TAG']) {
    if (!env[key] || /[\r\n\0]/.test(env[key])) throw new Error(`Missing/invalid ${key}`);
  }
  if (!/^[1-9]\d*$/.test(env.BUILD_NUMBER)) throw new Error('Invalid BUILD_NUMBER');
  for (const key of ['JENKINS_HOME', 'WORKSPACE']) {
    if (!path.isAbsolute(env[key]) || /["\\]/.test(env[key])) throw new Error(`Invalid absolute path: ${key}`);
  }
  const home = path.resolve(env.JENKINS_HOME);
  if (home === path.parse(home).root) throw new Error('JENKINS_HOME cannot be the filesystem root');
  if (fs.realpathSync(home) !== home) throw new Error('JENKINS_HOME must be a canonical directory');
  const workspace = path.resolve(env.WORKSPACE);
  if (workspace === home || !workspace.startsWith(home + path.sep)) {
    throw new Error('Workspace must be on the configured Jenkins home volume');
  }
  checkedPath(home, path.relative(home, workspace));
  if (!exists(workspace)) throw new Error('Workspace does not exist');
  const parent = checkedPath(home, 'ci-storage');
  const hash = crypto.createHash('sha256').update(env.JOB_NAME).digest('hex').slice(0, 24);
  const root = checkedPath(home, `ci-storage/${hash}`);
  if (workspace === root || workspace.startsWith(root + path.sep) || root.startsWith(workspace + path.sep)) {
    throw new Error('Workspace and managed storage must not overlap');
  }
  const jobIdentity = { version: 1, job: env.JOB_NAME, jenkinsHome: home };
  const identity = { ...jobIdentity, build: env.BUILD_NUMBER, tag: env.BUILD_TAG, workspace };
  return {
    home, workspace, parent, root, jobIdentity, identity,
    build: checkedPath(root, `builds/${env.BUILD_NUMBER}`),
    cache: checkedPath(root, 'cache'),
  };
}

function numberSetting(env, name, fallback) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

// Do not follow symlinks inside dependency caches; count allocated bytes when available.
function sizeOf(dir) {
  let bytes = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    bytes += stat.blocks === undefined ? stat.size : stat.blocks * 512;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    }
  }
  return bytes;
}

function initialize(env = process.env, now = Date.now()) {
  const l = layout(env);
  const minFree = numberSetting(env, 'CI_STORAGE_MIN_FREE_GIB', 10) * GIB;
  const maxCache = numberSetting(env, 'CI_STORAGE_CACHE_MAX_GIB', 20) * GIB;
  const maxAge = numberSetting(env, 'CI_STORAGE_CACHE_IDLE_DAYS', 14) * 86400000;
  fs.mkdirSync(l.parent, { recursive: true, mode: 0o700 });
  owned(l.root, l.jobIdentity, true);
  if (fs.statSync(l.root).dev !== fs.statSync(l.home).dev ||
      fs.statSync(l.workspace).dev !== fs.statSync(l.home).dev) {
    throw new Error('Managed storage and workspace must use the Jenkins home filesystem');
  }
  const builds = checkedPath(l.root, 'builds');
  fs.mkdirSync(builds, { recursive: true, mode: 0o700 });
  owned(l.cache, l.jobIdentity, true);
  const stateFile = path.join(l.cache, 'last-used.json');
  const lastUsed = exists(stateFile) ? readJson(stateFile).time : now;
  if (!Number.isFinite(lastUsed)) throw new Error('Invalid cache last-used timestamp');
  // Only this job's marked caches are candidates; never scan or remove legacy home caches.
  const caches = CACHE_NAMES.map(name => checkedPath(l.cache, name));
  const total = caches.reduce((sum, dir) => sum + (exists(dir) ? sizeOf(dir) : 0), 0);
  if (total > maxCache || now - lastUsed > maxAge) {
    for (const dir of caches) fs.rmSync(checkedPath(l.cache, path.basename(dir)), { recursive: true, force: true });
    console.error(`Recycled this job's managed caches (${(total / GIB).toFixed(1)} GiB; size/idle limit)`);
  }
  const disk = fs.statfsSync(l.root);
  const available = Number(disk.bavail) * Number(disk.bsize);
  if (available < minFree) {
    throw new Error(`Jenkins storage has ${(available / GIB).toFixed(1)} GiB free; requires ${(minFree / GIB).toFixed(1)} GiB`);
  }
  owned(l.build, l.identity, true);
  for (const dir of caches) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Tools/SDKs are reusable installations, not caches subject to automatic eviction.
  const tools = checkedPath(l.root, 'tools');
  fs.mkdirSync(tools, { recursive: true, mode: 0o700 });
  const buildDir = name => checkedPath(l.build, name);
  const cacheDir = name => checkedPath(l.cache, name);
  const values = {
    CI_STORAGE_BUILD_DIR: l.build,
    HOME: buildDir('home'),
    TMPDIR: buildDir('tmp'), TMP: buildDir('tmp'), TEMP: buildDir('tmp'),
    XDG_CACHE_HOME: cacheDir('xdg'),
    XDG_CONFIG_HOME: buildDir('config'), XDG_DATA_HOME: buildDir('data'),
    NPM_CONFIG_CACHE: cacheDir('npm'), npm_config_cache: cacheDir('npm'),
    NPM_CONFIG_PREFIX: buildDir('npm-global'), npm_config_prefix: buildDir('npm-global'),
    YARN_CACHE_FOLDER: cacheDir('yarn'),
    GRADLE_USER_HOME: cacheDir('gradle'),
    WEBDRIVER_CACHE_DIR: cacheDir('webdriver'),
    PUPPETEER_CACHE_DIR: cacheDir('puppeteer'),
    PLAYWRIGHT_BROWSERS_PATH: cacheDir('playwright'),
    CYPRESS_CACHE_FOLDER: cacheDir('cypress'),
    CI_TOOLS_DIR: tools,
    ANDROID_HOME: checkedPath(tools, 'android-sdk'),
    ANDROID_SDK_ROOT: checkedPath(tools, 'android-sdk'),
    ANDROID_USER_HOME: buildDir('android'),
  };
  for (const dir of new Set(Object.values(values))) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  values.NPM_CONFIG_USERCONFIG = values.npm_config_userconfig = path.join(values.HOME, '.npmrc');
  values.CI_PROJECT_ENV_FILE = path.join(l.build, 'project-env.sh');
  values.PATH = `${values.NPM_CONFIG_PREFIX}/bin:${env.PATH || ''}`;
  values.JAVA_TOOL_OPTIONS = [
    env.JAVA_TOOL_OPTIONS || '',
    `-Djava.io.tmpdir="${values.TMPDIR}"`, `-Duser.home="${values.HOME}"`,
  ].filter(Boolean).join(' ');
  values.GRADLE_OPTS = `${env.GRADLE_OPTS || ''} -Dorg.gradle.daemon=false`.trim();
  for (const value of Object.values(values)) {
    if (/[\r\n\0]/.test(value)) throw new Error('Multiline environment values are not supported');
  }
  writeJson(stateFile, { time: now });
  console.error(`Jenkins storage: ${l.root}; disposable build: ${l.build}; free: ${(available / GIB).toFixed(1)} GiB`);
  return values;
}

function cleanup(env = process.env) {
  const l = layout(env);
  if (!exists(l.root)) return;
  owned(l.root, l.jobIdentity);
  if (!owned(l.build, l.identity)) return; // Initialization failed before owning a build.
  // Validate every deletion target before deleting anything, including workspace parents.
  const targets = WORKSPACE_OUTPUTS.map(name => checkedPath(l.workspace, name));
  checkedPath(l.root, path.relative(l.root, l.build));
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(l.build, { recursive: true, force: true });
  console.log(`Cleaned owned build storage ${l.build}; preserved reports, other builds, caches and tools`);
}

if (require.main === module) {
  try {
    if (process.argv[2] === 'init') {
      const values = initialize();
      process.stdout.write(Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
    } else if (process.argv[2] === 'cleanup') cleanup();
    else throw new Error('Usage: node scripts/jenkins-storage.js init|cleanup');
  } catch (error) {
    console.error(`Jenkins storage error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { initialize, cleanup, layout, CACHE_NAMES, WORKSPACE_OUTPUTS };
