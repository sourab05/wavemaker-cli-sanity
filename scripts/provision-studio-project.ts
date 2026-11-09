#!/usr/bin/env npx ts-node
/**
 * Create a fresh NATIVE_MOBILE Studio project when PROJECT_MODE=New Project.
 * Writes .ci-project-env.sh with WM_PROJECT_ID, STUDIO_PROJECT_ID, APP_* — no extra user vars.
 */

import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';
import { StudioProjectService } from '../src/services/StudioProjectService';
import {
  isNewProjectMode,
  readCiProjectEnvFile,
  writeCiProjectEnvFile,
} from '../src/utils/studio-project-env';
import { applyNewProjectOverrides, getProvisioningContext, sameProvisioningContext } from '../src/utils/new-project-env';

export async function main(
  service: Pick<typeof StudioProjectService, 'createNewProjectFromEnv' | 'deleteProjectFromEnv'> = StudioProjectService
): Promise<void> {
  if (!isNewProjectMode()) {
    console.log('--- PROJECT_MODE is not "New Project" — skipping Studio provisioning ---');
    return;
  }

  const outputPath =
    process.env.CI_PROJECT_ENV_FILE ||
    path.resolve(process.cwd(), '.ci-project-env.sh');

  const previous = readCiProjectEnvFile(outputPath);
  // Invalidate previous IDs even if configuration/login/create fails below.
  fs.rmSync(outputPath, { force: true });
  applyNewProjectOverrides();
  const context = getProvisioningContext();
  if (previous?.studioProjectId && sameProvisioningContext(previous.context, context)) {
    console.log(`--- Deleting previously provisioned project ${previous.studioProjectId} ---`);
    try {
      await service.deleteProjectFromEnv(previous.studioProjectId);
    } catch (error) {
      console.warn('--- Could not delete previous project (continuing) ---');
    }
  } else if (previous?.studioProjectId) {
    console.log('--- Skipping previous project cleanup: environment/account context differs or is unknown ---');
  }

  const created = await service.createNewProjectFromEnv();

  writeCiProjectEnvFile(outputPath, created, context);

  console.log('--- Studio project provisioned ---');
  console.log(`  WM_PROJECT_ID:      ${created.wmProjectId}`);
  console.log(`  STUDIO_PROJECT_ID:  ${created.studioProjectId}`);
  console.log(`  APP_NAME:           ${created.appName}`);
  console.log(`  APP_PACKAGE:        ${created.appPackage}`);
  console.log(`  RN_PROJECT_FOLDER:  ${created.rnProjectFolder}`);
  console.log(`  Env file:           ${outputPath}`);
}

export function provisioningErrorSummary(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let message = error instanceof Error ? error.message : 'Unknown provisioning error';
  const secrets = Object.entries(env)
    .filter(([key, value]) => value && /password|pass$|token|secret|cookie|access_key|username|wmo_user/i.test(key))
    .map(([, value]) => value!).sort((a, b) => b.length - a.length);
  for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
  return message.replace(/([?&](?:token|auth|auth_cookie|access_token)=)[^\s&"']+/gi, '$1[REDACTED]')
    .replace(/(auth_cookie=)[^;\s"']+/gi, '$1[REDACTED]').slice(0, 1500);
}

if (require.main === module) {
  dotenv.config();
  main().catch((error) => {
    console.error(`Studio provisioning failed; no reusable project file was written. ${provisioningErrorSummary(error)}`);
    process.exitCode = 1;
  });
}
