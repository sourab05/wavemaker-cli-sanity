import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { applyNewProjectOverrides, getProvisioningContext, normalizeStudioUrl, sameProvisioningContext } from '../../src/utils/new-project-env';
import { applyProvisionedProjectToSecurityEnv, readCiProjectEnvFile, validateProvisionedProjectFile, writeCiProjectEnvFile } from '../../src/utils/studio-project-env';
import { getRunIdentity, writeRunIdentity, reportUrl, annotateRunResults } from '../../src/utils/run-identity';
import { buildSecurityReportHtml, buildSecurityReportText } from '../../src/utils/security-report';
import { getPreviewCLIConfig } from '../../src/config';
import { getSecurityStudioConfig } from '../../src/config/security-project';
import { RnProjectManager } from '../../src/services/RnProjectManager';
import { StudioProjectService } from '../../src/services/StudioProjectService';
import { AuthService } from '../../src/services/AuthService';
import { getCliVariant } from '../../src/utils/cli-variant';
import { main as provision, provisioningErrorSummary } from '../../scripts/provision-studio-project';

const repo = path.resolve(__dirname, '../..');
const defaults = {
  PROJECT_MODE: 'New Project', WM_USERNAME: 'default@example.test', WM_PASSWORD: 'default fixture password',
  WMO_USER: 'stale-alias', WMO_PASS: 'stale-alias',
  STUDIO_USERNAME: 'stale-alias', STUDIO_PASSWORD: 'stale-alias',
  STUDIO_URL: 'https://old.example.test', STUDIO_BASE_URL: 'https://old.example.test',
  LOGIN_URL: 'https://stale.example.test/login/authenticate',
  WM_PROJECT_ID: 'WMPRJold', PROJECT_ID: 'WMPRJold', STUDIO_PROJECT_ID: 'proj-old',
  SECURITY_USERNAME: 'security-default', SECURITY_PASSWORD: 'security fixture password',
  SECURITY_STUDIO_URL: 'https://security.example.test',
  SECURITY_PROJECT_ID: 'WMPRJsecurity', SECURITY_STUDIO_PROJECT_ID: 'proj-security',
};
const overrides = {
  NEW_PROJECT_STUDIO_URL: 'https://stage-platform.wavemaker.ai/',
  NEW_PROJECT_USERNAME: 'new@example.test',
  NEW_PROJECT_PASSWORD: '  fixture $HOME $(false) `false` " \' \\ \t  ',
};
const project = { wmProjectId: 'WMPRJabc123', studioProjectId: 'proj-abc123',
  projectName: 'Fixture', appName: 'Fixture', appPackage: 'com.fixture', rnProjectFolder: 'Fixture-native',
  rawResponse: {} };

describe('New Project scoped overrides and safe run reports', () => {
  let original: NodeJS.ProcessEnv;
  let tmp: string;
  beforeEach(() => {
    original = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, { PATH: original.PATH, HOME: original.HOME, ...defaults });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-new-project-'));
    process.env.CI_PROJECT_ENV_FILE = path.join(tmp, '.ci-project-env.sh');
  });

  it('creates with the deployed Studio version rather than a hardcoded or onboarding version', async () => {
    const service = new StudioProjectService('https://fixture.test/', 'auth_cookie=fixture') as any;
    service.runOnboardingPreflight = async () => 5;
    service.http.get = async (url: string) => {
      assert.equal(url, 'https://fixture.test/studio/services/studio/about');
      return { status: 200, data: { product: { platformVersion: '12.1.1-GA' } } };
    };
    service.http.post = async (url: string, body: any) => {
      assert.equal(url, '/manageProjectsListing/postCreateProject');
      assert.equal(body.platformVersion, '12.1.1-GA');
      assert.equal(body.platformType, 'NATIVE_MOBILE');
      assert.equal(body.template, 'PRISM');
      return { status: 200, data: { projectId: 'proj-fixture', studioProjectId: 'WMPRJabc123' } };
    };
    const result = await service.createNativeMobileProject('Fixture');
    assert.equal(result.wmProjectId, 'WMPRJabc123');
    assert.equal(result.studioProjectId, 'proj-fixture');
  });

  for (const response of [
    { status: 200, data: { version: '1.0.0' } },
    { status: 200, data: { product: { platformVersion: 'invalid' } } },
    { status: 403, data: {} },
  ]) {
    it(`does not create when version discovery is invalid (${JSON.stringify(response)})`, async () => {
      const service = new StudioProjectService('https://fixture.test', 'auth_cookie=fixture') as any;
      service.http.get = async () => response;
      service.http.post = async () => assert.fail('must not create with an unknown version');
      await assert.rejects(service.createNativeMobileProject('Fixture'), /Cannot discover Studio platform version/);
    });
  }

  it('uses the supported listing with pagination and handles reversed project-ID field names', async () => {
    const service = new StudioProjectService('https://fixture.test', 'auth_cookie=fixture') as any;
    const pages: number[] = [];
    service.http.get = async (url: string, options: any) => {
      assert.equal(url, '/ednservices/rest/projects');
      assert.equal(options.params.size, 100);
      const page = options.params.page;
      pages.push(page);
      return { status: 200, data: { totalPages: 2, content: page === 0
        ? [{ name: 'Unrelated', projectId: 'proj-other', studioProjectId: 'WMPRJaaaa' }]
        : [{ name: 'Fixture', projectId: 'proj-correct', studioProjectId: 'WMPRJbbbb' }] } };
    };
    assert.deepEqual(await service.findProjectInListing('Fixture'),
      { wmProjectId: 'WMPRJbbbb', studioProjectId: 'proj-correct' });
    assert.deepEqual(pages, [0, 1]);
    assert.deepEqual(await service.findProjectInListing('Missing'), {});
  });
  it('preserves create-service HTTP 500 details without falling through to project lookup', async () => {
    const service = new StudioProjectService('https://fixture.test', 'auth_cookie=fixture') as any;
    service.runOnboardingPreflight = async () => 5;
    service.http.get = async () => ({ status: 200, data: { product: { platformVersion: '12.1.1-GA' } } });
    service.http.post = async () => ({ status: 500, data: { error: 'fixture create-service failure' } });
    service.resolveProjectIdsFromListing = async () => assert.fail('must not resolve a rejected create');
    await assert.rejects(service.createNativeMobileProject('Fixture'), /HTTP 500.*fixture create-service failure/);
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (let mask = 0; mask < 8; mask++) {
    it(`resolves independent URL/username/password inputs (combination ${mask})`, () => {
      const env: NodeJS.ProcessEnv = { ...defaults };
      Object.entries(overrides).forEach(([key, value], i) => { env[key] = mask & (1 << i) ? value : ''; });
      applyNewProjectOverrides(env);
      assert.equal(env.STUDIO_URL, mask & 1 ? 'https://stage-platform.wavemaker.ai' : defaults.STUDIO_URL);
      assert.equal(env.STUDIO_BASE_URL, env.STUDIO_URL);
      assert.equal(env.LOGIN_URL, `${env.STUDIO_URL}/login/authenticate`);
      for (const key of ['WM_USERNAME', 'WMO_USER', 'STUDIO_USERNAME']) {
        assert.equal(env[key], mask & 2 ? overrides.NEW_PROJECT_USERNAME : defaults.WM_USERNAME);
      }
      for (const key of ['WM_PASSWORD', 'WMO_PASS', 'STUDIO_PASSWORD']) {
        assert.equal(env[key], mask & 4 ? overrides.NEW_PROJECT_PASSWORD : defaults.WM_PASSWORD);
      }
      assert.equal(env.SECURITY_PASSWORD, defaults.SECURITY_PASSWORD);
    });
  }

  for (const mode of ['Existing Project', 'Both']) {
    it(`does not apply New inputs outside the concrete New pass (${mode})`, () => {
      const env = { ...defaults, ...overrides, PROJECT_MODE: mode };
      const before = { ...env };
      applyNewProjectOverrides(env);
      assert.deepEqual(env, before);
    });
  }

  it('preserves whitespace-only passwords and blocks stale ZIP/build shortcuts', () => {
    Object.assign(process.env, { NEW_PROJECT_PASSWORD: '   ', RN_ZIP_DOWNLOAD_URL: 'https://old.test/zip',
      RN_SKIP_STUDIO_BUILD: 'true', RN_DOWNLOAD_FROM_STUDIO: 'false' });
    applyNewProjectOverrides();
    assert.equal(process.env.WM_PASSWORD, '   ');
    assert.equal(process.env.RN_ZIP_DOWNLOAD_URL, '');
    assert.equal(process.env.RN_SKIP_STUDIO_BUILD, 'false');
    assert.equal(process.env.RN_DOWNLOAD_FROM_STUDIO, 'true');
  });

  it('routes preview, project download, provisioning and security to the same effective account', async () => {
    Object.assign(process.env, overrides);
    applyNewProjectOverrides();
    process.env.WM_PROJECT_ID = process.env.PROJECT_ID = project.wmProjectId;
    process.env.STUDIO_PROJECT_ID = project.studioProjectId;
    applyProvisionedProjectToSecurityEnv();
    const preview = getPreviewCLIConfig();
    const security = getSecurityStudioConfig();
    const cli = (RnProjectManager.fromEnv() as any).config;
    assert.equal(preview.auth.password, overrides.NEW_PROJECT_PASSWORD);
    assert.equal(preview.loginUrl, 'https://stage-platform.wavemaker.ai/login/authenticate');
    assert.equal(cli.username, overrides.NEW_PROJECT_USERNAME);
    assert.equal(cli.password, security.password);
    assert.equal(cli.baseUrl, security.baseUrl);
    assert.equal(cli.projectId, security.projectId);
    assert.equal(cli.studioProjectId, security.studioProjectId);
    assert.equal(getCliVariant().platform, 'ai');
    const login = AuthService.prototype.login;
    const create = StudioProjectService.prototype.createNativeMobileProject;
    let called = false;
    try {
      AuthService.prototype.login = async function (username, password) {
        assert.equal((this as any).baseUrl, 'https://stage-platform.wavemaker.ai');
        assert.equal(username, overrides.NEW_PROJECT_USERNAME);
        assert.equal(password, overrides.NEW_PROJECT_PASSWORD);
        called = true;
        return 'auth_cookie=fixture';
      };
      StudioProjectService.prototype.createNativeMobileProject = async () => project;
      await StudioProjectService.createNewProjectFromEnv();
      assert(called);
    } finally {
      AuthService.prototype.login = login;
      StudioProjectService.prototype.createNativeMobileProject = create;
    }
  });

  for (const url of ['not-a-url', 'file:///tmp/test', 'https://user:password@example.test', 'https://example.test/?token=fixture', 'https://example.test/#fragment']) {
    it(`rejects unsafe/malformed Studio URL ${url.split(':')[0]}`, () => {
      assert.throws(() => normalizeStudioUrl(url), /Studio URL/);
    });
  }

  it('normalizes trailing Studio URL slashes and preserves safe provisioning diagnostics', () => {
    assert.equal((new AuthService('https://fixture.test///') as any).baseUrl, 'https://fixture.test');
    const error = new Error('postCreateProject failed (HTTP 400): secret-fixture user-fixture auth_cookie=cookie-fixture');
    const message = provisioningErrorSummary(error, { WM_PASSWORD: 'secret-fixture', WM_USERNAME: 'user-fixture' });
    assert(message.includes('HTTP 400'));
    for (const secret of ['secret-fixture', 'user-fixture', 'cookie-fixture']) assert(!message.includes(secret));
  });

  it('does not resolve an unrelated project from the Studio listing', () => {
    const service = new StudioProjectService('https://fixture.test', 'auth_cookie=fixture') as any;
    const records = [
      { name: 'Unrelated', projectId: 'WMPRJaaaa', id: 'proj-unrelated' },
      { name: 'Fixture', projectId: 'WMPRJbbbb', id: 'proj-correct' },
    ];
    assert.deepEqual(service.matchProjectInTree(records, 'Fixture'),
      { wmProjectId: 'WMPRJbbbb', studioProjectId: 'proj-correct' });
    assert.deepEqual(service.matchProjectInTree(records, 'Fixture', 'WMPRJbbbb'),
      { wmProjectId: 'WMPRJbbbb', studioProjectId: 'proj-correct' });
    assert.deepEqual(service.matchProjectInTree(records, 'Missing'), {});
    assert.deepEqual(service.matchProjectInTree(records, 'Fixture', 'WMPRJcccc'), {});
  });

  it('keeps provenance stable across password rotation, but separates accounts and environments', () => {
    const first = getProvisioningContext();
    assert(sameProvisioningContext(first, getProvisioningContext({ ...process.env, NEW_PROJECT_PASSWORD: 'rotated fixture' })));
    assert(!sameProvisioningContext(first, getProvisioningContext({ ...process.env, NEW_PROJECT_USERNAME: 'other' })));
    assert(!sameProvisioningContext(first, getProvisioningContext({ ...process.env, NEW_PROJECT_STUDIO_URL: 'https://other.test' })));
    assert(!sameProvisioningContext(undefined, first));
  });

  for (const previous of ['same', 'different environment', 'different account', 'legacy']) {
    it(`limits previous-project cleanup for ${previous} context`, async () => {
      const context = getProvisioningContext();
      const saved = previous === 'legacy' ? undefined : { ...context };
      if (previous === 'different environment') saved!.studioUrl = 'https://other.test';
      if (previous === 'different account') saved!.accountKey = 'different-account';
      writeCiProjectEnvFile(process.env.CI_PROJECT_ENV_FILE!, project, saved);
      let deleted = 0;
      await provision({
        deleteProjectFromEnv: async id => { assert.equal(id, project.studioProjectId); deleted++; },
        createNewProjectFromEnv: async () => project,
      });
      assert.equal(deleted, previous === 'same' ? 1 : 0);
      validateProvisionedProjectFile(process.env.CI_PROJECT_ENV_FILE!);
      const contents = fs.readFileSync(process.env.CI_PROJECT_ENV_FILE!, 'utf8');
      for (const secret of [defaults.WM_USERNAME, defaults.WM_PASSWORD, defaults.SECURITY_PASSWORD]) {
        assert(!contents.includes(secret));
      }
      assert.equal(readCiProjectEnvFile(process.env.CI_PROJECT_ENV_FILE!)!.wmProjectId, project.wmProjectId);
    });
  }

  it('invalidates old IDs on create failure and tolerates a failed safe cleanup', async () => {
    writeCiProjectEnvFile(process.env.CI_PROJECT_ENV_FILE!, project, getProvisioningContext());
    await assert.rejects(provision({
      deleteProjectFromEnv: async () => { throw new Error('fixture delete failure'); },
      createNewProjectFromEnv: async () => { throw new Error('fixture create failure'); },
    }), /fixture create failure/);
    assert(!fs.existsSync(process.env.CI_PROJECT_ENV_FILE!));
  });

  for (const shell of ['/bin/bash', '/bin/sh']) {
    it(`loads matching IDs and exact credentials without shell expansion/tracing via ${shell}`, () => {
      Object.assign(process.env, overrides);
      writeCiProjectEnvFile(process.env.CI_PROJECT_ENV_FILE!, project, getProvisioningContext());
      const result = spawnSync(shell, ['-c', `
        set -ex
        . scripts/source-ci-project-env.sh
        node -e 'const e=process.env; if(e.WM_PASSWORD!==e.NEW_PROJECT_PASSWORD || e.WM_USERNAME!==e.NEW_PROJECT_USERNAME || e.WM_PROJECT_ID!=="WMPRJabc123" || e.STUDIO_PROJECT_ID!=="proj-abc123") process.exit(1);'
      `], { cwd: repo, env: process.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert(!result.stderr.includes(overrides.NEW_PROJECT_PASSWORD));
      assert(!result.stderr.includes('export WM_PASSWORD'));
    });
  }

  it('fails before loading IDs from a different environment/account', () => {
    writeCiProjectEnvFile(process.env.CI_PROJECT_ENV_FILE!, project, getProvisioningContext());
    process.env.NEW_PROJECT_USERNAME = 'different';
    const result = spawnSync('/bin/bash', ['-c', 'set -e; . scripts/source-ci-project-env.sh; exit 9'],
      { cwd: repo, env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert(result.stderr.includes('different environment/account'));
  });

  it('loads dotenv passwords literally rather than executing shell substitutions', () => {
    const marker = path.join(tmp, 'must-not-exist');
    const password = `  $HOME $(touch ${marker}) "quoted" \\ value  `;
    const file = path.join(tmp, '.env');
    fs.writeFileSync(file, `NEW_PROJECT_PASSWORD='${password}'\nNEW_PROJECT_USERNAME=dotenv-fixture\n`);
    const result = execFileSync('bash', ['-c', `
      eval "$(bash scripts/load-dotenv.sh "$ENV_FIXTURE")"
      node -e 'if(process.env.NEW_PROJECT_PASSWORD!==process.env.EXPECTED || process.env.NEW_PROJECT_USERNAME!=="dotenv-fixture") process.exit(1)'
    `], { cwd: repo, env: { PATH: process.env.PATH, ENV_FIXTURE: file, EXPECTED: password }, encoding: 'utf8' });
    assert.equal(result, '');
    assert(!fs.existsSync(marker));
  });

  it('preserves all four suite/mode identities and excludes every secret value', () => {
    const resultDir = path.join(tmp, 'results');
    for (const mode of ['Existing Project', 'New Project']) {
      const env = { ...defaults, ...overrides, PROJECT_MODE: mode };
      applyNewProjectOverrides(env);
      if (mode === 'New Project') {
        env.SECURITY_USERNAME = env.WM_USERNAME;
        env.SECURITY_STUDIO_URL = env.STUDIO_URL;
        env.SECURITY_PROJECT_ID = env.WM_PROJECT_ID;
        env.SECURITY_STUDIO_PROJECT_ID = env.STUDIO_PROJECT_ID;
      }
      for (const suite of ['CLI', 'Security'] as const) {
        const identity = getRunIdentity(suite, env);
        writeRunIdentity(resultDir, suite, identity);
        const html = buildSecurityReportHtml({ ...identity, auditStatus: 'failed', snykStatus: 'skipped' });
        const text = buildSecurityReportText(identity);
        for (const value of [identity.username, identity.projectId, identity.studioProjectId, identity.environment]) {
          assert(html.includes(value));
          assert(text.includes(value));
        }
      }
    }
    const contents = fs.readdirSync(resultDir).map(f => fs.readFileSync(path.join(resultDir, f), 'utf8')).join('\n');
    for (const suite of ['CLI', 'Security']) for (const mode of ['Existing_Project', 'New_Project']) {
      assert(contents.includes(`${suite}_${mode}_username=`));
      assert(contents.includes(`${suite}_${mode}_studioProjectId=`));
    }
    for (const secret of [defaults.WM_PASSWORD, defaults.SECURITY_PASSWORD, overrides.NEW_PROJECT_PASSWORD]) {
      assert(!contents.includes(secret));
    }
    assert(contents.includes('NEW_PROJECT_PASSWORD'));
  });

  it('escapes report HTML and properties without injecting a forged field', () => {
    const identity = { ...getRunIdentity('CLI'), username: '<script>alert("fixture")</script>\nforged=1' };
    const html = buildSecurityReportHtml(identity);
    assert(!html.includes(identity.username));
    assert(html.includes('&lt;script&gt;'));
    writeRunIdentity(tmp, 'CLI', identity);
    assert(!fs.readFileSync(path.join(tmp, 'environment.properties'), 'utf8').includes('\nforged=1'));
  });

  it('keeps same-named Existing/New test cases separate and preserves prior results', () => {
    const existing = { ...getRunIdentity('CLI'), projectMode: 'Existing Project' };
    const fresh = { ...existing, projectMode: 'New Project', projectId: 'WMPRJ-new' };
    const first = path.join(tmp, 'existing-result.json');
    const second = path.join(tmp, 'new-result.json');
    fs.writeFileSync(first, JSON.stringify({ uuid: 'existing', name: 'same test', fullName: 'suite same test', status: 'passed' }));
    annotateRunResults(tmp, 'CLI', [], existing);
    const saved = fs.readFileSync(first, 'utf8');
    fs.writeFileSync(second, JSON.stringify({ uuid: 'new', name: 'same test', fullName: 'suite same test', status: 'failed' }));
    annotateRunResults(tmp, 'CLI', ['existing-result.json'], fresh);
    assert.equal(fs.readFileSync(first, 'utf8'), saved);
    const result = JSON.parse(fs.readFileSync(second, 'utf8'));
    assert.notEqual(result.historyId, JSON.parse(saved).historyId);
    assert(result.parameters.some((p: any) => p.name === 'Project mode' && p.value === 'New Project'));
    assert(!JSON.stringify(result).includes(defaults.WM_PASSWORD));
    const once = fs.readFileSync(second, 'utf8');
    annotateRunResults(tmp, 'CLI', ['existing-result.json'], fresh);
    assert.equal(fs.readFileSync(second, 'utf8'), once);
  });

  it('excludes embedded credentials, query tokens and fragments from report URLs', () => {
    assert.equal(reportUrl('https://user:fixture@example.test/path?token=fixture#secret'), 'https://example.test/path');
    assert.equal(reportUrl('not-a-url'), 'unknown');
  });

  it('declares masked New inputs and guards mixed-variant Both builds before provisioning', () => {
    const pipeline = fs.readFileSync(path.join(repo, 'Jenkinsfile'), 'utf8');
    assert(/password\(\s*name: 'NEW_PROJECT_PASSWORD'/.test(pipeline));
    for (const key of Object.keys(overrides)) assert(pipeline.includes(`name: '${key}'`));
    assert(!/params\.\w*PASSWORD/.test(pipeline));
    assert(pipeline.includes('!isSecurityOnlyRun() && projectModes().size() > 1 && isAi(existingUrl) != isAi(newUrl)'));
    assert(pipeline.indexOf('Both cannot mix classic and AI') < pipeline.indexOf("stage('Provision Studio Project')"));
  });
});
