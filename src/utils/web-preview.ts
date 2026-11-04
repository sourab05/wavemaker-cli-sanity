import { ChildProcess } from 'child_process';
import axios from 'axios';
import { runCommand } from './run-command';
import { killProcess } from './process-utils';

export async function waitForPreviewHttp(
  url: string, child: ChildProcess, timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('CLI preview exited before its HTTP endpoint became ready');
    }
    try {
      const response = await axios.get(url, {
        timeout: Math.min(3000, Math.max(1, deadline - Date.now())),
        proxy: false, validateStatus: () => true,
      });
      if (response.status === 200 && typeof response.data === 'string' &&
          /<(?:!doctype html|html|body|div)\b/i.test(response.data)) return;
    } catch { /* Server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Local web preview did not serve HTML within ${timeout}ms: ${url}`);
}

export async function startWebPreview(
  command: string, token: string, timeout: number
): Promise<{ url: string; stop: () => void }> {
  let child: ChildProcess | undefined;
  const started = Date.now();
  try {
    const proxyUrl = await runCommand(command, {
      timeout, keepAlive: true,
      failureRegex: /npm (?:ERR!|error) code E\w+|Encountered an error while installing dependencies|Transpiling project failed/i,
      resolveOnRegex: /Service proxy launched at\s+(https?:\/\/[^\s\x1b]+)(?=\s|\x1b)/i,
      onData: (text, process) => {
        child = process;
        if (/token\s*:/i.test(text.trim())) process.stdin?.write(`${token}\n`);
      },
    });
    const url = process.env.CLI_WEB_PREVIEW_URL || new URL('/rn-bundle/index.html', String(proxyUrl)).href;
    await waitForPreviewHttp(url, child!, Math.max(1, timeout - (Date.now() - started)));
    return { url, stop: () => { if (child) killProcess(child); } };
  } catch (error) {
    if (child) killProcess(child);
    throw error;
  }
}
