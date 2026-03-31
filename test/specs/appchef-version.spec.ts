import axios from 'axios';
import semver from 'semver';
import assert from 'assert';
import dotenv from 'dotenv';
import { createLogger } from '../../src/utils/Logger';
import { getCliVariant } from '../../src/utils/cli-variant';

dotenv.config();

const log = createLogger('AppChefVersionSpec');
const variant = getCliVariant();

const CLI_PACKAGE_JSON_URL =
  'https://raw.githubusercontent.com/wavemaker/wm-reactnative-cli/main/package.json';
const APPCHEF_PACKAGE_JSON_URL =
  'https://raw.githubusercontent.com/wavemaker/app-chef-build-agent/master/package.json';
const CLI_PACKAGE_NAME = variant.packageName;

describe('AppChef CLI Version Compatibility', function () {
  this.timeout(30 * 1000);

  it('should have the latest CLI version satisfy the AppChef dependency range', async function () {
    log.separator('AppChef CLI Version Compatibility');
    log.info(`CLI variant: ${variant.platform} (${CLI_PACKAGE_NAME})`);
    log.info('Fetching CLI and AppChef package.json from GitHub...');

    const [cliResponse, appchefResponse] = await Promise.all([
      axios.get(CLI_PACKAGE_JSON_URL),
      axios.get(APPCHEF_PACKAGE_JSON_URL),
    ]);

    const latestCliVersion = cliResponse.data.version;
    log.info(`Latest CLI version (GitHub main): ${latestCliVersion}`);

    assert.ok(
      semver.valid(latestCliVersion),
      `wm-reactnative-cli package.json has an invalid semver version: "${latestCliVersion}"`
    );

    const appchefCliRange = appchefResponse.data.dependencies?.[CLI_PACKAGE_NAME];
    assert.ok(
      appchefCliRange,
      `${CLI_PACKAGE_NAME} not found in AppChef package.json dependencies.\n` +
        `Available CLI dependencies: ${Object.keys(appchefResponse.data.dependencies || {}).filter(k => k.includes('wm-reactnative')).join(', ') || 'none'}`
    );

    log.info(`AppChef dependency range for ${CLI_PACKAGE_NAME}: ${appchefCliRange}`);

    const satisfies = semver.satisfies(latestCliVersion, appchefCliRange);
    log.info(`Checking: ${latestCliVersion} satisfies "${appchefCliRange}" → ${satisfies}`);

    assert.ok(
      satisfies,
      `AppChef version mismatch!\n` +
        `Latest CLI version ${latestCliVersion} does not satisfy AppChef's declared range "${appchefCliRange}".\n` +
        `Update the ${CLI_PACKAGE_NAME} dependency in the app-chef-build-agent repo to include ${latestCliVersion}.`
    );

    log.success('CLI version is compatible with AppChef');
    log.separator('AppChef Version Check Complete');
  });
});
