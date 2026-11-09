#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (source.split(before).length !== 2) {
    throw new Error(`Unsupported preview CLI source: ${label}; refusing a partial patch`);
  }
  return source.replace(before, after);
}

function patchPreviewCli(repoPath) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
  if (pkg.name !== '@wavemaker-ai/wm-reactnative-cli') {
    console.log('--- Preview startup patch: non-AI CLI left unchanged ---');
    return;
  }
  const updates = new Map();
  for (const name of ['web-preview-launcher.js', 'expo-launcher.js', 'utils.js']) {
    const file = path.join(repoPath, 'src', name);
    let source = fs.readFileSync(file, 'utf8');
    source = replaceOnce(source,
      "const axios = require('axios');",
      "// wm-preview-http: bound remote polling and metadata requests.\nconst axios = require('axios').create({ timeout: 60000 });",
      `${name} HTTP client`);
    if (name === 'web-preview-launcher.js') {
      const runtimeBoundaries = [
        '    const nodeModulesDir = `${expoDir}/node_modules/${global.WM_REPO_SCOPE}/app-rn-runtime`;',
        '    const nodeModulesDir = `${expoDir}/node_modules/@wavemaker-ai/app-rn-runtime`;',
      ].filter(line => source.includes(line));
      const installErrors = ['error', 'fail'].map(method =>
        `        taskLogger.${method}(e+' Encountered an error while installing dependencies.');`
      ).filter(line => source.includes(line));
      if (runtimeBoundaries.length !== 1 || installErrors.length !== 1) {
        throw new Error('Unsupported preview CLI source: installation boundary/error handler; refusing a partial patch');
      }
      source = replaceOnce(source,
        '    if (fs.existsSync(`${expoDir}/node_modules/expo`)) {\n        return;\n    }',
        [
          '    // wm-preview-cached-install: compatibility steps also run after a failed prior patch.',
          '    process.env.BROWSER = "none"; // Supported by modern Expo; browser assertions use WebDriver.',
          '    if (!fs.existsSync(`${expoDir}/node_modules/expo`)) {',
        ].join('\n'),
        'cached Expo dependency installation');
      source = replaceOnce(source,
        runtimeBoundaries[0],
        [
          '    } // wm-preview-cached-install',
          runtimeBoundaries[0],
        ].join('\n'),
        'cached Expo installation boundary');
      source = replaceOnce(source,
        "    if(expoVersion != '52.0.17' && expoVersion != '54.0.12'){",
        [
          '    // wm-preview-camera: newer generated web apps do not declare expo-camera.',
          '    const expoManifest = JSON.parse(fs.readFileSync(path.join(expoDir, "package.json"), "utf8"));',
          '    const usesExpoCamera = Boolean((expoManifest.dependencies || {})["expo-camera"] || (expoManifest.devDependencies || {})["expo-camera"]);',
          "    if(usesExpoCamera && expoVersion != '52.0.17' && expoVersion != '54.0.12'){",
        ].join('\n'),
        'optional Expo camera dependency');
      source = replaceOnce(source,
        '        readAndReplaceFileContent(`${expoDir}/node_modules/expo-camera/build/useWebQRScanner.js`, (c) => {',
        '        await readAndReplaceFileContent(`${expoDir}/node_modules/expo-camera/build/useWebQRScanner.js`, (c) => {',
        'await camera compatibility patch');
      source = replaceOnce(source,
        installErrors[0],
        installErrors[0] + '\n        throw e; // wm-preview-install-error: never start with incomplete compatibility patches.',
        'propagate Expo installation failure');
      source = replaceOnce(source,
        "        content = content.replace('getEnvPrelude(str)', '//getEnvPrelude(str)');",
        [
          '        // wm-preview-serializer: cached retries must not duplicate the injected prelude.',
          "        if (content.includes('firstModule.output[0].data.code = firstModule.output[0].data.code + str;')) return content;",
          "        content = content.replace('getEnvPrelude(str)', '//getEnvPrelude(str)');",
        ].join('\n'),
        'idempotent Metro serializer patch');
      source = replaceOnce(source,
        '        readAndReplaceFileContent(`${expoDir}/node_modules/@expo/cli/build/src/utils/open.js`, (c) => c.replace(\'if (process.platform !== "win32")\', \'return;\\n\\n if (process.platform !== "win32")\'));',
        [
          '        // wm-preview-expo-layout: npm may nest @expo/cli under expo.',
          "        const expoPackageDir = path.dirname(require.resolve('expo/package.json', { paths: [expoDir] }));",
          "        const expoCliPackageDir = path.dirname(require.resolve('@expo/cli/package.json', { paths: [expoPackageDir] }));",
          '        await readAndReplaceFileContent(path.join(expoCliPackageDir, \'build/src/utils/open.js\'), (c) => c.replace(\'if (process.platform !== "win32")\', \'return;\\n\\n if (process.platform !== "win32")\'));',
        ].join('\n'),
        'Expo CLI dependency layout');
      source = replaceOnce(source,
        '        let isExpoStarted = false;',
        [
          '        // wm-preview-startup: initial startup must not wait for a remote change event.',
          '        let isExpoStarted = true;',
          '        launchServiceProxy(projectDir, previewUrl);',
          "        exec('npx', ['expo', 'start', '--web', '--offline', `--port=${webPreviewPort}`], {",
          '            cwd: getExpoProjectDir(projectDir)',
          '        }).catch(error => {',
          "            console.error('Expo preview server failed:', String(error));",
          '            process.exit(1);',
          '        });',
        ].join('\n'),
        'initial Expo startup');
      // The proxy must answer rather than leave the client hanging if Metro is unavailable.
      source = replaceOnce(source,
        '                    streamToString(request(tUrl)).then(content => {',
        [
          '                    // wm-preview-bundle-socket: do not reuse Axios sockets with retained timeout listeners.',
          '                    streamToString(request(tUrl, { pool: false, timeout: 120000 })).then(content => {',
        ].join('\n'),
        'isolated bounded Metro bundle request');
      source = replaceOnce(source,
        '                        res.write(content);\n                        res.end();\n                    });',
        [
          '                        res.write(content);',
          '                        res.end();',
          '                    }).catch(error => {',
          '                        // wm-preview-bundle-error: retain a failed HTTP response, not an unhandled rejection.',
          "                        console.error('Expo bundle upstream failed:', error.code || error.name);",
          "                        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });",
          "                        res.end('Expo bundle upstream failed');",
          '                    });',
        ].join('\n'),
        'bundle proxy error response');
      source = replaceOnce(source,
        ".replace('/index.bundle?', `./index.bundle?minify=true&`));\n                });",
        [
          ".replace('/index.bundle?', `./index.bundle?minify=true&`));",
          '                }).catch(() => {',
          "                    res.writeHead(502, { 'Content-Type': 'text/plain' });",
          "                    res.end('Expo preview upstream is not ready');",
          '                });',
        ].join('\n'),
        'proxy error response');
    }
    updates.set(file, source);
  }
  // Validate every expected source block before writing any file.
  for (const [file, source] of updates) fs.writeFileSync(file, source);
  console.log('--- Applied checked AI CLI preview startup/HTTP patches ---');
}

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/patch-preview-cli.js <CLI repo>');
    patchPreviewCli(path.resolve(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { patchPreviewCli };
