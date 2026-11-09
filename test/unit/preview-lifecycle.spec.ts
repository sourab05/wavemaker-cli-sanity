import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as vm from 'vm';
import { ChildProcess } from 'child_process';
import { runCommand } from '../../src/utils/run-command';
import { startWebPreview, waitForPreviewHttp, webPreviewTestTimeout } from '../../src/utils/web-preview';
const { patchPreviewCli } = require('../../scripts/patch-preview-cli');

const running = { exitCode: null, signalCode: null } as ChildProcess;

describe('Preview startup and timeout ownership (offline)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-preview-test-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function command(source: string): string {
    const file = path.join(tmp, 'server.js');
    fs.writeFileSync(file, source);
    return `"${process.execPath}" "${file}"`;
  }

  async function withServer(handler: http.RequestListener, test: (url: string) => Promise<void>) {
    const server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await test(`http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/rn-bundle/index.html`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  it('puts the Mocha deadline beyond startup, browser verification, and cleanup', () => {
    assert.equal(webPreviewTestTimeout(900000), 1260000);
    const spec = fs.readFileSync(path.resolve('test/specs/preview-cli.spec.ts'), 'utf8');
    assert.equal((spec.match(/this\.timeout\(webPreviewTestTimeout\(config\.syncTimeout\)\)/g) || []).length, 2);
    assert(spec.includes('previewController?.abort()'));
  });

  it('reports the last HTTP status without leaking query parameters', async () => {
    await withServer((_, res) => { res.writeHead(503); res.end('starting'); }, async url => {
      await assert.rejects(waitForPreviewHttp(`${url}?token=private-fixture`, running, 150), (e: Error) =>
        e.message.includes('HTTP 503') && !e.message.includes('private-fixture'));
    });
  });

  it('rejects a 200 response without HTML', async () => {
    await withServer((_, res) => res.end('not ready'), async url => {
      await assert.rejects(waitForPreviewHttp(url, running, 150), /HTTP 200 without HTML/);
    });
  });

  it('bounds a hung HTTP response by the readiness deadline', async () => {
    await withServer(() => {}, async url => {
      const started = Date.now();
      await assert.rejects(waitForPreviewHttp(url, running, 200), /last response: ECONNABORTED/);
      assert(Date.now() - started < 1500);
    });
  });

  it('cancels an in-flight readiness request', async () => {
    const controller = new AbortController();
    await withServer(() => {}, async url => {
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        await assert.rejects(waitForPreviewHttp(url, running, 10000, controller.signal), /cancelled/);
      } finally { clearTimeout(timer); }
    });
  });

  it('cancels a silent persistent command before it announces readiness', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await assert.rejects(runCommand(command('setInterval(() => {}, 1000);'), {
        timeout: 10000, keepAlive: true, successMessage: 'ready', signal: controller.signal,
      }), /cancelled/);
    } finally { clearTimeout(timer); }
  });

  it('stops an owned preview when cancelled after HTTP readiness', async () => {
    const controller = new AbortController();
    const pidFile = path.join(tmp, 'pid');
    const preview = await startWebPreview(command(`
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      const server = require('http').createServer((req, res) => res.end('<html>ready</html>'));
      server.listen(0, '127.0.0.1', () =>
        console.log('Service proxy launched at http://127.0.0.1:' + server.address().port));
    `), '', 3000, controller.signal);
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      process.kill(pid, 0);
      controller.abort();
      let stopped = false;
      for (let i = 0; i < 30; i++) {
        try { process.kill(pid, 0); } catch { stopped = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(stopped, 'preview must stop before another test starts');
    } finally { preview.stop(); }
  });

  function cliFixture() {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: '@wavemaker-ai/wm-reactnative-cli' }));
    const source = [
      "const axios = require('axios');",
      'function respond(res) {',
      '    axios.get("http://upstream/index.html").then(body => {',
      '        res.end(body.data',
      "            .replace('/index.bundle?', `./index.bundle?minify=true&`));",
      '                });',
      '}',
      'async function runWeb() {',
      '        let isExpoStarted = false;',
      '        await isExpoWebPreviewContainer();',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(tmp, 'src/web-preview-launcher.js'), source);
    for (const name of ['expo-launcher.js', 'utils.js']) {
      fs.writeFileSync(path.join(tmp, 'src', name), "const axios = require('axios');\n");
    }
    return source;
  }

  it('starts the local proxy and Expo before remote preview detection can hang', async () => {
    cliFixture();
    patchPreviewCli(tmp);
    const source = fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8');
    const events: string[] = [];
    const context = vm.createContext({
      require: () => ({ create: (options: { timeout: number }) => {
        assert.equal(options.timeout, 60000);
        return {};
      } }),
      projectDir: tmp, previewUrl: 'https://example.invalid', webPreviewPort: 19006,
      launchServiceProxy: () => events.push('proxy'),
      getExpoProjectDir: () => tmp,
      exec: (_cmd: string, args: string[]) => {
        assert(args.includes('--web'));
        events.push('expo');
        return new Promise(() => {});
      },
      isExpoWebPreviewContainer: () => { events.push('remote'); return new Promise(() => {}); },
    });
    vm.runInContext(source, context);
    vm.runInContext('runWeb()', context);
    assert.deepStrictEqual(events, ['proxy', 'expo', 'remote']);
  });

  it('answers with 502 when the Expo upstream request fails', async () => {
    cliFixture();
    patchPreviewCli(tmp);
    const context = vm.createContext({
      require: () => ({ create: () => ({ get: () => Promise.reject(new Error('offline')) }) }),
    });
    vm.runInContext(fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8'), context);
    await new Promise<void>(resolve => {
      context.res = {
        writeHead: (status: number) => assert.equal(status, 502),
        end: (body: string) => { assert.equal(body, 'Expo preview upstream is not ready'); resolve(); },
      };
      vm.runInContext('respond(res)', context);
    });
  });

  it('patches idempotently and rejects incompatible source without partial writes', () => {
    const original = cliFixture();
    fs.writeFileSync(path.join(tmp, 'src/utils.js'), 'unsupported');
    assert.throws(() => patchPreviewCli(tmp), /Unsupported preview CLI source/);
    assert.equal(fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8'), original);
    fs.writeFileSync(path.join(tmp, 'src/utils.js'), "const axios = require('axios');\n");
    patchPreviewCli(tmp);
    const first = fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8');
    patchPreviewCli(tmp);
    assert.equal(fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8'), first);
  });

  it('does not patch classic CLI and links the tested checkout after npm install', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: '@wavemaker/wm-reactnative-cli' }));
    patchPreviewCli(tmp);
    assert(!fs.existsSync(path.join(tmp, 'src')));
    const pipeline = fs.readFileSync(path.resolve('Jenkinsfile'), 'utf8');
    const installStage = pipeline.slice(pipeline.indexOf("stage('Install Dependencies')"),
      pipeline.indexOf("stage('Provision Studio Project')"));
    assert(installStage.indexOf('npm install') < installStage.indexOf('npm link'));
    assert(installStage.includes('Verified CLI checkout link'));
  });
});
