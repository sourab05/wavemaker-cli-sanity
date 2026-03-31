import { execSync, spawn, ChildProcess } from 'child_process';
import * as os from 'os';

/**
 * Kill any process listening on a given TCP port.
 * Silently does nothing if no process is found.
 */
export function killPort(port: number): void {
  try {
    if (os.platform() === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' });
      const pids = new Set(out.trim().split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean));
      pids.forEach(pid => { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {} });
    } else {
      const out = execSync(`lsof -ti:${port}`, { encoding: 'utf8' });
      const pids = out.trim().split('\n').filter(Boolean);
      pids.forEach(pid => { try { process.kill(Number(pid), 'SIGKILL'); } catch {} });
    }
  } catch {
    // No process on that port — nothing to kill
  }
}

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
