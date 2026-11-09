import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as vm from 'vm';
import { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import { runCommand, createTokenPromptHandler } from '../../src/utils/run-command';
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

  it('ignores the token URL and answers a split ANSI prompt only once without closing stdin', () => {
    const stdin = new PassThrough();
    const child = { stdin };
    let output = '';
    stdin.on('data', data => { output += data.toString(); });
    const handle = createTokenPromptHandler('fixture-token');
    handle('https://fixture.test/studio/services/auth/token\n', child);
    assert.equal(output, '');
    handle('\x1b[32mprompt: to', child);
    handle('ken:\x1b[0m ', child);
    handle('\nprompt: token: ', child);
    assert.equal(output, 'fixture-token\n');
    assert.equal(stdin.writableEnded, false);
    stdin.end();
  });

  for (const cached of [false, true]) {
    for (const camera of [false, true]) {
      it(`handles ${cached ? 'cached' : 'fresh'} Expo dependencies ${camera ? 'with' : 'without'} camera and awaits required patches`, async () => {
        cliFixture();
        patchPreviewCli(tmp);
        const expoDir = path.join(tmp, 'project');
        fs.mkdirSync(expoDir);
        fs.writeFileSync(path.join(expoDir, 'package.json'), JSON.stringify({
          dependencies: camera ? { 'expo-camera': 'fixture' } : {},
        }));
        if (cached) fs.mkdirSync(path.join(expoDir, 'node_modules/expo'), { recursive: true });
        let installs = 0;
        let patches = 0;
        let failPatch = false;
        const env: Record<string, string> = {};
        const context = vm.createContext({
          require: () => ({ create: () => ({}) }), fs, path, process: { env },
          global: { WM_REPO_SCOPE: '@fixture' }, expoVersion: '57.0.19', expoDir,
          taskLogger: { error: () => {} },
          installFixture: async () => { installs++; },
          readAndReplaceFileContent: async (file: string) => {
            assert(file.endsWith('/expo-camera/build/useWebQRScanner.js'));
            await new Promise(resolve => setTimeout(resolve, 5));
            if (failPatch) throw new Error('required camera file missing');
            patches++;
          },
        });
        vm.runInContext(fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8'), context);
        await vm.runInContext('installDependencies(expoDir)', context);
        assert.equal(installs, cached ? 0 : 1);
        assert.equal(patches, camera ? 1 : 0);
        assert.equal(env.BROWSER, 'none');
        if (camera) {
          failPatch = true;
          await assert.rejects(vm.runInContext('installDependencies(expoDir)', context), /required camera file missing/);
        }
      });
    }
  }

  it('does not write a token to closed stdin', () => {
    const stdin = new PassThrough();
    stdin.end();
    createTokenPromptHandler('fixture-token')('prompt: token:', { stdin });
  });

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

  function cliFixture(variant = 'scoped') {
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
      'async function patchExpoBrowserOpen(expoDir) {',
      '        readAndReplaceFileContent(`${expoDir}/node_modules/@expo/cli/build/src/utils/open.js`, (c) => c.replace(\'if (process.platform !== "win32")\', \'return;\\n\\n if (process.platform !== "win32")\'));',
      '}',
      'async function installDependencies(projectDir) {',
      '  try {',
      '    const expoDir = projectDir;',
      '    if (fs.existsSync(`${expoDir}/node_modules/expo`)) {',
      '        return;',
      '    }',
      '    await installFixture(expoDir);',
      variant === 'scoped'
        ? '    const nodeModulesDir = `${expoDir}/node_modules/${global.WM_REPO_SCOPE}/app-rn-runtime`;'
        : '    const nodeModulesDir = `${expoDir}/node_modules/@wavemaker-ai/app-rn-runtime`;',
      "    if(expoVersion != '52.0.17' && expoVersion != '54.0.12'){",
      '        readAndReplaceFileContent(`${expoDir}/node_modules/expo-camera/build/useWebQRScanner.js`, (c) => {',
      '            return c;',
      '        });',
      '    }',
      '  } catch (e) {',
      `        taskLogger.${variant === 'scoped' ? 'error' : 'fail'}(e+' Encountered an error while installing dependencies.');`,
      '  }',
      '}',
      'function patchSerializer(content) {',
      "        content = content.replace('getEnvPrelude(str)', '//getEnvPrelude(str)');",
      "        return content.replace('// process.env', '// process.env \\n firstModule.output[0].data.code = firstModule.output[0].data.code + str;');",
      '}',
      'function respondBundle(res) {',
      '    const tUrl = "http://upstream/index.bundle";',
      '                    streamToString(request(tUrl)).then(content => {',
      '                        res.write(content);',
      '                        res.end();',
      '                    });',
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

  for (const layout of ['hoisted', 'nested']) {
    it(`resolves and awaits Expo CLI compatibility patch with ${layout} dependencies`, async () => {
      cliFixture();
      patchPreviewCli(tmp);
      const expoDir = path.join(tmp, 'project');
      const expoPackageDir = path.join(expoDir, 'node_modules/expo');
      const cliPackageDir = path.join(layout === 'nested' ? expoPackageDir : expoDir, 'node_modules/@expo/cli');
      fs.mkdirSync(cliPackageDir, { recursive: true });
      fs.mkdirSync(expoPackageDir, { recursive: true });
      fs.writeFileSync(path.join(expoPackageDir, 'package.json'), '{"name":"expo"}');
      fs.writeFileSync(path.join(cliPackageDir, 'package.json'), '{"name":"@expo/cli"}');
      let finished = false;
      const requireMock = Object.assign(() => ({ create: () => ({}) }), { resolve: require.resolve });
      const context = vm.createContext({
        require: requireMock, path,
        readAndReplaceFileContent: async (file: string, replace: (text: string) => string) => {
          assert.equal(file, path.join(fs.realpathSync(cliPackageDir), 'build/src/utils/open.js'));
          assert(replace('if (process.platform !== "win32")').startsWith('return;'));
          await new Promise(resolve => setTimeout(resolve, 5));
          finished = true;
        },
      });
      vm.runInContext(fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8'), context);
      context.expoDir = expoDir;
      await vm.runInContext('patchExpoBrowserOpen(expoDir)', context);
      assert(finished, 'the compatibility patch must complete before server startup');
    });
  }

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

  it('returns a failed HTTP response for a bundle reset without an unhandled rejection', async () => {
    cliFixture();
    patchPreviewCli(tmp);
    const errors: string[][] = [];
    const context = vm.createContext({
      require: () => ({ create: () => ({}) }),
      request: () => ({}),
      streamToString: () => Promise.reject(Object.assign(new Error('private URL'), { code: 'ECONNRESET' })),
      console: { error: (...args: string[]) => errors.push(args) },
    });
    vm.runInContext(fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8'), context);
    await new Promise<void>(resolve => {
      context.res = {
        headersSent: false,
        writeHead: (status: number) => assert.equal(status, 502),
        end: (body: string) => { assert.equal(body, 'Expo bundle upstream failed'); resolve(); },
      };
      vm.runInContext('respondBundle(res)', context);
    });
    assert.deepStrictEqual(errors, [['Expo bundle upstream failed:', 'ECONNRESET']]);
  });

  it('survives a real upstream socket reset and serves a subsequent bundle', async () => {
    cliFixture();
    patchPreviewCli(tmp);
    let requests = 0;
    const errors: string[][] = [];
    await withServer((req, res) => {
      if (++requests === 1) req.socket.destroy();
      else res.end('window.previewReady = true;');
    }, async upstream => {
      const context = vm.createContext({
        require: () => ({ create: () => ({}) }),
        request: (_url: string, options: { pool: boolean; timeout: number }) => {
          assert.equal(options.pool, false);
          assert.equal(options.timeout, 120000);
          const stream = new PassThrough();
          const request = http.get(upstream, { agent: false }, response => response.pipe(stream));
          request.on('error', error => stream.destroy(error));
          request.setTimeout(2000, () => request.destroy(new Error('upstream timed out')));
          return stream;
        },
        streamToString: (stream: PassThrough) => new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
          stream.on('error', reject);
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }),
        console: { error: (...args: string[]) => errors.push(args) },
      });
      vm.runInContext(fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8'), context);
      await withServer((_, res) => context.respondBundle(res), async proxy => {
        const get = () => new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
          const request = http.get(proxy, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, body }));
          });
          request.on('error', reject);
          request.setTimeout(2000, () => request.destroy(new Error('proxy timed out')));
        });
        assert.deepStrictEqual(await get(), { status: 502, body: 'Expo bundle upstream failed' });
        assert.deepStrictEqual(await get(), { status: 200, body: 'window.previewReady = true;' });
      });
    });
    assert.equal(requests, 2);
    assert.deepStrictEqual(errors, [['Expo bundle upstream failed:', 'ECONNRESET']]);
  });

  it('does not inherit a timed Axios socket listener while waiting for a slow Metro bundle', async () => {
    cliFixture();
    patchPreviewCli(tmp);
    const axios = require('axios');
    const request = require(require.resolve('request', {
      paths: [path.dirname(require.resolve('@wavemaker-ai/wm-reactnative-cli/package.json'))],
    }));
    const transport = require('http') as typeof import('http');
    const originalAgent = transport.globalAgent;
    const sharedAgent = new http.Agent({ keepAlive: true, timeout: 50 });
    transport.globalAgent = sharedAgent;
    try {
      await withServer((req, res) => {
        if (req.url === '/warmup') res.end('<html>ready</html>');
        else setTimeout(() => res.end('window.slowBundleLoaded = true;'), 250);
      }, async upstream => {
        await axios.create({ timeout: 60000 }).get(new URL('/warmup', upstream).href, { proxy: false });
        assert(Object.values(sharedAgent.freeSockets).some(sockets => sockets && sockets.length > 0));
        const context = vm.createContext({
          require: () => ({ create: () => ({}) }),
          request: (_url: string, options: { pool: boolean; timeout: number }) => request(upstream, options),
          streamToString: (stream: PassThrough) => new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
            stream.on('error', reject);
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          }),
          console: { error: () => {} },
        });
        vm.runInContext(fs.readFileSync(path.join(tmp, 'src/web-preview-launcher.js'), 'utf8'), context);
        const result = await new Promise<{ status: number; body: string }>(resolve => {
          let status = 200;
          let body = '';
          context.respondBundle({
            headersSent: false,
            writeHead: (code: number) => { status = code; },
            write: (text: string) => { body += text; },
            end: (text = '') => resolve({ status, body: body + text }),
          });
        });
        assert.deepStrictEqual(result, { status: 200, body: 'window.slowBundleLoaded = true;' });
      });
    } finally {
      transport.globalAgent = originalAgent;
      sharedAgent.destroy();
    }
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
    const context = vm.createContext({
      require: () => ({ create: () => ({}) }),
      content: 'getEnvPrelude(str); // process.env',
    });
    vm.runInContext(first, context);
    const patched = vm.runInContext('patchSerializer(content)', context);
    context.content = patched;
    assert.equal(vm.runInContext('patchSerializer(content)', context), patched);
  });

  it('supports the published AI CLI hardcoded runtime and fail logger without partial source normalization', () => {
    cliFixture('published');
    patchPreviewCli(tmp);
    const file = path.join(tmp, 'src/web-preview-launcher.js');
    const first = fs.readFileSync(file, 'utf8');
    assert(first.includes('node_modules/@wavemaker-ai/app-rn-runtime'));
    assert(first.includes("taskLogger.fail(e+' Encountered an error while installing dependencies.');\n        throw e;"));
    new vm.Script(first);
    patchPreviewCli(tmp);
    assert.equal(fs.readFileSync(file, 'utf8'), first);
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
