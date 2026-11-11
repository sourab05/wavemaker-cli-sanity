import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface RunIdentity {
  environment: string;
  projectMode: string;
  username: string;
  credentialSource: string;
  projectId: string;
  studioProjectId: string;
  suite?: string;
  environmentSource?: string;
  requestedProjectMode?: string;
  runTarget?: string;
  packageManager?: string;
  requestedPackageManager?: string;
  cliBinary?: string;
  cliBranch?: string;
  cliRepository?: string;
  appName?: string;
  appPackage?: string;
  appVerificationId?: string;
  webPreviewXPath?: string;
  rnBuildProfile?: string;
  releaseVersion?: string;
  buildNumber?: string;
  buildUrl?: string;
}

export function reportUrl(value?: string): string {
  if (!value) return 'unknown';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return 'unknown';
    url.username = url.password = url.search = url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return 'unknown'; }
}

export function getRunIdentity(suite: 'CLI' | 'Security', env: NodeJS.ProcessEnv = process.env): RunIdentity {
  const security = suite === 'Security';
  const newProject = env.PROJECT_MODE === 'New Project';
  const prefix = newProject ? 'NEW_PROJECT' : security ? 'SECURITY_EXISTING' : 'CLI_EXISTING';
  const source = (field: string) => {
    const value = env[`${prefix}_${field}`];
    const overridden = field === 'PASSWORD' ? Boolean(value) : Boolean(value?.trim());
    return overridden ? `${prefix}_${field} override` : newProject ? 'CLI defaults' : `${suite} defaults`;
  };
  return {
    suite,
    environment: reportUrl(security ? env.SECURITY_STUDIO_URL : env.STUDIO_URL || env.STUDIO_BASE_URL),
    environmentSource: env[`${prefix}_STUDIO_URL`]?.trim()
      ? `${prefix}_STUDIO_URL override`
      : newProject ? 'CLI defaults (shared by CLI and Security)' : `${suite} defaults`,
    projectMode: env.PROJECT_MODE || 'Existing Project',
    requestedProjectMode: env.RUN_PROJECT_MODE || env.PROJECT_MODE || 'Existing Project',
    username: (security ? env.SECURITY_USERNAME : env.WM_USERNAME || env.WMO_USER || env.STUDIO_USERNAME) || 'unknown',
    credentialSource: `Username: ${source('USERNAME')}; Password: ${source('PASSWORD')} (value hidden)`,
    projectId: (security ? env.SECURITY_PROJECT_ID : env.PROJECT_ID || env.WM_PROJECT_ID) || 'unknown',
    studioProjectId: (security ? env.SECURITY_STUDIO_PROJECT_ID : env.STUDIO_PROJECT_ID) || 'unknown',
    runTarget: env.RUN_TARGET || 'unknown',
    packageManager: security ? 'npm' : env.PACKAGE_MANAGER || env.PKG_MANAGER || 'npm',
    requestedPackageManager: env.PACKAGE_MANAGER || env.PKG_MANAGER || 'npm',
    cliBinary: (security ? env.SECURITY_CLI_BINARY : env.CLI_BINARY) || 'unknown',
    cliBranch: (security ? env.SECURITY_EFFECTIVE_BRANCH || env.SECURITY_CLI_BRANCH : env.EFFECTIVE_BRANCH || env.CLI_BRANCH) || 'unknown',
    cliRepository: reportUrl(security ? env.SECURITY_CLI_REPO_URL : env.CLI_REPO_URL),
    appName: env.APP_NAME || 'unknown',
    appPackage: env.APP_PACKAGE || 'unknown',
    ...(security ? {} : {
      appVerificationId: env.APP_VERIFICATION_ID || 'unknown',
      webPreviewXPath: env.WEB_PREVIEW_XPATH || 'unknown',
    }),
    rnBuildProfile: env.RN_BUILD_PROFILE || 'development',
    releaseVersion: env.S3_REPORT_VERSION || env.S3_VERSION || 'unknown',
    buildNumber: env.BUILD_NUMBER || 'local',
    buildUrl: reportUrl(env.BUILD_URL),
  };
}
/** Explicit allowlist: never render arbitrary environment variables or credentials. */
export function runConfigurationFields(identity: Partial<RunIdentity>): Record<string, string> {
  const fields: Record<string, string> = {
    'Suite': identity.suite || 'unknown',
    'Project mode': identity.projectMode || 'unknown',
    'Requested project mode': identity.requestedProjectMode || identity.projectMode || 'unknown',
    'Studio URL': reportUrl(identity.environment),
    'Environment source': identity.environmentSource || 'not recorded (legacy report)',
    'Studio username': identity.username || 'unknown',
    'Password': '[hidden]',
    'Credential source': identity.credentialSource || 'not recorded (legacy report)',
    'Project ID': identity.projectId || 'unknown',
    'Studio project ID': identity.studioProjectId || 'unknown',
    'Run target': identity.runTarget || 'unknown',
    'Package manager': identity.packageManager || 'unknown',
    'Requested package manager': identity.requestedPackageManager || identity.packageManager || 'unknown',
    'CLI binary': identity.cliBinary || 'unknown',
    'CLI branch': identity.cliBranch || 'unknown',
    'CLI repository': reportUrl(identity.cliRepository),
    'App name': identity.appName || 'unknown',
    'App package': identity.appPackage || 'unknown',
    'RN build profile': identity.rnBuildProfile || 'unknown',
    'S3 release': identity.releaseVersion || 'unknown',
    'Jenkins build number': identity.buildNumber || 'unknown',
    'Jenkins build URL': reportUrl(identity.buildUrl),
  };
  if (identity.suite === 'CLI') {
    fields['App verification selector'] = identity.appVerificationId || 'unknown';
    fields['Web preview XPath'] = identity.webPreviewXPath || 'unknown';
  }
  return fields;
}

function propertyValue(value: string): string {
  return value.replace(/[\\\r\n\t=:#! ]/g, char => {
    if (char === '\n') return '\\n';
    if (char === '\r') return '\\r';
    if (char === '\t') return '\\t';
    return `\\${char}`;
  }).replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Namespaced keys preserve both suites and both modes in the combined report. */
export function writeRunIdentity(resultsDir: string, suite: 'CLI' | 'Security', identity = getRunIdentity(suite)): void {
  fs.mkdirSync(resultsDir, { recursive: true });
  const mode = identity.projectMode.replace(/[^a-zA-Z0-9]/g, '_');
  const prefix = `${suite}_${mode}_`;
  const target = path.join(resultsDir, 'environment.properties');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').split('\n') : [];
  const properties = existing.filter(line => line && !line.startsWith(prefix));
  for (const [key, value] of Object.entries(identity)) {
    properties.push(`${prefix}${key}=${propertyValue(value)}`);
  }
  fs.writeFileSync(target, properties.join('\n') + '\n');
  fs.writeFileSync(path.join(resultsDir, `run-context-${suite.toLowerCase()}-${mode.toLowerCase()}.json`),
    JSON.stringify(identity, null, 2));
}

export function annotateRunResults(
  resultsDir: string, suite: 'CLI' | 'Security', previousFiles: string[] = [], identity = getRunIdentity(suite)
): void {
  if (!fs.existsSync(resultsDir)) return;
  const previous = new Set(previousFiles);
  const fields = runConfigurationFields({ ...identity, suite });
  for (const name of fs.readdirSync(resultsDir)) {
    if (!name.endsWith('-result.json') || previous.has(name)) continue;
    const file = path.join(resultsDir, name);
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    result.parameters = [
      ...(result.parameters || []).filter((p: { name: string }) => !(p.name in fields)),
      ...Object.entries(fields).map(([name, value]) => ({ name, value })),
    ];
    // Identical test names in Both are separate cases, not retries of the other mode.
    result.historyId = createHash('sha256').update(JSON.stringify([
      result.fullName || result.name, result.parameters.filter((p: { name: string }) =>
        !['Jenkins build number', 'Jenkins build URL', 'S3 release'].includes(p.name)),
    ])).digest('hex');
    fs.writeFileSync(file, JSON.stringify(result));
  }
}
