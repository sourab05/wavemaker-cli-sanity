import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
const { initialize, cleanup, layout, WORKSPACE_OUTPUTS } = require('../../scripts/jenkins-storage');

describe('Jenkins managed storage (offline)', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  const now = 1700000000000;
  const helper = path.resolve('scripts/jenkins-storage.js');
  const marker = '.jenkins-storage-owner.json';

  function file(name: string, content = 'keep') {
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, content);
    return name;
  }

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-storage-test-')));
    const home = path.join(tmp, 'jenkins home = fixture');
    const workspace = path.join(home, 'workspace', 'folder-job');
    fs.mkdirSync(workspace, { recursive: true });
    env = {
      JENKINS_HOME: home, WORKSPACE: workspace, JOB_NAME: 'folder/job',
      BUILD_NUMBER: '42', BUILD_TAG: 'jenkins-folder-job-42',
      PATH: process.env.PATH, CI_STORAGE_MIN_FREE_GIB: '0.000001',
    };
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('redirects Node home/temp, caches, npm links, browsers and JVM paths to the managed volume', () => {
    const values = initialize(env, now);
    const l = layout(env);
    for (const [key, value] of Object.entries(values) as [string, string][]) {
      if (!['PATH', 'JAVA_TOOL_OPTIONS', 'GRADLE_OPTS'].includes(key)) {
        assert(value.startsWith(l.root + path.sep), `${key} must stay inside job storage`);
      }
    }
    assert.equal(values.NPM_CONFIG_CACHE, values.npm_config_cache);
    assert.equal(values.NPM_CONFIG_PREFIX, values.npm_config_prefix);
    assert.equal(values.NPM_CONFIG_USERCONFIG, values.npm_config_userconfig);
    assert(values.PATH.startsWith(values.NPM_CONFIG_PREFIX + '/bin:'));
    assert(values.PATH.endsWith(env.PATH));
    assert(values.JAVA_TOOL_OPTIONS.includes(`-Djava.io.tmpdir="${values.TMPDIR}"`));
    assert(values.JAVA_TOOL_OPTIONS.includes(`-Duser.home="${values.HOME}"`));
    assert(values.GRADLE_OPTS.includes('-Dorg.gradle.daemon=false'));
    const actual = JSON.parse(execFileSync(process.execPath, ['-e',
      "const os=require('os');console.log(JSON.stringify({home:os.homedir(),tmp:os.tmpdir()}))"],
    { env: { ...env, ...values }, encoding: 'utf8' }));
    assert.deepEqual(actual, { home: values.HOME, tmp: values.TMPDIR });
    assert.equal(fs.statSync(values.HOME).mode & 0o777, 0o700);
  });

  it('emits safe key/value exports with spaces and equals, without changing credentials', () => {
    const output = execFileSync(process.execPath, [helper, 'init'], {
      env: { ...env, SNYK_TOKEN: 'fixture-not-a-secret' }, encoding: 'utf8',
    });
    const values = Object.fromEntries(output.trimEnd().split('\n').map(line => {
      const split = line.indexOf('=');
      assert(split > 0);
      return [line.slice(0, split), line.slice(split + 1)];
    }));
    assert(values.HOME.includes('jenkins home = fixture'));
    assert(!output.includes('fixture-not-a-secret'));
    assert(!('SNYK_TOKEN' in values));
    assert(fs.existsSync(values.TMPDIR));
  });

  it('isolates foldered jobs and builds while reusing only same-job caches', () => {
    const first = initialize(env, now);
    const secondEnv = { ...env, BUILD_NUMBER: '43', BUILD_TAG: 'jenkins-folder-job-43' };
    const second = initialize(secondEnv, now + 1);
    const other = initialize({ ...env, JOB_NAME: 'different-folder/job' }, now + 1);
    assert.notEqual(first.HOME, second.HOME);
    assert.equal(first.NPM_CONFIG_CACHE, second.NPM_CONFIG_CACHE);
    assert.notEqual(first.NPM_CONFIG_CACHE, other.NPM_CONFIG_CACHE);
    cleanup(env);
    assert(fs.existsSync(second.HOME));
    assert(fs.existsSync(other.HOME));
  });

  it('cleans disposable projects/outputs but preserves reports, cache, tools, source and external link targets', () => {
    const values = initialize(env, now);
    const preserved = [
      file(path.join(env.WORKSPACE!, 'allure-results/result.json')),
      file(path.join(env.WORKSPACE!, 'allure-report/index.html')),
      file(path.join(env.WORKSPACE!, 'cli-reports/existing/report/index.html')),
      file(path.join(env.WORKSPACE!, 'security-reports/report-meta.json')),
      file(path.join(env.WORKSPACE!, '.env')),
      file(path.join(values.NPM_CONFIG_CACHE, 'reused-package')),
      file(path.join(values.CI_TOOLS_DIR, 'sdk/package')),
      file(path.join(tmp, 'legacy-root/.wm-reactnative-cli/project')),
    ];
    for (const relative of WORKSPACE_OUTPUTS) file(path.join(env.WORKSPACE!, relative, 'generated'));
    file(path.join(values.HOME, '.wm-reactnative-cli/wm-projects/new-project/node_modules/pkg'));
    fs.symlinkSync(path.dirname(preserved[preserved.length - 1]), path.join(values.HOME, 'nested-link'));
    cleanup(env);
    assert(!fs.existsSync(values.CI_STORAGE_BUILD_DIR));
    for (const relative of WORKSPACE_OUTPUTS) assert(!fs.existsSync(path.join(env.WORKSPACE!, relative)));
    for (const name of preserved) assert(fs.existsSync(name), `must preserve ${name}`);
    cleanup(env); // A completed cleanup is idempotent.
  });

  it('does not clean an uninitialized build or its workspace', () => {
    const output = file(path.join(env.WORKSPACE!, 'node_modules/keep'));
    cleanup(env);
    assert(fs.existsSync(output));
  });

  it('handles disk-preflight failure before build ownership without deleting existing workspace files', () => {
    const output = file(path.join(env.WORKSPACE!, 'node_modules/keep'));
    assert.throws(() => initialize({ ...env, CI_STORAGE_MIN_FREE_GIB: '1000000000' }, now), /GiB free; requires/);
    cleanup(env);
    assert(fs.existsSync(output));
  });

  it('can clean an owned build after partial environment initialization', () => {
    assert.throws(() => initialize({ ...env, JAVA_TOOL_OPTIONS: 'invalid\noption' }, now), /Multiline/);
    const build = layout(env).build;
    assert(fs.existsSync(path.join(build, marker)));
    cleanup(env);
    assert(!fs.existsSync(build));
  });

  it('refuses wrong build identity and missing ownership markers', () => {
    const values = initialize(env, now);
    const output = file(path.join(env.WORKSPACE!, 'Artifacts/keep'));
    assert.throws(() => cleanup({ ...env, BUILD_TAG: 'another-run' }), /ownership mismatch/);
    assert(fs.existsSync(output));
    fs.unlinkSync(path.join(values.CI_STORAGE_BUILD_DIR, marker));
    assert.throws(() => cleanup(env), /ownership/);
    assert(fs.existsSync(output));
  });

  it('refuses an unmarked pre-existing storage root rather than adopting it', () => {
    const root = layout(env).root;
    file(path.join(root, 'unrelated-data'));
    assert.throws(() => initialize(env, now), /ownership/);
    assert(fs.existsSync(path.join(root, 'unrelated-data')));
  });

  for (const relative of ['node_modules', 'src']) {
    it(`refuses a symlink at workspace boundary ${relative} before deleting any output`, () => {
      const values = initialize(env, now);
      const output = file(path.join(env.WORKSPACE!, 'Artifacts/keep'));
      const outside = path.join(tmp, 'outside');
      file(path.join(outside, 'keep'));
      fs.symlinkSync(outside, path.join(env.WORKSPACE!, relative));
      assert.throws(() => cleanup(env), /Unsafe storage directory/);
      assert(fs.existsSync(output));
      assert(fs.existsSync(path.join(outside, 'keep')));
      assert(fs.existsSync(values.HOME));
    });
  }

  it('refuses symlinked build directories and ownership files', () => {
    const values = initialize(env, now);
    const build = values.CI_STORAGE_BUILD_DIR;
    const moved = build + '-saved';
    fs.renameSync(build, moved);
    fs.symlinkSync(moved, build);
    assert.throws(() => cleanup(env), /Unsafe storage directory/);
    fs.unlinkSync(build);
    fs.renameSync(moved, build);
    const owner = path.join(build, marker);
    fs.renameSync(owner, owner + '-saved');
    fs.symlinkSync(owner + '-saved', owner);
    assert.throws(() => cleanup(env), /unsafe ownership/);
  });

  it('refuses symlinked cache boundaries without touching their external targets', () => {
    const values = initialize(env, now);
    fs.rmdirSync(values.NPM_CONFIG_CACHE);
    const external = path.join(tmp, 'old-cache');
    const keep = file(path.join(external, 'keep'));
    fs.symlinkSync(external, values.NPM_CONFIG_CACHE);
    assert.throws(() => initialize(env, now + 1), /Unsafe storage directory/);
    assert(fs.existsSync(keep));
  });

  it('rejects traversal, unsafe roots, missing identity and workspaces outside Jenkins home', () => {
    assert.throws(() => initialize({ ...env, BUILD_NUMBER: '../42' }), /BUILD_NUMBER/);
    assert.throws(() => initialize({ ...env, JENKINS_HOME: '/' }), /filesystem root/);
    assert.throws(() => initialize({ ...env, JENKINS_HOME: '' }), /JENKINS_HOME/);
    assert.throws(() => initialize({ ...env, WORKSPACE: tmp }), /Workspace must be/);
    assert.throws(() => initialize({ ...env, JOB_NAME: 'bad\njob' }), /JOB_NAME/);
    assert.throws(() => initialize({ ...env, WORKSPACE: env.JENKINS_HOME }), /Workspace must be/);
  });

  for (const setting of ['CI_STORAGE_MIN_FREE_GIB', 'CI_STORAGE_CACHE_MAX_GIB', 'CI_STORAGE_CACHE_IDLE_DAYS']) {
    it(`rejects invalid ${setting} without disabling safeguards`, () => {
      for (const value of ['0', '-1', 'not-a-number', 'Infinity']) {
        assert.throws(() => initialize({ ...env, [setting]: value }), /must be positive/);
      }
    });
  }

  it('retains warm caches, then recycles only owned caches after the idle threshold', () => {
    const values = initialize(env, now);
    const cached = file(path.join(values.NPM_CONFIG_CACHE, 'package'));
    const report = file(path.join(env.WORKSPACE!, 'security-report/index.html'));
    const tool = file(path.join(values.CI_TOOLS_DIR, 'gradle/bin/gradle'));
    initialize(env, now + 86400000);
    assert(fs.existsSync(cached));
    initialize(env, now + 16 * 86400000);
    assert(!fs.existsSync(cached));
    assert(fs.existsSync(values.NPM_CONFIG_CACHE));
    assert(fs.existsSync(report));
    assert(fs.existsSync(tool));
  });

  it('enforces the combined cache size limit without deleting reports or legacy data', () => {
    const values = initialize(env, now);
    const cached = file(path.join(values.NPM_CONFIG_CACHE, 'large-cache'), 'x'.repeat(20000));
    const legacy = file(path.join(tmp, 'root/.npm/keep'));
    initialize({ ...env, CI_STORAGE_CACHE_MAX_GIB: '0.000001' }, now + 1);
    assert(!fs.existsSync(cached));
    assert(fs.existsSync(legacy));
    assert(fs.existsSync(values.HOME));
  });

  it('does not follow symlinks inside a cache during measurement or eviction', () => {
    const values = initialize(env, now);
    const external = file(path.join(tmp, 'external/large'), 'x'.repeat(20000));
    file(path.join(values.NPM_CONFIG_CACHE, 'allocated-data'), 'x'.repeat(20000));
    fs.symlinkSync(path.dirname(external), path.join(values.NPM_CONFIG_CACHE, 'link'));
    initialize({ ...env, CI_STORAGE_CACHE_MAX_GIB: '0.000001' }, now + 1);
    assert(fs.existsSync(external));
    assert(!fs.existsSync(path.join(values.NPM_CONFIG_CACHE, 'link')));
  });

  it('initializes before npm and cleans after report publishing with concurrency disabled', () => {
    const pipeline = fs.readFileSync(path.resolve('Jenkinsfile'), 'utf8');
    assert(pipeline.includes('disableConcurrentBuilds()'));
    assert(pipeline.indexOf("stage('Initialize Build Storage')") < pipeline.indexOf("stage('Configure NPM Registry')"));
    assert(pipeline.indexOf('node scripts/jenkins-storage.js cleanup') > pipeline.lastIndexOf('uploadSecurityReportsToS3(nonFatal: true)'));
    assert(pipeline.includes('env.CI_STORAGE_ATTEMPTED == env.BUILD_TAG'));
    assert(pipeline.includes('env."${pair[0]}" = pair[1]'));
    assert(!pipeline.includes('env[pair[0]] = pair[1]'));
    assert(!pipeline.includes('wm-reactnative-cli-security || true'));
    assert(pipeline.includes('${env.CI_STORAGE_BUILD_DIR}/.ci-env.sh'));
  });
});
