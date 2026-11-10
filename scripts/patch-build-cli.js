'use strict';

const fs = require('fs');
const path = require('path');

function patchBuildCli(repoPath) {
  const file = path.join(repoPath, 'src', 'requirements.js');
  let source = fs.readFileSync(file, 'utf8');
  const changes = [
    [
      "    const javaVersion = (await exec('java', ['-version'])).join('').match(/[0-9\\.]+/)[0];",
      [
        "    // wm-java-version-banner: JAVA_TOOL_OPTIONS may precede the actual version.",
        "    const javaOutput = (await exec('java', ['-version'])).join('\\n');",
        '    const javaMatch = javaOutput.match(/^\\s*(?:openjdk|java) version\\s+"([^"]+)"/m);',
        '    const javaVersion = javaMatch && semver.coerce(javaMatch[1]);',
        "    if (!javaVersion) throw new Error('Unable to parse Java version banner');",
      ].join('\n'),
    ],
    [
      '    if (semver.lt(semver.coerce(javaVersion).version, VERSIONS.JAVA)) {',
      '    if (semver.lt(javaVersion.version, VERSIONS.JAVA)) {',
    ],
  ];
  for (const [before, after] of changes) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) {
      throw new Error('Unsupported CLI Java-version parser; refusing a partial build patch');
    }
    source = source.replace(before, after);
  }
  fs.writeFileSync(file, source);
  console.log('--- Applied checked Java version-banner compatibility patch ---');
}

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/patch-build-cli.js <CLI repo>');
    patchBuildCli(path.resolve(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { patchBuildCli };
