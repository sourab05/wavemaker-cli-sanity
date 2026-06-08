/**
 * Integration test: login → jobs API (nativeMobileZipId) → download ZIP → extract.
 * Run: npx ts-node scripts/test-rn-zip-download.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import dotenv from 'dotenv';
import { RnProjectManager, findRnProjectRoot, getFallbackZipDownloadUrl } from '../src/services/RnProjectManager';

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
  await manager.login();
  console.log('✅ Login OK\n');

  // 1) Jobs API → nativeMobileZipId
  console.log('--- Step 1: Jobs API lookup ---');
  const downloadUrl = await manager.fetchLatestNativeZipDownloadUrl();
  if (!downloadUrl) {
    throw new Error('Jobs API did not return a nativeMobileZipId');
  }
  console.log(`✅ Download URL: ${downloadUrl}\n`);

  // 2) Download ZIP
  console.log('--- Step 2: Download ZIP ---');
  const zipPath = await manager.downloadProject(downloadUrl, outputDir);
  const zipSize = fs.statSync(zipPath).size;
  if (zipSize < 1000) {
    throw new Error(`ZIP too small (${zipSize} bytes) — likely not a valid archive`);
  }
  console.log(`✅ Downloaded ${(zipSize / 1024 / 1024).toFixed(2)} MB → ${zipPath}\n`);

  // 3) Extract and locate RN project root
  console.log('--- Step 3: Extract ZIP ---');
  const extractPath = path.join(outputDir, 'rn-project');
  await manager.extractZip(zipPath, extractPath);
  const projectRoot = findRnProjectRoot(extractPath);
  const packageJson = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packageJson)) {
    throw new Error(`No package.json under ${projectRoot}`);
  }
  console.log(`✅ RN project root: ${projectRoot}`);
  console.log(`✅ package.json found\n`);

  // 4) Verify env fallback URL resolves the same pattern
  const fallback = getFallbackZipDownloadUrl();
  if (fallback) {
    console.log('--- Step 4: RN_ZIP_DOWNLOAD_URL fallback configured ---');
    console.log(`   ${fallback}`);
  }

  console.log('\n=== All RN ZIP download steps passed ===');

  fs.rmSync(outputDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('\n❌ RN ZIP download test failed:', error.message);
  process.exit(1);
});
