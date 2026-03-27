# WaveMaker CLI Sanity — Test Cases & Approach Document

> **Framework**: Mocha + WebDriverIO (Standalone) + Allure Reporting  
> **Architecture**: Page Object Model (POM) with Service Layer  
> **Last Updated**: February 2026

---

## Table of Contents

1. [Framework Architecture](#1-framework-architecture)
2. [Spec 1 — AppChef CLI Version Compatibility](#2-spec-1--appchef-cli-version-compatibility)
3. [Spec 2 — WM CLI Sync & Web Preview](#3-spec-2--wm-cli-sync--web-preview)
4. [Spec 3 — React Native App Build & Run](#4-spec-3--react-native-app-build--run)
5. [Spec 4 — Maven Build & Expo Go Verification](#5-spec-4--maven-build--expo-go-verification)
6. [Failure Handling Strategy](#6-failure-handling-strategy)
7. [Execution Guide](#7-execution-guide)

---

## 1. Framework Architecture

```
test/specs/                         ← Spec files (test cases)
  ├── appchef-version.spec.ts
  ├── preview-cli.spec.ts
  ├── app-build.spec.ts
  └── maven-expo.spec.ts

src/pages/                          ← Page Object Model
  ├── BasePage.ts                   (common: wait, screenshot, close)
  ├── NativeApp.page.ts             (native Android/iOS app)
  ├── ExpoGoApp.page.ts             (Expo Go container app)
  └── WebPreview.page.ts            (browser-based web preview)

src/services/                       ← Business Logic Layer
  ├── AuthService.ts                (WM Studio authentication)
  ├── ProjectService.ts             (export, download, extract projects)
  ├── MavenService.ts               (mvn builds, RN ZIP generation)
  └── AppiumService.ts              (Appium server lifecycle)

src/helpers/
  └── DriverFactory.ts              (Appium / Browser / BrowserStack sessions)

src/utils/
  ├── Logger.ts                     (structured, timestamped logging)
  ├── run-command.ts                (shell command runner with prompts)
  ├── zip-utils.ts                  (cross-platform ZIP extraction)
  └── process-utils.ts              (process kill utilities)
```

---

## 2. Spec 1 — AppChef CLI Version Compatibility

**File**: `test/specs/appchef-version.spec.ts`  
**Suite Timeout**: 30 seconds  
**Purpose**: Ensures the latest `wm-reactnative-cli` version on GitHub is compatible with the version range declared in the AppChef build agent.

| # | Test Case | Approach | Assertions |
|---|-----------|----------|------------|
| — | **before** | Fetches `package.json` from both GitHub repos in parallel using `axios`. Extracts the CLI version and the AppChef dependency range. Validates the CLI version is valid semver. Fails early if either fetch fails or the dependency entry is missing. | — |
| 1 | **should have the latest CLI version satisfy the AppChef dependency range** | Uses `semver.satisfies()` to check if the latest CLI version falls within AppChef's declared dependency range. | Asserts `true`. On failure, the error message specifies both versions and instructs which repo needs updating. |
| — | **after** | Logs suite completion. | — |

**Key Design Decisions**:
- Both HTTP fetches run in `Promise.all` for speed.
- If the CLI version is not valid semver, the `before` hook throws, preventing the test from running with bad data.
- The assertion message is actionable — it tells the engineer exactly what to do.

---

## 3. Spec 2 — WM CLI Sync & Web Preview

**File**: `test/specs/preview-cli.spec.ts`  
**Suite Timeout**: 20 minutes  
**Purpose**: Tests the CLI `sync` command (project synchronization from WaveMaker Studio) and both web preview modes (Expo and Esbuild).

| # | Test Case | Approach | Assertions / Verification |
|---|-----------|----------|--------------------------|
| — | **before** | 1. Loads `PreviewCLIConfig` from `.env`. 2. Creates `AuthService` and authenticates against WaveMaker Studio (`POST /login/authenticate`) to obtain `auth_cookie`. 3. Calls the Studio API to get the live preview URL for the configured project. | Auth cookie obtained. Preview URL is a valid HTTPS URL. |
| 1 | **should run sync command and capture the Expo project path** | Executes `npx @wavemaker-ai/wm-reactnative-cli sync "<previewUrl>"`. Monitors stdout via regex `resolveOnRegex` to capture the generated project path. Handles interactive `token:` prompt by writing the auth cookie value to stdin. | Generated Expo project directory exists on disk. |
| 2 | **should start the project and verify the app in Expo Go on Android** | 1. Starts Appium server via `AppiumService`. 2. Creates an Appium session targeting Expo Go (`host.exp.exponent`). 3. Runs `npm run android` in the synced project and waits for Metro bundler to report "Waiting on localhost:8081". 4. Waits 15s for app load. 5. Uses `ExpoGoAppPage` POM to verify the `~mobile_navbar1_title` accessibility ID is displayed. | Element is visible within 60s. Screenshot captured on failure. |
| 3 | **should run Expo web-preview and generate the Expo Web App** | 1. Runs `npx @wavemaker-ai/wm-reactnative-cli run web-preview "<previewUrl>"` and waits for the success message "Project transpiled successfully". 2. Launches a Chrome browser session via `DriverFactory`. 3. Uses `WebPreviewPage` POM to navigate to the preview URL and verify the navbar XPath element is displayed. | XPath `(//h1[@aria-label='mobile_navbar1_title']...)[2]` visible within 30s. Screenshot on failure. |
| 4 | **should run Esbuild web-preview and generate the Esbuild Web App** | Runs `npx @wavemaker-ai/wm-reactnative-cli run web-preview "<previewUrl>" --esbuild` and waits for the "Project transpiled successfully" message. | CLI exits successfully with the success message. |
| — | **after** | Kills any leftover Metro process. Stops Appium server if still running. | — |

**Key Design Decisions**:
- Test 2 skips automatically if test 1 failed (no `generatedProjectPath`).
- Token prompt handling uses ANSI-stripped regex matching to work regardless of terminal color codes.
- Metro and Appium processes are always cleaned up in `finally` blocks to prevent orphan processes.

---

## 4. Spec 3 — React Native App Build & Run

**File**: `test/specs/app-build.spec.ts`  
**Suite Timeout**: Governed by `config.buildTimeout` (default: 45 minutes)  
**Purpose**: Tests building a React Native project into native Android APK and iOS IPA, then verifies the built app runs correctly on an emulator (or BrowserStack for iOS).

| # | Test Case | Approach | Assertions / Verification |
|---|-----------|----------|--------------------------|
| — | **before** | 1. Loads `AppConfig` from `.env`. 2. Cleans and recreates the `Artifacts/` build directory. 3. Creates `wm_rn_config.json` if missing (app name, bundle ID, version). 4. Runs `npm install` in the RN project directory, auto-responding to eject/port prompts. | Dependency installation completes without error. |
| 1 | **should build the Android APK successfully** | Runs `wm-reactnative build android "<projectPath>" --dest="<artifactsDir>" --auto-eject=true`. Waits for stdout to contain "android BUILD SUCCEEDED". After completion, scans `output/android/` for `.apk` files. | At least one `.apk` file exists in the output directory. |
| 2 | **should install and verify the Android app on emulator** | 1. Checks `adb devices` for a connected emulator/device. 2. Installs the APK via `adb install -r`. 3. Creates an Appium session with UiAutomator2 capabilities (device name, platform version from env). 4. Uses `NativeAppPage` POM: activates the app by package name, then waits for the accessibility ID element to be displayed. | Element `~mobile_navbar1_title` is visible after app activation. Screenshot on failure. Skips if APK not available. |
| 3 | **should build the iOS IPA successfully** | Skipped if not macOS or if iOS certificates are missing. Runs `wm-reactnative build ios` with P12 certificate, provisioning profile, and password flags. Polls for the expected IPA file during build. If `RUN_LOCAL=false`, additionally launches the IPA on BrowserStack (XCUITest session on iPhone 15 Plus) and verifies the same accessibility ID. | IPA file exists at expected path. BrowserStack verification (when enabled): element visible on real iOS device. |
| — | **after** | Shuts down the Android emulator via `adb emu kill`. Logs gracefully if emulator already stopped. | — |

**Key Design Decisions**:
- Test 2 auto-skips if test 1 didn't produce an APK (graceful dependency chain).
- Test 3 has two skip guards: OS check (`darwin` only) and certificate availability.
- BrowserStack verification is conditionally triggered by `RUN_LOCAL=false`, keeping local runs fast.
- `NativeAppPage.verifyAfterActivation()` combines `activateApp()` + `verifyAppLaunched()` in one call.
- All Appium sessions are closed in `finally` blocks regardless of pass/fail.

---

## 5. Spec 4 — Maven Build & Expo Go Verification

**File**: `test/specs/maven-expo.spec.ts`  
**Suite Timeout**: 30 minutes  
**Purpose**: End-to-end pipeline — downloads a WaveMaker project from Studio, builds the backend WAR, generates React Native ZIPs for both DEV and DEPLOYED backends, then verifies each app runs in Expo Go on Android and iOS.

| # | Test Case | Approach | Assertions / Verification |
|---|-----------|----------|--------------------------|
| — | **before** | Loads `WMProjectConfig` from `.env`. Logs all config (project ID, environment, server URLs). Starts Appium server via `AppiumService`. | Appium server running. |
| 1 | **should download and extract WaveMaker project from studio** | Uses `ProjectService.downloadAndExtract()` which: (a) authenticates via `POST /login/authenticate`, (b) exports the project via `POST /studio/.../export` with ZIP options, (c) downloads the ZIP via stream, (d) extracts with `adm-zip`. | Extracted directory exists and contains `pom.xml`. |
| 2 | **should build backend WAR file using mvn clean install** | Uses `MavenService.cleanInstall()` which runs `mvn clean install` and waits for "BUILD SUCCESS". Scans `target/` for a `.war` file (excluding mobile variants). | WAR file exists on disk. Skips if project not downloaded. |
| 3 | **should generate React Native ZIP with DEV server URL (WaveMaker Preview)** | Uses `MavenService.buildRnZip('dev', 'dev')` which: runs `mvn clean package -Dmobile.serverUrl="dev"`, finds the generated ZIP matching `*-native-mobile_*.zip`, renames it with `-dev` suffix. | ZIP file exists with `-dev` suffix. |
| 4 | **should generate React Native ZIP with DEPLOYED server URL** | Same as above but with the deployed server URL and `-deployed` suffix. | ZIP file exists with `-deployed` suffix. |
| 5 | **should extract and prepare DEV React Native project** | Uses `MavenService.extractAndPrepareProject()` to extract the DEV ZIP and run `npm install` in it. | Extracted project directory exists. |
| 6 | **should extract and prepare DEPLOYED React Native project** | Same as above for the DEPLOYED ZIP. | Extracted project directory exists. |
| 7 | **should run and verify DEV app in Expo Go on Android emulator** | Calls `runInExpoGo()` helper: creates Appium session targeting Expo Go, spawns `npm run android`, waits for Metro bundler readiness, waits 15s for app load, uses `ExpoGoAppPage` POM to verify the accessibility ID element. | Element visible within 60s. Screenshot on failure. Skippable via `SKIP_EXPO_GO=true`. |
| 8 | **should run and verify DEPLOYED app in Expo Go on Android emulator** | Same as test 7, but using the DEPLOYED project (connected to the real backend URL). | Element visible. |
| 9 | **should run and verify DEV app in Expo Go on iOS simulator (macOS only)** | Skipped if not macOS. Opens iOS Simulator, waits 10s for boot, then calls `runInExpoGo()` with iOS capabilities (XCUITest, `host.exp.Exponent`). | Element visible. |
| 10 | **should run and verify DEPLOYED app in Expo Go on iOS simulator (macOS only)** | Same as test 9, using the DEPLOYED project. | Element visible. |
| — | **after** | Stops Appium server. Prints summary of all generated artifacts (WAR, DEV ZIP, DEPLOYED ZIP). | — |

**Key Design Decisions**:
- Each test skips gracefully if its prerequisite data is missing (dependency chain without hard coupling).
- The `runInExpoGo()` helper function encapsulates the full Metro + Appium + POM verification flow, reused across 4 tests.
- Metro process is killed in `finally` to prevent port conflicts between consecutive Expo Go tests.
- iOS tests have a longer post-startup wait (20s vs 15s) because simulator boot is slower.
- All tests skippable via `SKIP_EXPO_GO=true` env var for CI environments without emulators.

---

## 6. Failure Handling Strategy

### 6.1 Screenshot on Failure

Every test that interacts with Appium or a browser captures a screenshot on failure before rethrowing:

```typescript
catch (error) {
  if (client) await DriverFactory.takeScreenshot(client, 'descriptive-failure-name');
  throw error;
}
```

Screenshots are saved to `allure-results/` with timestamped filenames.

### 6.2 Graceful Dependency Skipping

Tests that depend on a prior test's output skip gracefully instead of failing:

```typescript
if (!projectPath) {
  log.warn('Skipping: project not downloaded');
  this.skip();
}
```

This prevents a cascade of false failures — only the root cause test is marked as failed.

### 6.3 Resource Cleanup in `finally`

All sessions and processes are cleaned up in `finally` blocks:

- **Appium sessions**: `DriverFactory.closeSession(client)` in `finally`
- **Browser sessions**: Same pattern
- **Metro processes**: `killProcess(metroProcess)` in `finally`
- **Appium server**: Stopped in `after` hook
- **Android emulator**: Shut down in `after` hook via `adb emu kill`

### 6.4 Timeout Configuration

| Scope | Default | Configurable Via |
|-------|---------|-----------------|
| AppChef spec | 30s | Hardcoded (fast test) |
| Preview CLI suite | 20 min | `SYNC_TIMEOUT` env var |
| App build (npm install) | 5 min | `INSTALL_TIMEOUT` env var |
| App build (APK/IPA) | 45 min | `BUILD_TIMEOUT` env var |
| Maven suite | 30 min | Hardcoded (per-test overrides) |
| Expo Go verification | 10 min | Hardcoded per test |

### 6.5 Conditional Execution

| Condition | Tests Affected | Behavior |
|-----------|---------------|----------|
| `os.platform() !== 'darwin'` | iOS tests | Skipped with info log |
| Missing iOS certificates | iOS IPA build | Skipped with info log |
| `SKIP_EXPO_GO=true` | All Expo Go tests | Skipped |
| `RUN_LOCAL=false` | BrowserStack verification | Enabled |

---

## 7. Execution Guide

### Run All Tests
```bash
npm test
```

### Run Individual Specs
```bash
npm run test:appchef     # AppChef version compatibility only
npm run test:preview     # Sync + Web Preview only
npm run test:build       # APK/IPA Build + Emulator only
npm run test:maven       # Maven Build + Expo Go only
```

### Run with Allure Reporting
```bash
npm run test:report      # Runs all tests with allure-mocha reporter
npm run report:generate  # Generates HTML report from results
npm run report:open      # Opens the report in browser
npm run report:upload    # Uploads report to S3
```

### Run via Shell Script (Jenkins / CI)
```bash
./run-cli-tests.sh <branch-name>
```
This script clones/updates the CLI repo, links it locally, runs all specs with Allure, generates the report, and uploads to S3.

---

## Test Case Summary

| Spec File | # Tests | Category |
|-----------|---------|----------|
| `appchef-version.spec.ts` | 1 | Version Compatibility |
| `preview-cli.spec.ts` | 4 | Sync + Expo Go + Web Preview |
| `app-build.spec.ts` | 3 | APK/IPA Build + Device Verification |
| `maven-expo.spec.ts` | 10 | Maven + RN ZIP + Expo Go (Android + iOS) |
| **Total** | **18** | |

---

## Page Objects Used Per Spec

| Page Object | Used In |
|-------------|---------|
| `ExpoGoAppPage` | `preview-cli.spec.ts`, `maven-expo.spec.ts` |
| `WebPreviewPage` | `preview-cli.spec.ts` |
| `NativeAppPage` | `app-build.spec.ts` |

## Services Used Per Spec

| Service | Used In |
|---------|---------|
| `AuthService` | `preview-cli.spec.ts` |
| `ProjectService` | `maven-expo.spec.ts` |
| `MavenService` | `maven-expo.spec.ts` |
| `AppiumService` | `preview-cli.spec.ts`, `maven-expo.spec.ts` |
| `DriverFactory` | All specs with UI verification |
