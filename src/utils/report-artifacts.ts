import * as fs from 'fs';
import * as path from 'path';

/** Jenkins publishing is allowed only after this build cleared previous artifacts. */
export function canPublishReports(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isJenkinsBuild(env)) return true;
  return Boolean(env.BUILD_TAG && env.REPORT_RUN_ID === env.BUILD_TAG);
}
export function isJenkinsBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  // JENKINS_URL can also be configured locally for API access.
  return Boolean(env.BUILD_TAG || (env.JOB_NAME && env.BUILD_NUMBER));
}

/** Environment/attachment files alone are not evidence that any tests ran. */
export function hasAllureResults(resultsDir: string): boolean {
  if (!fs.existsSync(resultsDir)) return false;
  return fs.readdirSync(resultsDir).some((name) => {
    if (!name.endsWith('-result.json')) return false;
    try {
      const result = JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8'));
      return typeof result.uuid === 'string' && Boolean(result.uuid) &&
        typeof result.name === 'string' && Boolean(result.name) &&
        ['passed', 'failed', 'broken', 'skipped', 'unknown'].includes(result.status);
    } catch {
      return false;
    }
  });
}
