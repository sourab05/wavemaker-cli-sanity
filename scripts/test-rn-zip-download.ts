/**
 * Integration test: login → trigger Studio RN build → poll jobs → download ZIP → extract.
 *
 * Uses RnProjectManager.prepareProject() — the same trigger+poll+fallback flow
 * app-build.spec.ts uses — instead of only reading job history. A pure history
 * lookup depends on some other build having run in the last 48h (Studio job
 * lifetime); with nothing guaranteed to have triggered one recently, this check
 * would fail with "0 jobs" even when the project and credentials are fine.
 * Triggering here means it's self-sufficient regardless of job history.
 *
 * Run: npx ts-node scripts/test-rn-zip-download.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import dotenv from 'dotenv';
import { RnProjectManager, getFallbackZipDownloadUrl } from '../src/services/RnProjectManager';

dotenv.config();

async function main(): Promise<void> {
  const outputDir = path.join(os.tmpdir(), `rn-zip-download-test-${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('=== RN ZIP download integration test ===');
  console.log(`STUDIO_URL: ${process.env.STUDIO_URL}`);
  console.log(`WM_PROJECT_ID: ${process.env.WM_PROJECT_ID}`);
  console.log(`STUDIO_PROJECT_ID: ${process.env.STUDIO_PROJECT_ID}`);
  console.log(`Output dir: ${outputDir}\n`);

  const manager = RnProjectManager.fromEnv();
  const profileName = process.env.RN_BUILD_PROFILE || 'development';

  // Triggers a build, polls jobs for it, downloads and extracts — falls back to
  // existing job history / RN_ZIP_DOWNLOAD_URL only if the trigger itself fails.
  console.log('--- Triggering Studio RN build, polling, downloading, extracting ---');
  const projectRoot = await manager.prepareProject(outputDir, profileName);

  const packageJson = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packageJson)) {
    throw new Error(`No package.json under ${projectRoot}`);
  }
  console.log(`✅ RN project root: ${projectRoot}`);
  console.log(`✅ package.json found\n`);

  const fallback = getFallbackZipDownloadUrl();
  if (fallback) {
    console.log('--- RN_ZIP_DOWNLOAD_URL fallback configured ---');
    console.log(`   ${fallback}`);
  }

  console.log('\n=== All RN ZIP download steps passed ===');

  fs.rmSync(outputDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('\n❌ RN ZIP download test failed:', error.message);
  process.exit(1);
});
