# WaveMaker CLI Sanity Testing Framework

A standalone framework for testing WaveMaker React Native CLI functionality, including building Android/iOS apps and syncing with WaveMaker Studio projects.

## Features

- **Build Testing**: Automated Android APK and iOS IPA build testing
- **Preview Testing**: Web preview generation and verification
- **Sync Testing**: Project synchronization with WaveMaker Studio
- **Appium Integration**: Mobile app verification using Appium
- **BrowserStack Support**: Optional cloud device testing

## Prerequisites

- Node.js (v14 or higher)
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
