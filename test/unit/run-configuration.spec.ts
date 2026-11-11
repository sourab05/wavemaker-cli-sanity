import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRunIdentity, runConfigurationFields, writeRunIdentity, annotateRunResults } from '../../src/utils/run-identity';
import { buildSecurityReportHtml, buildSecurityReportText } from '../../src/utils/security-report';

describe('Complete per-mode run configuration (offline)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-run-config-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const environment = (mode: string): NodeJS.ProcessEnv => ({
    PROJECT_MODE: mode, RUN_PROJECT_MODE: 'Both', RUN_TARGET: 'All Tests', PACKAGE_MANAGER: 'yarn',
    STUDIO_URL: 'https://cli.example.test', SECURITY_STUDIO_URL: 'https://sv.example.test',
    CLI_EXISTING_STUDIO_URL: 'https://cli.example.test', SECURITY_EXISTING_STUDIO_URL: 'https://sv.example.test',
    NEW_PROJECT_STUDIO_URL: 'https://new.example.test',
    WM_USERNAME: 'cli-user', SECURITY_USERNAME: 'sv-user',
    WM_PASSWORD: 'private-password', NEW_PROJECT_PASSWORD: 'private-new-password',
    SECURITY_PASSWORD: 'private-sv-password', SNYK_TOKEN: 'private-token', AUTH_COOKIE: 'private-cookie',
    PROJECT_ID: 'WMPRJ-cli', STUDIO_PROJECT_ID: 'proj-cli',
    SECURITY_PROJECT_ID: 'WMPRJ-sv', SECURITY_STUDIO_PROJECT_ID: 'proj-sv',
    CLI_BINARY: 'wm-reactnative-ai', SECURITY_CLI_BINARY: 'wm-reactnative',
    EFFECTIVE_BRANCH: 'wavemaker-ai', SECURITY_EFFECTIVE_BRANCH: 'SecurityVulnerabilities',
    CLI_REPO_URL: 'https://git.example.test/cli.git', SECURITY_CLI_REPO_URL: 'https://git.example.test/sv.git',
    APP_NAME: 'FixtureApp', APP_PACKAGE: 'com.fixture', RN_BUILD_PROFILE: 'development',
    APP_VERIFICATION_ID: '~title', WEB_PREVIEW_XPATH: '//*[@aria-label="title"]',
    S3_VERSION: 'fixture-release', BUILD_NUMBER: '123', BUILD_URL: 'https://ci.example.test/job/test/123/',
  });

  for (const mode of ['Existing Project', 'New Project']) {
    for (const suite of ['CLI', 'Security'] as const) {
      it(`records the effective parameters for ${suite} / ${mode}`, () => {
        const env = environment(mode);
        if (mode === 'New Project') {
          env.STUDIO_URL = env.SECURITY_STUDIO_URL = env.NEW_PROJECT_STUDIO_URL;
          env.WM_USERNAME = env.SECURITY_USERNAME = 'new-user';
          env.PROJECT_ID = env.SECURITY_PROJECT_ID = 'WMPRJ-new';
          env.STUDIO_PROJECT_ID = env.SECURITY_STUDIO_PROJECT_ID = 'proj-new';
        }
        const identity = getRunIdentity(suite, env);
        const fields = runConfigurationFields(identity);
        const prefix = mode === 'New Project' ? 'NEW_PROJECT' : suite === 'Security' ? 'SECURITY_EXISTING' : 'CLI_EXISTING';
        assert.equal(fields['Environment source'], `${prefix}_STUDIO_URL override`);
        assert.equal(fields['Studio URL'], suite === 'Security' ? env.SECURITY_STUDIO_URL : env.STUDIO_URL);
        assert.equal(fields['Studio username'], suite === 'Security' ? env.SECURITY_USERNAME : env.WM_USERNAME);
        assert.equal(fields['Project ID'], suite === 'Security' ? env.SECURITY_PROJECT_ID : env.PROJECT_ID);
        assert.equal(fields['Requested project mode'], 'Both');
        assert.equal(fields['Project mode'], mode);
        assert.equal(fields['Run target'], 'All Tests');
        assert.equal(fields['CLI branch'], suite === 'Security' ? 'SecurityVulnerabilities' : 'wavemaker-ai');
        assert.equal(fields['CLI repository'], suite === 'Security' ? env.SECURITY_CLI_REPO_URL : env.CLI_REPO_URL);
        assert.equal(fields['Package manager'], suite === 'Security' ? 'npm' : 'yarn');
        assert.equal(fields['Requested package manager'], 'yarn');
        assert.equal(fields['App name'], 'FixtureApp');
        assert.equal(fields['App package'], 'com.fixture');
        assert.equal(fields['RN build profile'], 'development');
        assert.equal(fields['S3 release'], 'fixture-release');
        assert.equal(fields['Jenkins build number'], '123');
        assert.equal(fields['Password'], '[hidden]');
        assert.equal(fields['Web preview XPath'], suite === 'CLI' ? env.WEB_PREVIEW_XPATH : undefined);

        const file = path.join(tmp, 'case-result.json');
        fs.writeFileSync(file, JSON.stringify({ name: 'case', status: 'failed' }));
        writeRunIdentity(tmp, suite, identity);
        annotateRunResults(tmp, suite, [], identity);
        const result = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(Object.fromEntries(result.parameters.map((p: any) => [p.name, p.value])), fields);
        const html = buildSecurityReportHtml(identity);
        const text = buildSecurityReportText(identity);
        const runSection = html.split('<h2 class="section-title">Run configuration</h2>')[1].split('</table>')[0];
        for (const [name, value] of Object.entries(runConfigurationFields({ ...identity, suite: 'Security' }))) {
          assert(runSection.includes(`<td>${name}</td>`), name);
          assert(runSection.includes(value), name);
          assert(text.includes(`${name}: ${value}`), name);
        }
        const outputs = html + text + fs.readdirSync(tmp).map(f => fs.readFileSync(path.join(tmp, f), 'utf8')).join('');
        for (const secret of ['private-password', 'private-new-password', 'private-sv-password', 'private-token', 'private-cookie']) {
          assert(!outputs.includes(secret));
        }
      });
    }
  }

  it('sanitizes report URLs and ignores arbitrary credential fields', () => {
    const fields = runConfigurationFields({
      environment: 'https://user:private-password@example.test/?token=private-token#private-cookie',
      cliRepository: 'https://user:private-password@git.example.test/repo?token=private-token',
      buildUrl: 'https://ci.example.test/1?token=private-token',
      ...{ password: 'private-password', token: 'private-token' },
    });
    assert.equal(fields['Studio URL'], 'https://example.test');
    assert.equal(fields['CLI repository'], 'https://git.example.test/repo');
    assert.equal(fields['Jenkins build URL'], 'https://ci.example.test/1');
    assert(!JSON.stringify(fields).includes('private-'));
  });

  it('preserves all four mode snapshots and prior result parameters', () => {
    for (const mode of ['Existing Project', 'New Project']) for (const suite of ['CLI', 'Security'] as const) {
      writeRunIdentity(tmp, suite, getRunIdentity(suite, environment(mode)));
    }
    const props = fs.readFileSync(path.join(tmp, 'environment.properties'), 'utf8');
    for (const mode of ['Existing_Project', 'New_Project']) for (const suite of ['CLI', 'Security']) {
      for (const key of ['environment', 'environmentSource', 'requestedProjectMode', 'cliBranch', 'cliRepository', 'buildNumber']) {
        assert(props.includes(`${suite}_${mode}_${key}=`));
      }
    }
  });

  it('keeps test history stable when only the build number or report release changes', () => {
    const file = path.join(tmp, 'case-result.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'case', status: 'passed' }));
    annotateRunResults(tmp, 'CLI', [], getRunIdentity('CLI', environment('Existing Project')));
    const history = JSON.parse(fs.readFileSync(file, 'utf8')).historyId;
    annotateRunResults(tmp, 'CLI', [], getRunIdentity('CLI', {
      ...environment('Existing Project'), BUILD_NUMBER: '124', BUILD_URL: 'https://ci.example.test/124', S3_VERSION: 'next',
    }));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).historyId, history);
  });
});
