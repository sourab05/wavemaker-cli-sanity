import assert from 'assert';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const fields: Record<string, string[]> = {
  USERNAME: ['WM_USERNAME', 'WMO_USER'],
  PASSWORD: ['WM_PASSWORD', 'WMO_PASS'],
  STUDIO_URL: ['STUDIO_URL', 'STUDIO_BASE_URL'],
  PROJECT_ID: ['WM_PROJECT_ID', 'PROJECT_ID'],
  STUDIO_PROJECT_ID: ['STUDIO_PROJECT_ID'],
};
const defaults: Record<string, string> = {};
for (const [field, aliases] of Object.entries(fields)) {
  for (const alias of aliases) defaults[alias] = `cli-default-${field}`;
  defaults[`SECURITY_${field}`] = `security-default-${field}`;
}
const helper = path.resolve('scripts/apply-existing-project-overrides.sh');

function apply(overrides: Record<string, string> = {}, mode = 'Existing Project') {
  // Use a synthetic environment only, never the developer's credentials.
  const env = {
    PATH: process.env.PATH, ...defaults, ...overrides, PROJECT_MODE: mode,
    HELPER: helper, NODE: process.execPath,
    CHECK_KEYS: JSON.stringify(Object.keys(defaults)),
  };
  const output = execFileSync('/bin/bash', ['-c', `
    set -eu
    . "$HELPER" >/dev/null
    "$NODE" -e 'const keys = JSON.parse(process.env.CHECK_KEYS); process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k]]))))'
  `], { env, encoding: 'utf8' });
  return JSON.parse(output) as Record<string, string>;
}

function overridesFor(suite: string) {
  return Object.fromEntries(Object.keys(fields).map(field => [
    `${suite}_EXISTING_${field}`, `${suite.toLowerCase()}-override-${field}`,
  ]));
}

describe('Existing Project account isolation', () => {
  it('retains separate Jenkins credential defaults when inputs are absent or empty', () => {
    assert.deepStrictEqual(apply(), defaults);
    const empty = Object.fromEntries(
      [...Object.keys(overridesFor('CLI')), ...Object.keys(overridesFor('SECURITY'))].map(k => [k, ''])
    );
    assert.deepStrictEqual(apply(empty), defaults);
  });

  for (const suite of ['CLI', 'SECURITY']) {
    it(`${suite} overrides do not change the other suite's credentials, URL or project`, () => {
      const result = apply(overridesFor(suite));
      const expected = { ...defaults };
      for (const [field, aliases] of Object.entries(fields)) {
        for (const key of suite === 'CLI' ? aliases : [`SECURITY_${field}`]) {
          expected[key] = `${suite.toLowerCase()}-override-${field}`;
        }
      }
      assert.deepStrictEqual(result, expected);
    });
  }

  it('accepts different overrides for both suites in the same run', () => {
    const result = apply({ ...overridesFor('CLI'), ...overridesFor('SECURITY') });
    for (const [field, aliases] of Object.entries(fields)) {
      for (const alias of aliases) assert.equal(result[alias], `cli-override-${field}`);
      assert.equal(result[`SECURITY_${field}`], `security-override-${field}`);
    }
  });

  it('ignores existing inputs for the New Project pass', () => {
    assert.deepStrictEqual(
      apply({ ...overridesFor('CLI'), ...overridesFor('SECURITY') }, 'New Project'), defaults
    );
  });

  it('preserves whitespace and shell metacharacters in synthetic password values', () => {
    const cli = '  fixture $HOME "quoted" \'value\' ; $(false)  ';
    const security = ' different fixture \\ $ `false` ';
    const result = apply({ CLI_EXISTING_PASSWORD: cli, SECURITY_EXISTING_PASSWORD: security });
    assert.equal(result.WM_PASSWORD, cli);
    assert.equal(result.WMO_PASS, cli);
    assert.equal(result.SECURITY_PASSWORD, security);
  });

  it('does not reuse obsolete shared inputs for either suite', () => {
    assert.deepStrictEqual(apply({ EXISTING_USERNAME: 'legacy', EXISTING_PASSWORD: 'legacy' }), defaults);
  });

  it('declares distinct Jenkins fields and uses only the CLI URL for CLI variant detection', () => {
    const pipeline = fs.readFileSync(path.resolve('Jenkinsfile'), 'utf8');
    for (const suite of ['CLI', 'SECURITY']) {
      for (const field of Object.keys(fields)) {
        assert(pipeline.includes(`name: '${suite}_EXISTING_${field}'`));
      }
    }
    assert(!pipeline.includes("name: 'EXISTING_"));
    assert(pipeline.includes('def override = params.CLI_EXISTING_STUDIO_URL?.trim()'));
    assert(!/params\.\w*PASSWORD/.test(pipeline));
  });
});
