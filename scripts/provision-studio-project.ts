#!/usr/bin/env npx ts-node
/**
 * Create a fresh NATIVE_MOBILE Studio project when PROJECT_MODE=New Project.
 * Writes .ci-project-env.sh with WM_PROJECT_ID, STUDIO_PROJECT_ID, APP_* — no extra user vars.
 */

import * as path from 'path';
import dotenv from 'dotenv';
import { StudioProjectService } from '../src/services/StudioProjectService';
import { isNewProjectMode, writeCiProjectEnvFile } from '../src/utils/studio-project-env';

dotenv.config();

async function main(): Promise<void> {
  if (!isNewProjectMode()) {
    console.log('--- PROJECT_MODE is not "New Project" — skipping Studio provisioning ---');
    return;
  }

  const outputPath =
    process.env.CI_PROJECT_ENV_FILE ||
    path.resolve(process.cwd(), '.ci-project-env.sh');

  const created = await StudioProjectService.createNewProjectFromEnv();

  writeCiProjectEnvFile(outputPath, created);

  console.log('--- Studio project provisioned ---');
  console.log(`  WM_PROJECT_ID:      ${created.wmProjectId}`);
  console.log(`  STUDIO_PROJECT_ID:  ${created.studioProjectId}`);
  console.log(`  APP_NAME:           ${created.appName}`);
  console.log(`  APP_PACKAGE:        ${created.appPackage}`);
  console.log(`  RN_PROJECT_FOLDER:  ${created.rnProjectFolder}`);
  console.log(`  Env file:           ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
