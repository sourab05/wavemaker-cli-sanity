import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';

export function killProcess(child: ChildProcess): void {
  if (child.pid) {
    try {
      if (os.platform() === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code !== 'ESRCH') {
        console.error('Failed to kill process:', e);
      }
    }
  }
}

export function killProcessTree(pid: number): void {
  try {
    if (os.platform() === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code !== 'ESRCH') {
      console.error(`Failed to kill process tree for PID ${pid}:`, e);
    }
  }
}
