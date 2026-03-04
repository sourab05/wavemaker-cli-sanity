import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import { createLogger } from '../utils/Logger';
import { killProcess } from '../utils/process-utils';

const log = createLogger('AppiumService');

export class AppiumService {
  private process: ChildProcess | undefined;
  private startupDelayMs: number;

  constructor(startupDelayMs = 5000) {
    this.startupDelayMs = startupDelayMs;
  }

  async start(): Promise<void> {
    if (this.process) {
      log.warn('Appium server is already running');
      return;
    }

    log.info('Starting Appium server...');
    this.process = spawn('appium', { shell: true, detached: true });

    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) log.debug(`[stdout] ${text}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) log.debug(`[stderr] ${text}`);
    });

    this.process.on('error', (err) => {
      log.error(`Appium process error: ${err.message}`);
    });

    this.process.on('exit', (code) => {
      log.info(`Appium server exited with code ${code}`);
      this.process = undefined;
    });

    await new Promise((resolve) => setTimeout(resolve, this.startupDelayMs));
    log.success('Appium server started');
  }

  stop(): void {
    if (!this.process) {
      log.info('No Appium server process to stop');
      return;
    }

    log.info('Stopping Appium server...');
    try {
      if (this.process.pid) {
        killProcess(this.process);
      }
      log.success('Appium server stopped');
    } catch (err: any) {
      log.warn(`Failed to stop Appium server: ${err.message}`);
    } finally {
      this.process = undefined;
    }
  }

  isRunning(): boolean {
    return this.process !== undefined && !this.process.killed;
  }
}
