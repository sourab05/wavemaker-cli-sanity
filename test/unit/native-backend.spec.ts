import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { ensureNativeBackendReady } from '../../src/services/NativeBackendService';
import { RnProjectManager } from '../../src/services/RnProjectManager';
import { AuthService } from '../../src/services/AuthService';

describe('Native backend lifecycle (offline)', () => {
  let tmp: string;
  let originalGet: typeof axios.get;
  let originalLogin: typeof AuthService.prototype.login;
  let originalPreview: typeof AuthService.prototype.getPreviewUrl;
  const server = 'https://studio.example.test/run-test/app_master';
  const shortWait = { timeoutMs: 30, pollIntervalMs: 1 };
  const writeConfig = (serverPath: unknown) =>
    fs.writeFileSync(path.join(tmp, 'wm_rn_config.json'), JSON.stringify({ serverPath }));
  const healthy = (url: string) => ({
    status: 200,
    data: url.endsWith('/security/info') ? '{"securityEnabled":false}' : 'var properties = {"homePage":"Main"};',
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-native-backend-test-'));
    writeConfig(server);
    originalGet = axios.get;
    originalLogin = AuthService.prototype.login;
    originalPreview = AuthService.prototype.getPreviewUrl;
    axios.get = (async (url: string) => healthy(url)) as typeof axios.get;
  });
  afterEach(() => {
    axios.get = originalGet;
    AuthService.prototype.login = originalLogin;
    AuthService.prototype.getPreviewUrl = originalPreview;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refreshes before probing both public endpoints without modifying the native config', async () => {
    const events: string[] = [];
    const before = fs.readFileSync(path.join(tmp, 'wm_rn_config.json'), 'utf8');
    axios.get = (async (url: string, config: any) => {
      events.push(url);
      assert.equal(config.headers, undefined);
      assert.equal(config.auth, undefined);
      assert.equal(config.maxRedirects, 0);
      assert(config.timeout > 0 && config.timeout <= 10000);
      assert.equal(config.responseType, 'text');
      return healthy(url);
    }) as typeof axios.get;
    await ensureNativeBackendReady(tmp, async () => { events.push('refresh'); return server + '/'; });
    assert.deepEqual(events, ['refresh', server + '/services/application/wmProperties.js', server + '/services/security/info']);
    assert.equal(fs.readFileSync(path.join(tmp, 'wm_rn_config.json'), 'utf8'), before);
  });

  it('waits through 404/503 startup responses and rechecks both endpoints', async () => {
    let count = 0;
    axios.get = (async (url: string) => {
      count++;
      return count <= 2 ? { status: count === 1 ? 404 : 503, data: '' } : healthy(url);
    }) as typeof axios.get;
    await ensureNativeBackendReady(tmp, async () => server, { timeoutMs: 1000, pollIntervalMs: 1 });
    assert.equal(count, 4);
  });

  it('rejects a refreshed deployment that differs from the URL already embedded in the APK', async () => {
    axios.get = (async () => { assert.fail('must not probe a different deployment'); }) as typeof axios.get;
    await assert.rejects(ensureNativeBackendReady(tmp, async () => server + '-other'), /does not match/);
  });

  for (const serverPath of [undefined, '', 'http://NOSERVERREQUIRED.com']) {
    it(`does not refresh serverless configuration ${String(serverPath)}`, async () => {
      writeConfig(serverPath);
      axios.get = (async () => { assert.fail('must not probe serverless app'); }) as typeof axios.get;
      await ensureNativeBackendReady(tmp, async () => { assert.fail('must not refresh serverless app'); });
    });
  }

  it('propagates deployment refresh failure without proceeding to device readiness', async () => {
    const failure = new Error('deployment failed');
    axios.get = (async () => { assert.fail('must not probe after refresh failure'); }) as typeof axios.get;
    await assert.rejects(ensureNativeBackendReady(tmp, async () => { throw failure; }), error => error === failure);
  });

  for (const response of [
    { status: 404, data: 'gone' },
    { status: 302, data: '' },
    { status: 401, data: 'private' },
    { status: 200, data: '<html>Login homePage</html>' },
    { status: 200, data: '{}' },
    { status: 200, data: 'null' },
  ]) {
    it(`rejects unavailable or invalid startup data ${JSON.stringify(response)}`, async () => {
      axios.get = (async () => response) as typeof axios.get;
      await assert.rejects(ensureNativeBackendReady(tmp, async () => server, shortWait), /Native backend was not ready/);
    });
  }

  it('requires both endpoints rather than accepting a healthy properties endpoint alone', async () => {
    axios.get = (async (url: string) => url.endsWith('/security/info') ?
      { status: 500, data: 'backend failure' } : healthy(url)) as typeof axios.get;
    await assert.rejects(ensureNativeBackendReady(tmp, async () => server, shortWait), /security\/info: HTTP 500/);
  });

  it('bounds retries on network failure and does not include request details in the error', async () => {
    axios.get = (async () => { throw Object.assign(new Error('sensitive-request-details'), { code: 'ETIMEDOUT' }); }) as typeof axios.get;
    await assert.rejects(ensureNativeBackendReady(tmp, async () => server, shortWait), (error: any) => {
      assert(error.message.includes('ETIMEDOUT'));
      assert(!error.message.includes('sensitive-request-details'));
      return true;
    });
  });

  it('rejects invalid embedded URLs before refreshing a deployment', async () => {
    for (const value of ['file:///tmp/app', 'https://user:password@example.test/app', server + '?token=example']) {
      writeConfig(value);
      await assert.rejects(ensureNativeBackendReady(tmp, async () => { assert.fail('must not refresh'); }), /Native backend must be/);
    }
  });

  it('uses the selected RnProjectManager account and project rather than global environment', async () => {
    AuthService.prototype.login = async function (username, password) {
      assert.equal(username, 'fixture-user');
      assert.equal(password, 'fixture-password');
      return 'auth_cookie=fixture-cookie';
    };
    AuthService.prototype.getPreviewUrl = async function (projectId, cookie) {
      assert.equal(projectId, 'selected-project');
      assert.equal(cookie, 'auth_cookie=fixture-cookie');
      return server;
    };
    const manager = new RnProjectManager({
      baseUrl: 'https://studio.example.test', projectId: 'selected-project', studioProjectId: 'studio-project',
      username: 'fixture-user', password: 'fixture-password',
    });
    await manager.refreshBackendForVerification(tmp);
  });
});
