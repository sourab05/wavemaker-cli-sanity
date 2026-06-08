import { execSync, spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createLogger } from '../utils/Logger';

const log = createLogger('EmulatorService');

function resolveAndroidSdkPath(): string {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
    '/usr/local/share/android-sdk',
  ];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  throw new Error(
    'Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT environment variable.'
  );
}

export class EmulatorService {
  private emulatorProcess: ChildProcess | undefined;
  private avdName: string;
  private sdkPath: string;
  private emulatorBin: string;
  private adbBin: string;

  constructor(avdName?: string) {
    this.avdName = avdName || process.env.ANDROID_EMULATOR_NAME || 'Pixel8';
    this.sdkPath = resolveAndroidSdkPath();
    this.emulatorBin = path.join(this.sdkPath, 'emulator', 'emulator');
    this.adbBin = path.join(this.sdkPath, 'platform-tools', 'adb');

    log.info(`Android SDK: ${this.sdkPath}`);
  }

  /**
   * Returns list of currently connected device/emulator serial numbers.
   */
  getConnectedDevices(): string[] {
    try {
      const output = execSync(`"${this.adbBin}" devices`, { timeout: 10000 }).toString();
      return output
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('List of devices'))
        .filter((line) => line.includes('device') && !line.includes('offline'))
        .map((line) => line.split('\t')[0].trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Checks if any emulator (not physical device) is already running.
   */
  isEmulatorRunning(): boolean {
    return this.getConnectedDevices().some((d) => d.startsWith('emulator-'));
  }

  /**
   * Lists available AVDs on this machine.
   */
  listAvds(): string[] {
    try {
      const output = execSync(`"${this.emulatorBin}" -list-avds`, { timeout: 10000 }).toString();
      return output
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Ensures an Android emulator is running and fully booted.
   * - If an emulator is already connected, reuses it.
   * - Otherwise launches the configured AVD and waits for boot.
   */
  async ensureRunning(timeoutMs = 120000): Promise<string> {
    const existing = this.getConnectedDevices().filter((d) => d.startsWith('emulator-'));
    if (existing.length > 0) {
      log.info(`Emulator already running: ${existing[0]}`);
      return existing[0];
    }

    const avds = this.listAvds();
    if (avds.length === 0) {
      throw new Error(
        'No Android AVDs found. Create one with Android Studio or `avdmanager create avd`.'
      );
    }

    const targetAvd = avds.includes(this.avdName) ? this.avdName : avds[0];
    if (targetAvd !== this.avdName) {
      log.warn(`AVD "${this.avdName}" not found, falling back to "${targetAvd}"`);
    }

    log.info(`Launching emulator: ${targetAvd} ...`);
    this.emulatorProcess = spawn(this.emulatorBin, ['-avd', targetAvd, '-no-snapshot-load'], {
      shell: true,
      detached: true,
      stdio: 'ignore',
    });

    this.emulatorProcess.unref();

    this.emulatorProcess.on('error', (err) => {
      log.error(`Emulator process error: ${err.message}`);
    });

    log.info('Waiting for device to come online...');
    await this.waitForDevice(timeoutMs);

    log.info('Waiting for boot to complete...');
    await this.waitForBoot(timeoutMs);

    const devices = this.getConnectedDevices().filter((d) => d.startsWith('emulator-'));
    if (devices.length === 0) {
      throw new Error('Emulator launched but no emulator device found via adb');
    }

    log.success(`Emulator ready: ${devices[0]}`);
    return devices[0];
  }

  /**
   * Waits for `adb wait-for-device` to return.
   */
  private waitForDevice(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for adb device after ${timeoutMs / 1000}s`)),
        timeoutMs
      );

      try {
        execSync(`"${this.adbBin}" wait-for-device`, { timeout: timeoutMs });
        clearTimeout(timer);
        resolve();
      } catch (err: any) {
        clearTimeout(timer);
        reject(new Error(`adb wait-for-device failed: ${err.message}`));
      }
    });
  }

  /**
   * Polls `sys.boot_completed` property until the emulator is fully booted.
   */
  private waitForBoot(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const pollInterval = 3000;

      const check = () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Emulator did not finish booting within ${timeoutMs / 1000}s`));
          return;
        }

        try {
          const result = execSync(`"${this.adbBin}" shell getprop sys.boot_completed`, { timeout: 10000 })
            .toString()
            .trim();

          if (result === '1') {
            log.success('Emulator boot completed');
            resolve();
            return;
          }
        } catch {
          // device not ready yet
        }

        setTimeout(check, pollInterval);
      };

      check();
    });
  }

  /**
   * Ensures the connected device/emulator has an Expo Go build matching the project SDK.
   * When projectPath is provided, uses `npx expo install:client:android` so Expo Go 54.x
   * is installed instead of a stale 2.x client that blocks `expo start --android`.
   */
  ensureExpoGoInstalled(projectPath?: string): void {
    const EXPO_GO_PKG = 'host.exp.exponent';

    if (projectPath) {
      log.info(`Installing SDK-matched Expo Go for project: ${projectPath}`);
      try {
        execSync('npx expo install:client:android', {
          cwd: projectPath,
          stdio: 'inherit',
          timeout: 180000,
          env: { ...process.env, CI: 'false' },
        });
        log.success('SDK-matched Expo Go installed');
        return;
      } catch (err: any) {
        log.warn(`expo install:client:android failed: ${err.message}. Trying legacy install...`);
      }
    }

    try {
      const output = execSync(`"${this.adbBin}" shell pm list packages ${EXPO_GO_PKG}`, {
        encoding: 'utf8',
        timeout: 10000,
      });
      if (output.includes(EXPO_GO_PKG)) {
        log.info('Expo Go is already installed');
        return;
      }
    } catch {
      // pm list failed or package not found — proceed to install
    }

    log.info('Expo Go not found on device, installing...');
    const tmpApk = path.join(os.tmpdir(), 'expo-go.apk');

    try {
      execSync('npx expo install:client:android', { stdio: 'inherit', timeout: 180000 });
      log.success('Expo Go installed via expo CLI');
      return;
    } catch {
      log.info('expo install:client:android not available, trying direct download...');
    }

    try {
      const apkUrl = 'https://d1ahtucjixef4r.cloudfront.net/Exponent-2.32.13.apk';
      execSync(`curl -L -o "${tmpApk}" "${apkUrl}"`, { stdio: 'inherit', timeout: 120000 });
      execSync(`"${this.adbBin}" install -r "${tmpApk}"`, { stdio: 'inherit', timeout: 60000 });
      log.success('Expo Go installed from APK');
    } catch (err: any) {
      throw new Error(
        `Failed to install Expo Go. Please install it manually on the emulator.\n${err.message}`
      );
    } finally {
      try { fs.unlinkSync(tmpApk); } catch {}
    }
  }

  /**
   * Kills the emulator via adb.
   */
  shutdown(): void {
    log.info('Shutting down emulator...');
    try {
      execSync(`"${this.adbBin}" emu kill`, { timeout: 10000 });
      log.success('Emulator shut down');
    } catch {
      log.warn('Could not shut down emulator (may already be closed)');
    }
    this.emulatorProcess = undefined;
  }
}
