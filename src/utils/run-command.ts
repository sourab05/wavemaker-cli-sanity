import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { killProcessTree } from './process-utils';

export interface RunCommandOptions {
  timeout: number;
  cwd?: string;
  successMessage?: string;
  resolveOnRegex?: RegExp;
  resolveOnData?: (data: string) => boolean;
  onData?: (text: string, child: ChildProcess) => void;
  keepAlive?: boolean;
  expectedFile?: string;
  expectedFilePollInterval?: number;
}

export type RunCommandResult = { stdout: string; stderr: string } | string;

export function runCommand(
  command: string,
  options: RunCommandOptions
): Promise<RunCommandResult> {
  const {
    timeout,
    cwd,
    successMessage,
    resolveOnRegex,
    resolveOnData,
    onData,
    keepAlive = false,
    expectedFile,
    expectedFilePollInterval = 5000,
  } = options;

  let child: ChildProcess;
  const promise = new Promise<RunCommandResult>((resolve, reject) => {
    const env = { ...process.env, CI: 'false', NO_COLOR: '1' };
    child = spawn(command, {
      shell: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      detached: !keepAlive,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let lastPromptCheck = '';

    const timeoutId = setTimeout(() => {
      settle(
        new Error(
          `Command timed out after ${timeout / 60000} minutes.\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
        )
      );
    }, timeout);

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    };

    const settle = (err: Error | null, result?: RunCommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      err ? reject(err) : resolve(result!);
    };

    const dataHandler = (textChunk: Buffer, isStderr = false) => {
      const text = textChunk.toString();
      process.stdout.write(text);
      
      if (isStderr) {
        stderr += text;
      } else {
        stdout += text;
      }

      // Auto-handle common prompts by checking accumulated stdout AND stderr
      // Only respond once per unique prompt to avoid spam
      const combinedOutput = (stdout + stderr).toLowerCase();
      if ((combinedOutput.includes('would you like to eject the expo project') ||
           combinedOutput.includes('would you like to empty the dest folder')) &&
          !lastPromptCheck.includes('eject_or_empty')) {
        console.log('[runCommand] Auto-responding "yes" to prompt');
        child.stdin?.write('yes\n');
        lastPromptCheck += 'eject_or_empty;';
      }
      if ((combinedOutput.includes('use port 8082 instead?') || 
           combinedOutput.includes('use port 8081 instead?')) &&
          !lastPromptCheck.includes('port')) {
        console.log('[runCommand] Auto-responding "y" to port prompt');
        child.stdin?.write('y\n');
        lastPromptCheck += 'port;';
      }

      if (onData) onData(text, child);

      if (resolveOnData && resolveOnData(text)) {
        settle(null, { stdout, stderr });
        return;
      }

      if (resolveOnRegex) {
        const combinedOutput = stdout + stderr;
        const match = combinedOutput.match(resolveOnRegex);
        if (match && match[1]) {
          settle(null, match[1].trim());
          return;
        }
      }

      if (successMessage && text.toLowerCase().includes(successMessage.toLowerCase())) {
        settle(null, { stdout, stderr });
        return;
      }

      if (text.includes('✖ Transpiling project failed')) {
        settle(
          new Error(
            '❌ Transpiling failed. CLI reported: ✖ Transpiling project failed'
          )
        );
      }
    };

    (child.stdout as NodeJS.ReadableStream)?.on('data', (data: Buffer) => {
      dataHandler(data, false);
    });
    (child.stderr as NodeJS.ReadableStream)?.on('data', (data: Buffer) => {
      dataHandler(data, true);
    });

    child.on('error', (err) =>
      settle(new Error(`Failed to start command: ${err.message}`))
    );

    child.on('close', (code) => {
      if (settled || keepAlive) return;
      if (code !== 0) {
        settle(
          new Error(
            `Command failed with exit code ${code}.\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
          )
        );
      } else {
        // Process exited 0: resolve successfully (avoid hanging if successMessage never appeared)
        settle(null, { stdout, stderr });
      }
    });

    if (expectedFile) {
      intervalId = setInterval(() => {
        try {
          if (fs.existsSync(expectedFile)) {
            settle(null, { stdout, stderr });
          }
        } catch {
          // ignore
        }
      }, expectedFilePollInterval);
    }
  });

  return promise.finally(() => {
    if (!keepAlive && child && child.pid) {
      try {
        killProcessTree(child.pid);
      } catch (e: unknown) {
        const err = e as { code?: string };
        if (err.code !== 'ESRCH') {
          console.error('Failed to kill process:', e);
        }
      }
    }
  });
}
