import { ChildProcess } from 'child_process';
import axios from 'axios';
import { runCommand } from './run-command';
import { killProcess } from './process-utils';
// Allow browser startup/navigation, the three-minute assertion, and cleanup after CLI startup.
export function webPreviewTestTimeout(startupTimeout: number): number {
  return startupTimeout + 6 * 60 * 1000;
}

export async function waitForPreviewHttp(
  url: string, child: ChildProcess, timeout: number, signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeout;
  const safeUrl = new URL(url);
  let lastResponse = 'no response';
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Web preview cancelled');
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('CLI preview exited before its HTTP endpoint became ready');
    }
    try {
      const response = await axios.get(url, {
        timeout: Math.min(3000, Math.max(1, deadline - Date.now())),
        signal, proxy: false, maxRedirects: 0, validateStatus: () => true,
      });
      lastResponse = `HTTP ${response.status}${response.status === 200 ? ' without HTML' : ''}`;
      if (response.status === 200 && typeof response.data === 'string' &&
          /<(?:!doctype html|html|body|div)\b/i.test(response.data)) return;
    } catch (error) {
      if (signal?.aborted) throw new Error('Web preview cancelled');
      lastResponse = axios.isAxiosError(error) ? error.code || 'request failed' : 'request failed';
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(
    `Local web preview did not serve HTML within ${timeout}ms: ${safeUrl.origin}${safeUrl.pathname}; last response: ${lastResponse}`
  );
}

export async function startWebPreview(
  command: string, token: string, timeout: number, signal?: AbortSignal
): Promise<{ url: string; stop: () => void }> {
  let child: ChildProcess | undefined;
  const started = Date.now();
  const stop = () => {
    signal?.removeEventListener('abort', stop);
    if (child) killProcess(child);
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const proxyUrl = await runCommand(command, {
      timeout, keepAlive: true, signal,
      failureRegex: /npm (?:ERR!|error) code E\w+|Encountered an error while installing dependencies|Transpiling project failed/i,
      resolveOnRegex: /Service proxy launched at\s+(https?:\/\/[^\s\x1b]+)(?=\s|\x1b)/i,
      onData: (text, process) => {
        child = process;
        if (/token\s*:/i.test(text.trim())) process.stdin?.write(`${token}\n`);
      },
    });
    const url = process.env.CLI_WEB_PREVIEW_URL || new URL('/rn-bundle/index.html', String(proxyUrl)).href;
    // A startup banner is not readiness. Bound the HTTP phase even if the CLI has budget left.
    await waitForPreviewHttp(url, child!, Math.min(120000, Math.max(1, timeout - (Date.now() - started))), signal);
    return { url, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
