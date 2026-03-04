import axios from 'axios';
import semver from 'semver';
import assert from 'assert';
import dotenv from 'dotenv';
import { createLogger } from '../../src/utils/Logger';

dotenv.config();

const log = createLogger('AppChefVersionSpec');

const CLI_PACKAGE_JSON_URL =
  'https://raw.githubusercontent.com/wavemaker/wm-reactnative-cli/main/package.json';
const APPCHEF_PACKAGE_JSON_URL =
  'https://raw.githubusercontent.com/wavemaker/app-chef-build-agent/master/package.json';
const CLI_PACKAGE_NAME = '@wavemaker/wm-reactnative-cli';

describe('AppChef CLI Version Compatibility', function () {
  this.timeout(30 * 1000);

  let latestCliVersion: string;
  let appchefCliRange: string;

  before(async function () {
    log.separator('AppChef CLI Version Compatibility');
    log.info('Fetching CLI and AppChef package.json from GitHub...');

    const [cliResponse, appchefResponse] = await Promise.all([
      axios.get(CLI_PACKAGE_JSON_URL),
      axios.get(APPCHEF_PACKAGE_JSON_URL),
    ]);

    latestCliVersion = cliResponse.data.version;
    log.info(`Latest CLI version (GitHub main): ${latestCliVersion}`);

    if (!semver.valid(latestCliVersion)) {
      throw new Error(
        `wm-reactnative-cli package.json has an invalid semver version: "${latestCliVersion}"`
      );
    }

    appchefCliRange = appchefResponse.data.dependencies?.[CLI_PACKAGE_NAME];
    if (!appchefCliRange) {
      throw new Error(
        `${CLI_PACKAGE_NAME} not found in AppChef package.json dependencies`
      );
    }

    log.info(`AppChef dependency range for ${CLI_PACKAGE_NAME}: ${appchefCliRange}`);
  });

  it('should have the latest CLI version satisfy the AppChef dependency range', function () {
    const satisfies = semver.satisfies(latestCliVersion, appchefCliRange);

    log.info(`Checking: ${latestCliVersion} satisfies "${appchefCliRange}" → ${satisfies}`);

    assert.ok(
      satisfies,
      `AppChef version mismatch!\n` +
        `Latest CLI version ${latestCliVersion} does not satisfy AppChef's declared range "${appchefCliRange}".\n` +
        `Update the ${CLI_PACKAGE_NAME} dependency in the app-chef-build-agent repo to include ${latestCliVersion}.`
    );

    log.success('CLI version is compatible with AppChef');
  });

  after(function () {
    log.separator('AppChef Version Check Complete');
  });
});
