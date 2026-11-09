import { applyNewProjectOverrides } from '../src/utils/new-project-env';
import { validateProvisionedProjectFile } from '../src/utils/studio-project-env';

/** stdout is a shell transport, captured only while tracing is disabled. */
export function shellExports(): string {
  applyNewProjectOverrides();
  if (process.env.PROJECT_MODE !== 'New Project') return '';
  if (process.argv[2]) {
    validateProvisionedProjectFile(process.argv[2]);
  }
  return ['WM_USERNAME', 'WMO_USER', 'STUDIO_USERNAME', 'WM_PASSWORD', 'WMO_PASS', 'STUDIO_PASSWORD',
    'STUDIO_URL', 'STUDIO_BASE_URL', 'LOGIN_URL', 'RN_ZIP_DOWNLOAD_URL',
    'RN_SKIP_STUDIO_BUILD', 'RN_DOWNLOAD_FROM_STUDIO']
    .filter(key => process.env[key] !== undefined)
    .map(key => `export ${key}='${process.env[key]!.replace(/'/g, "'\\''")}'`).join('\n');
}

if (require.main === module) {
  try { process.stdout.write(shellExports()); } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid New Project configuration');
    process.exitCode = 1;
  }
}
