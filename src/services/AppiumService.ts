import { spawn, ChildProcess, execSync } from 'child_process';
import * as http from 'http';
import { createLogger } from '../utils/Logger';
import { killProcess } from '../utils/process-utils';

const log = createLogger('AppiumService');

const APPIUM_PORT = 4723;
const HEALTH_URL = `http://127.0.0.1:${APPIUM_PORT}/status`;

function isPortInUse(): number | null {
  try {
    const out = execSync(`lsof -ti tcp:${APPIUM_PORT} 2>/dev/null`, {
      encoding: 'utf-8',
    }).trim();
    return out ? Number(out.split('\n')[0]) : null;
  } catch {
    return null;
  }
}

function httpGet(url: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export class AppiumService {
  private process: ChildProcess | undefined;
  private maxStartupMs: number;

  constructor(maxStartupMs = 30000) {
    this.maxStartupMs = maxStartupMs;
  }

  async start(): Promise<void> {
    if (this.process) {
      log.warn('Appium server is already running');
      return;
    }

    const stalePid = isPortInUse();
    if (stalePid) {
      log.warn(`Port ${APPIUM_PORT} occupied by PID ${stalePid}, killing it`);
      try {
        process.kill(stalePid, 'SIGKILL');
        await new Promise((r) => setTimeout(r, 1000));
      } catch { /* already gone */ }
    }

    log.info('Starting Appium server...');
    let earlyExit = false;

    this.process = spawn('appium', ['--port', String(APPIUM_PORT)], {
      shell: true,
      detached: true,
    });

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
      earlyExit = true;
    });

    this.process.on('exit', (code) => {
      log.info(`Appium server exited with code ${code}`);
      earlyExit = true;
      this.process = undefined;
    });

    const deadline = Date.now() + this.maxStartupMs;
    while (Date.now() < deadline) {
      if (earlyExit) {
        throw new Error(
          `Appium process exited before it became ready. Check if another instance is running or if appium is installed.`
        );
      }
      const healthy = await httpGet(HEALTH_URL);
      if (healthy) {
        log.success(`Appium server ready on port ${APPIUM_PORT}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    this.stop();
    throw new Error(
      `Appium server did not become ready within ${this.maxStartupMs / 1000}s`
    );
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
