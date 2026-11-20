#!/usr/bin/env npx ts-node
/**
 * Delete the Studio project this build provisioned (CI_PROJECT_ENV_FILE), so every run leaves nothing behind.
 * Only that file's project is ever touched, and only when it belongs to the same environment and account.
 */

import dotenv from 'dotenv';
import { StudioProjectService } from '../src/services/StudioProjectService';
import { readCiProjectEnvFile } from '../src/utils/studio-project-env';
import { applyNewProjectOverrides, getProvisioningContext, sameProvisioningContext } from '../src/utils/new-project-env';
import { provisioningErrorSummary } from './provision-studio-project';

export async function main(
  service: Pick<typeof StudioProjectService, 'deleteProjectFromEnv'> = StudioProjectService,
  env: NodeJS.ProcessEnv = process.env
): Promise<'deleted' | 'skipped'> {
  const saved = env.CI_PROJECT_ENV_FILE ? readCiProjectEnvFile(env.CI_PROJECT_ENV_FILE) : undefined;
  if (!saved?.studioProjectId) {
    console.log('--- No provisioned project recorded for this build — nothing to delete ---');
    return 'skipped';
  }
  applyNewProjectOverrides();
  if (!sameProvisioningContext(saved.context, getProvisioningContext())) {
    console.log('--- Skipping project deletion: environment/account differs from the one that created it ---');
    return 'skipped';
  }
  console.log(`--- Deleting provisioned project ${saved.studioProjectId} ---`);
  await service.deleteProjectFromEnv(saved.studioProjectId);
  return 'deleted';
}

if (require.main === module) {
  dotenv.config();
  // Cleanup must never fail the build, but a leftover project should be visible in the log.
  main().catch((error) => {
    console.warn(`Could not delete the provisioned project (left on Studio): ${provisioningErrorSummary(error)}`);
  });
}
