# WaveMaker CLI Sanity Testing Framework

A standalone framework for testing WaveMaker React Native CLI functionality, including building Android/iOS apps and syncing with WaveMaker Studio projects.

## Features

- **Build Testing**: Automated Android APK and iOS IPA build testing
- **Preview Testing**: Web preview generation and verification
- **Sync Testing**: Project synchronization with WaveMaker Studio
- **Appium Integration**: Mobile app verification using Appium
- **BrowserStack Support**: Optional cloud device testing

## Prerequisites

- A Node.js version supported by the selected CLI and generated project. Current AI codegen requires Node.js 22.13 or higher; Node 22.11 fails when loading its ESM dependencies.
- npm or yarn
- WaveMaker CLI (`@wavemaker-ai/wm-reactnative-cli`)
- Android SDK (for Android builds)
- Xcode (for iOS builds, macOS only)
- Appium (for mobile app verification)

## Installation

1. Clone or download this framework:
```bash
cd ~/Documents/wavemaker-cli-sanity
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file from the example:
```bash
cp .env.example .env
```

4. Edit `.env` with your configuration:
```env
WMO_USER=your.email@wavemaker.com
WMO_PASS=your_password
# ... other configurations
```

## Usage

### Running Maven/Expo Tests (mvn-expo.ts)

Full workflow: download project from Studio, build WAR, generate RN ZIPs (dev + deployed), extract, and optionally verify in Expo Go:

```bash
npm run app
```

Requires `WM_PROJECT_ID`, `WM_USERNAME`, `WM_PASSWORD` in `.env`. Set `SKIP_EXPO_GO=true` to skip device verification (e.g. in CI).

### Running Build Tests (app.ts)

Tests Android APK and iOS IPA build from a pre-extracted RN project. Run via `run-cli-tests.sh` or:

```bash
npx mocha --require ts-node/register --timeout 999999 src/app.ts
```

What it does:
1. Sets up the build environment
2. Installs project dependencies
3. Builds Android APK
4. Installs and verifies the APK on emulator/device
5. Builds iOS IPA (macOS only, requires certificates)
6. Optionally verifies on BrowserStack

### Running Sync and Preview Tests (Preview-CLI.ts)

This script tests the sync and preview functionality:

```bash
npm run sync
```

What it does:
1. Authenticates with WaveMaker Studio
2. Syncs project from Studio
3. Starts Metro bundler and verifies with Expo Go
4. Tests web preview generation
5. Tests Esbuild web preview

## Configuration

### Environment Variables

Key environment variables (see `.env.example` for full list):

- `WMO_USER` / `WM_USERNAME`: WaveMaker Studio username
- `WMO_PASS` / `WM_PASSWORD`: WaveMaker Studio password
- `PROJECT_ID` / `WM_PROJECT_ID`: WaveMaker project ID to test
- `WM_PROJECT_ID`, `WM_USERNAME`, `WM_PASSWORD`: Required for mvn-expo.ts (download & build)
- `DEPLOYED_SERVER_URL`: Backend URL for deployed React Native build
- `SKIP_EXPO_GO`: Set to `true` to skip Expo Go device verification (e.g. CI without emulator)
- `ANDROID_EMULATOR_NAME`: Android emulator name
- `IOS_P12_CERT_PATH`: Path to iOS certificate (for iOS builds)
- `IOS_PROVISION_PROFILE_PATH`: Path to iOS provisioning profile

### Jenkins project-mode overrides and run reports

New Project creates one fresh project shared by CLI and security. The optional build parameters
`NEW_PROJECT_STUDIO_URL`, `NEW_PROJECT_USERNAME`, and masked `NEW_PROJECT_PASSWORD` select its
environment/account. Each blank field falls back to the corresponding CLI default; passwords
are preserved exactly. These inputs never modify Jenkins global credentials or `.env`.

Existing Project keeps using the independent `CLI_EXISTING_*` and `SECURITY_EXISTING_*` inputs.
When selecting a different Existing project, set `CLI_EXISTING_WEB_PREVIEW_XPATH` and
`CLI_EXISTING_APP_VERIFICATION_ID` to app-specific visible elements from that project's
screen. Empty values keep the existing defaults; these inputs never affect the New pass.
In Both, each pass runs in its own shell: Existing inputs do not affect New, and New inputs
do not affect Existing. Both can use different URLs/accounts within the same CLI variant.
Mixing classic and AI environments in a CLI Both build is rejected before provisioning;
use separate builds instead. Security-only Both uses its dedicated security fork.
Nightly runs still select New Project. AppChef Version does not provision a project.

Local runs accept the same `NEW_PROJECT_*` environment variables or `.env` entries. Use
`PROJECT_MODE="New Project"` with `run-cli-tests.sh`, or run provisioning followed by
`scripts/source-ci-project-env.sh` before a direct test command. Local Both is not supported;
use Jenkins or separate local processes. Supply credentials through environment variables
or a secret manager, not command-line literals. A stale direct ZIP or build-skip setting
is ignored in New Project mode so the new app is actually tested.

The generated `.ci-project-env.sh` contains project/app identifiers and non-secret provenance,
not passwords or usernames. Loading it requires a matching environment/account. Provisioning
deletes a previous project only if its provenance matches; old files without provenance and
files from another environment/account are not used for deletion. Provisioning invalidates
old IDs before attempting creation, so failure cannot silently reuse an old app.
The creation payload uses the deployed Studio version from its about API. Account app quotas
still apply: `MAX_APPS_LIMIT_REACHED` requires available capacity or a different account;
the runner does not delete unrelated projects to make room.

Every executed CLI/security pass records:
- Studio environment URL and project mode.
- Effective Studio username and whether username/password came from an override or defaults.
- WMPRJ project ID and Studio `proj-...` jobs API ID.

Combined Allure reports use separate `CLI_Existing_Project_*`, `CLI_New_Project_*`,
`Security_Existing_Project_*`, and `Security_New_Project_*` environment keys. Per-mode CLI
reports and security HTML/text/JSON retain their own identities. Publishing uses saved
security metadata, not the final process environment. Passwords, tokens and cookies are
excluded. Reports now contain account/project identifiers; restrict report access accordingly.
The existing S3 uploader uses `public-read`, so these identifiers will be public where that
ACL is honored.

Report directories are cleared before Jenkins checkout/setup. If initialization or setup
fails before tests run, stale reports are not generated or uploaded. Available current-run
failures and partial security scans remain reportable; an incomplete scan is never labeled clean.
Security dependency installation uses the WaveMaker registry; only `npm audit` queries
`https://registry.npmjs.org/`, because the WaveMaker Nexus endpoint does not provide audit
advisories. Snyk requires a valid `SNYK_TOKEN` for the configured Snyk endpoint. Authentication
and registry failures fail the scan; they are not treated as zero vulnerabilities.
With `SECURITY_FAIL_ON_VULN=false`, a successfully completed scan can pass while reporting
findings. Set it to `true` to make findings fail the test.

Offline validation: `npm run test:unit`, `npx tsc --noEmit`, and shell syntax checks.
Offline passes do not establish live Studio, BrowserStack, build-tool or S3 availability.

### Jenkins disk isolation and cleanup

`Initialize Build Storage` runs after checkout and before npm configuration or installation.
It requires a canonical, writable `JENKINS_HOME` on the build agent and a workspace beneath
it; there is no fallback to `/root` or `/tmp`. This job currently runs on the built-in
Linux node. An agent without that volume fails explicitly and needs its own mounted
Jenkins home configuration before it can run this pipeline.

Storage is private to the full Jenkins job name (hashed to avoid folder/name collisions):
- `${JENKINS_HOME}/ci-storage/<job-hash>/builds/<build-number>/`: disposable HOME,
  `.wm-reactnative-cli` projects, configuration and npm global links.
- `${JENKINS_HOME}/ci-tmp/<short-job-hash>/<build-number>/`: separately marked disposable
  temporary files. This path must be at most 60 UTF-8 bytes to leave room for Chromium's
  Unix socket names; long Jenkins mount paths fail preflight rather than crash Chrome.
- The sibling `cache/`: reusable npm, Yarn, Gradle, XDG and browser downloads.
- The sibling `tools/`: reusable Android SDK and Gradle installations.

The helper redirects `HOME`, `TMPDIR`/`TMP`/`TEMP`, npm cache/prefix/userconfig (both
upper- and lowercase forms), `YARN_CACHE_FOLDER`, `GRADLE_USER_HOME`, XDG directories,
`WEBDRIVER_CACHE_DIR`, `PUPPETEER_CACHE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`, and
`CYPRESS_CACHE_FOLDER`. WebdriverIO uses `WEBDRIVER_CACHE_DIR` instead of its default
OS temp directory. Child JVMs receive build-local home/temp properties through
`JAVA_TOOL_OPTIONS`; `GRADLE_OPTS` disables persistent Gradle daemons. Android tools
use the managed SDK and build-local Android user directory. The build-local npm bin
directory is prepended to the existing Jenkins tool PATH.

Credentials still come from Jenkins bindings; no legacy home files are copied.
Private Git/npm access must use explicit credentials/configuration, not an implicit
`/root/.ssh` or `/root/.npmrc`. AWS and Snyk environment bindings are unchanged.
Local runs do not use this helper and retain their existing behavior.

The final `post.cleanup` step runs after archive/upload attempts, on success, failure or
abort when the agent is reachable. It validates job/build ownership markers and path
boundaries before removing this build's disposable storage and the existing allowlist
of generated workspace outputs. It preserves report directories, caches, tools, other
build directories, and Studio projects. Unsafe boundary symlinks or ownership mismatches
fail cleanup visibly; dependency symlinks *inside* owned directories are unlinked without
following their targets. Agent loss can leave orphaned build directories, which require
separate reviewed recovery; subsequent runs do not automatically delete them.

Concurrent builds of this job are disabled. Before each build starts using caches, the
helper can recycle **only this job's marked cache directories** if their combined size
exceeds the limit or the job has not used them within the idle period. This is a
between-build policy, not an in-build quota. Node environment settings control the limits:
- `CI_STORAGE_MIN_FREE_GIB`: minimum free space before setup (default `10`).
- `CI_STORAGE_CACHE_MAX_GIB`: combined managed-cache size limit (default `20`).
- `CI_STORAGE_CACHE_IDLE_DAYS`: cache inactivity limit (default `14`).

All limits must be positive. Reports retain the existing 15-build Jenkins archive policy;
the SDK/tools directory is not automatically evicted. Legacy `/root` and `/tmp` data is
neither migrated nor deleted, so existing root-disk exhaustion still requires approved
cleanup or capacity expansion.

### Project Structure

```
wavemaker-cli-sanity/
├── src/
│   ├── config/         # Centralized configuration
│   ├── utils/          # Shared utilities (run-command, zip-utils, process-utils)
│   ├── app.ts          # Build and installation tests
│   ├── mvn-expo.ts     # Maven build, RN ZIP generation, Expo Go verification
│   └── Preview-CLI.ts  # Sync and preview tests
├── .env                 # Your configuration (create from .env.example)
├── .env.example         # Example configuration
├── run-cli-tests.sh     # Jenkins/local test runner
├── package.json         # Dependencies and scripts
└── README.md           # This file
```

## Test Scenarios

### app.ts Tests

1. **Setup Test**
   - Creates build artifacts directory
   - Cleans previous builds
   - Creates wm_rn_config.json
   - Installs npm dependencies

2. **Android Build Test**
   - Builds APK using WaveMaker CLI
   - Verifies APK generation
   - Installs on emulator/device
   - Verifies app launch with Appium

3. **iOS Build Test** (macOS only)
   - Builds IPA using WaveMaker CLI
   - Requires certificates and provisioning profiles
   - Optionally verifies on BrowserStack

### Preview-CLI.ts Tests

1. **Sync Test**
   - Authenticates with WaveMaker Studio
   - Syncs project to local
   - Captures generated project path

2. **Android Preview Test**
   - Starts Appium server
   - Launches Expo Go
   - Runs Metro bundler
   - Verifies app in Expo Go

3. **Web Preview Tests**
   - Generates Expo web preview
   - Generates Esbuild web preview
   - Verifies preview in browser

AI CLI setup applies checked compatibility patches for nested Expo CLI dependencies and
generated apps without `expo-camera`. Cached installations still run compatibility steps;
required patch failures abort startup. Modern Expo uses process-scoped `BROWSER=none`
to prevent automatic browser launches; WebDriver still verifies the configured visible app
element after HTTP readiness. An HTTP response alone is not a passing preview test.
Local Metro bundle requests use a separate, non-pooled connection with a two-minute
timeout so they cannot inherit timeout listeners from Axios HTML-request sockets.
An upstream bundle connection reset returns HTTP 502 instead of terminating the proxy.
The visible-element check must still pass; proxy error recovery does not mark a broken
or blank preview as successful.

## Customization

### Modifying Project Paths

Edit the `config` object in `src/app.ts`:

```typescript
const config: IConfig = {
  projectPath: path.resolve(__dirname, '../your-project-path'),
  buildArtifactsDir: path.join(__dirname, 'Artifacts'),
  // ... other settings
};
```

### Changing Test Timeouts

Modify timeout values in the config or environment variables:

```typescript
buildTimeout: 45 * 60 * 1000, // 45 minutes
installTimeout: 5 * 60 * 1000, // 5 minutes
```

### Adding New Tests

Add new test cases using Mocha's `it()` function:

```typescript
it('should perform custom test', async function() {
  this.timeout(60000);
  // Your test logic here
});
```

## Troubleshooting

### Common Issues

1. **Build Timeout**: Increase `BUILD_TIMEOUT` in `.env`
2. **Emulator Not Found**: Ensure Android emulator is running
3. **iOS Build Fails**: Check certificate paths and password
4. **Appium Connection Failed**: Start Appium server manually
5. **Authentication Failed**: Verify WaveMaker Studio credentials

### Debug Mode

To see more detailed output, the framework automatically logs command execution and progress.

## Dependencies

Main dependencies:
- `@wavemaker-ai/wm-reactnative-cli`: WaveMaker CLI tool
- `mocha`: Test framework
- `webdriverio`: Appium client
- `axios`: HTTP client for API calls
- `dotenv`: Environment variable management

## License

MIT

## Support

For issues related to:
- WaveMaker CLI: Contact WaveMaker support
- This framework: Create an issue in your repository

## Contributing

To extend this framework:
1. Keep `app.ts` and `Preview-CLI.ts` as the main test files
2. Add helper functions at the bottom of each file
3. Update `.env.example` with new variables
4. Document changes in this README
