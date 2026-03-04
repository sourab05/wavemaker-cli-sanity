import { execSync, spawn } from 'child_process';
import * as os from 'os';
import { createLogger } from '../utils/Logger';

const log = createLogger('SimulatorService');

interface SimulatorDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

export class SimulatorService {
  private deviceName: string;
  private runtimeVersion: string;

  constructor(deviceName?: string, runtimeVersion?: string) {
    this.deviceName = deviceName || process.env.IOS_SIMULATOR_DEVICE || 'iPhone 15';
    this.runtimeVersion = runtimeVersion || process.env.IOS_SIMULATOR_RUNTIME || '';
  }

  /**
   * Returns parsed list of all iOS simulators from `xcrun simctl`.
   */
  private getSimulators(): SimulatorDevice[] {
    try {
      const json = execSync('xcrun simctl list devices --json', { timeout: 15000 }).toString();
      const parsed = JSON.parse(json);
      const devices: SimulatorDevice[] = [];

      for (const [runtime, devList] of Object.entries(parsed.devices || {})) {
        for (const dev of devList as any[]) {
          devices.push({
            udid: dev.udid,
            name: dev.name,
            state: dev.state,
            runtime,
          });
        }
      }
      return devices;
    } catch (err: any) {
      log.warn(`Failed to list simulators: ${err.message}`);
      return [];
    }
  }

  /**
   * Finds a booted simulator, or null if none.
   */
  getBootedSimulator(): SimulatorDevice | null {
    return this.getSimulators().find((d) => d.state === 'Booted') || null;
  }

  /**
   * Finds the best matching simulator for the configured device name and runtime.
   */
  private findMatchingDevice(): SimulatorDevice | null {
    const all = this.getSimulators();

    let candidates = all.filter((d) =>
      d.name.toLowerCase() === this.deviceName.toLowerCase()
    );

    if (this.runtimeVersion) {
      const runtimeFiltered = candidates.filter((d) =>
        d.runtime.includes(this.runtimeVersion)
      );
      if (runtimeFiltered.length > 0) candidates = runtimeFiltered;
    }

    if (candidates.length > 0) return candidates[candidates.length - 1];

    log.warn(`Simulator "${this.deviceName}" not found, looking for any available iPhone...`);
    const iPhones = all.filter((d) => d.name.startsWith('iPhone'));
    return iPhones.length > 0 ? iPhones[iPhones.length - 1] : null;
  }

  /**
   * Ensures an iOS simulator is booted and ready.
   * - Reuses an already-booted simulator if one exists.
   * - Otherwise boots the configured device and waits.
   */
  async ensureRunning(timeoutMs = 120000): Promise<string> {
    if (os.platform() !== 'darwin') {
      throw new Error('iOS Simulator is only available on macOS');
    }

    const booted = this.getBootedSimulator();
    if (booted) {
      log.info(`Simulator already booted: ${booted.name} (${booted.udid})`);
      return booted.udid;
    }

    const device = this.findMatchingDevice();
    if (!device) {
      throw new Error(
        `No iOS simulator found matching "${this.deviceName}". ` +
        'Create one in Xcode → Window → Devices and Simulators.'
      );
    }

    log.info(`Booting simulator: ${device.name} (${device.udid})...`);

    try {
      execSync(`xcrun simctl boot "${device.udid}"`, { timeout: 30000 });
    } catch (err: any) {
      if (!err.message?.includes('current state: Booted')) {
        throw new Error(`Failed to boot simulator: ${err.message}`);
      }
    }

    spawn('open', ['-a', 'Simulator'], { detached: true, stdio: 'ignore' }).unref();

    log.info('Waiting for simulator to be ready...');
    await this.waitForBoot(device.udid, timeoutMs);

    log.success(`Simulator ready: ${device.name}`);
    return device.udid;
  }

  /**
   * Polls until the simulator reports booted state.
   */
  private waitForBoot(udid: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const pollInterval = 3000;

      const check = () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Simulator did not boot within ${timeoutMs / 1000}s`));
          return;
        }

        try {
          const output = execSync(
            `xcrun simctl list devices --json`,
            { timeout: 10000 }
          ).toString();
          const parsed = JSON.parse(output);

          for (const devList of Object.values(parsed.devices || {})) {
            for (const dev of devList as any[]) {
              if (dev.udid === udid && dev.state === 'Booted') {
                log.success('Simulator boot completed');
                resolve();
                return;
              }
            }
          }
        } catch {
          // not ready yet
        }

        setTimeout(check, pollInterval);
      };

      check();
    });
  }

  /**
   * Shuts down the simulator.
   */
  shutdown(udid?: string): void {
    log.info('Shutting down iOS simulator...');
    try {
      const target = udid || this.getBootedSimulator()?.udid;
      if (target) {
        execSync(`xcrun simctl shutdown "${target}"`, { timeout: 15000 });
        log.success('Simulator shut down');
      } else {
        log.info('No booted simulator to shut down');
      }
    } catch {
      log.warn('Could not shut down simulator (may already be closed)');
    }
  }
}
