import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
const { patchBuildCli } = require('../../scripts/patch-build-cli');

const fixture = [
  "const semver = require('semver');",
  "const { exec } = require('./exec');",
  "const VERSIONS = { JAVA: '11.0.0' };",
  "const logger = { error() {} };",
  'async function hasValidJavaVersion() {',
  "    const javaVersion = (await exec('java', ['-version'])).join('').match(/[0-9\\.]+/)[0];",
  '    if (semver.lt(semver.coerce(javaVersion).version, VERSIONS.JAVA)) {',
  '        return false;',
  '    }',
  '    return Boolean(process.env.JAVA_HOME);',
  '}',
  'module.exports = { hasValidJavaVersion };',
].join('\n');

describe('CLI Java requirement parsing (offline)', () => {
  let tmp: string;
  let file: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-build-patch-'));
    fs.mkdirSync(path.join(tmp, 'src'));
    file = path.join(tmp, 'src/requirements.js');
    fs.writeFileSync(file, fixture);
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function load(source: string, output: string[], javaHome = '/fixture/jdk') {
    const context = vm.createContext({
      module: { exports: {} }, process: { env: { JAVA_HOME: javaHome } },
      require: (name: string) => name === 'semver' ? require('semver') :
        { exec: async () => output },
    });
    vm.runInContext(source, context);
    return context.module.exports.hasValidJavaVersion();
  }

  it('reproduces the null semver failure with the original JVM-options banner', async () => {
    await assert.rejects(load(fixture, [
      'Picked up JAVA_TOOL_OPTIONS: -Djava.io.tmpdir="/var/jenkins_home/ci-tmp/job/79"',
      'openjdk version "17.0.18" 2026-01-20',
    ]), /Cannot read properties of null/);
  });

  for (const banner of ['openjdk version "17.0.18" 2026-01-20', 'java version "21.0.2" 2024-01-16']) {
    it(`parses ${banner} after noisy option diagnostics`, async () => {
      patchBuildCli(tmp);
      assert.equal(await load(fs.readFileSync(file, 'utf8'), [
        'Picked up JAVA_TOOL_OPTIONS: -Djava.io.tmpdir="/ci/123.456" -Duser.home="/ci/79/home"\n',
        banner + '\nOpenJDK Runtime Environment (build 17.0.18+8)',
      ]), true);
    });
  }

  it('retains minimum-version and JAVA_HOME requirements and rejects malformed output', async () => {
    patchBuildCli(tmp);
    const patched = fs.readFileSync(file, 'utf8');
    assert.equal(await load(patched, ['java version "1.8.0_412"']), false);
    assert.equal(await load(patched, ['openjdk version "17.0.18"'], ''), false);
    for (const output of ['no version available', 'Picked up JAVA_TOOL_OPTIONS: -Dfake=99.0.0', 'openjdk version "invalid"']) {
      await assert.rejects(load(patched, [output]), /Unable to parse Java version banner/);
    }
  });

  it('is idempotent and refuses unsupported source without partial writes', () => {
    patchBuildCli(tmp);
    const patched = fs.readFileSync(file, 'utf8');
    patchBuildCli(tmp);
    assert.equal(fs.readFileSync(file, 'utf8'), patched);
    const unsupported = fixture.replace('semver.lt(semver.coerce(javaVersion).version, VERSIONS.JAVA)', 'false');
    fs.writeFileSync(file, unsupported);
    assert.throws(() => patchBuildCli(tmp), /refusing a partial/);
    assert.equal(fs.readFileSync(file, 'utf8'), unsupported);
  });
});
