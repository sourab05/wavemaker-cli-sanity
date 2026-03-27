import axios from 'axios';
import semver from 'semver';
import assert from 'assert';

const CLI_PACKAGE_JSON_URL =
  'https://raw.githubusercontent.com/wavemaker/wm-reactnative-cli/main/package.json';
const APPCHEF_PACKAGE_JSON_URL =
  'https://raw.githubusercontent.com/wavemaker/app-chef-build-agent/master/package.json';
const CLI_PACKAGE_NAME = '@wavemaker-ai/wm-reactnative-cli';

describe('AppChef CLI Version Compatibility', function () {
  this.timeout(30 * 1000);

  let latestCliVersion: string;
  let appchefCliVersion: string;

  before(async function () {
    const [{ data: cliPkg }, { data: appchefPkg }] = await Promise.all([
      axios.get(CLI_PACKAGE_JSON_URL),
      axios.get(APPCHEF_PACKAGE_JSON_URL),
    ]);

    latestCliVersion = cliPkg.version;
    console.log(`Latest CLI version (from GitHub main): ${latestCliVersion}`);

    if (!semver.valid(latestCliVersion)) {
      throw new Error(
        `wm-reactnative-cli package.json has an invalid semver version: "${latestCliVersion}"`
      );
    }

    appchefCliVersion = appchefPkg.dependencies?.[CLI_PACKAGE_NAME];

    if (!appchefCliVersion) {
      throw new Error(
        `${CLI_PACKAGE_NAME} not found in AppChef package.json dependencies`
      );
    }

    console.log(
      `AppChef CLI version  ${CLI_PACKAGE_NAME} : ${appchefCliVersion}`
    );
  });

  it('should have the latest CLI version satisfy the AppChef dependency range', function () {
    const satisfies = semver.satisfies(latestCliVersion, appchefCliVersion);

    console.log(
      `Checking: ${latestCliVersion} satisfies "${appchefCliVersion}" → ${satisfies}`
    );

    assert.ok(
      satisfies,
      `AppChef version mismatch!\n` +
        `Latest CLI version ${latestCliVersion} does not satisfy AppChef's declared range "${appchefCliVersion}".\n` +
        `Update the ${CLI_PACKAGE_NAME} dependency in the app-chef-build-agent repo to include ${latestCliVersion}.`
    );
  });
});
