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
