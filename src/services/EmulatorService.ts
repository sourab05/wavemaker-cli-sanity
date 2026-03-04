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
