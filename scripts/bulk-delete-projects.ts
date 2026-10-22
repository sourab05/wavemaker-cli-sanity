#!/usr/bin/env npx ts-node
// One-off: delete automation-created (CliAutom*) Studio projects left over from before
// the cleanup fix. Run with: npx ts-node scripts/bulk-delete-projects.ts
// One login reused for all deletes (stage is flaky — avoid hammering it with re-logins),
// 3s spacing between calls, retries each up to 3x on 502/503/504.
// Delete this file after use — it's not part of the pipeline.
import dotenv from 'dotenv';
import { AuthService } from '../src/services/AuthService';
import { StudioProjectService } from '../src/services/StudioProjectService';

dotenv.config();

// Remaining 13 after the first run (CliAutomv7diq39kzde and CliAutomv89xj4w6z1e already deleted).
const targets = [
  { name: 'CliAutomv5y3scdtpi5', id: 'proj-ec11d78b-e46f-464a-b427-837e9f2a68c2' },
  { name: 'CliAutomv08bk92wddb', id: 'proj-0cbcaee3-65ca-436d-82ca-52171c4e4fac' },
  { name: 'CliAutomuxdfrdw85ft', id: 'proj-583efd5a-ab13-47f2-b899-5aad67b447a5' },
  { name: 'CliAutomuvxzzaxx4u5', id: 'proj-99a42769-2068-4434-a3cf-5f06f46b10b0' },
  { name: 'CliAutomuuik0cc1gre', id: 'proj-4699e5d5-e142-4d70-b5cc-beb294b91a3d' },
  { name: 'CliAutomuossk6sngnd', id: 'proj-b469b64e-4dcc-4f5a-95ba-13735ddc1dae' },
  { name: 'CliAutomunz7t00mlvw', id: 'proj-2f6abb4d-d9ca-41b1-9787-7703d11d2b10' },
  { name: 'CliAutomunz5m17675a', id: 'proj-3c3886be-f466-4694-af32-e06fc591ae5f' },
  { name: 'CliAutomuny3bsmsyur', id: 'proj-aa0126c7-2967-4e31-8208-8e91fa816706' },
  { name: 'CliAutoms4e5f8uijcw', id: 'proj-85f6e96e-4227-4e2b-849e-1923d8eedf51' },
  { name: 'CliAutoms4b0zkpan7i', id: 'proj-31ca09df-c4b6-469a-a285-5e3d9b0fbb35' },
  { name: 'CliAutomrkhar7k92vx', id: 'proj-cd1f33bb-23c6-411b-aaf7-b64900529810' },
  { name: 'CliAutomrkasxkssetz', id: 'proj-3dc736a0-079d-48e4-86cf-53d0171d9008' },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(message: string): boolean {
  return /502|503|504/.test(message);
}

async function main() {
  const baseUrl = (process.env.STUDIO_BASE_URL || process.env.STUDIO_URL || '').replace(/\/$/, '');
  const username = process.env.STUDIO_USERNAME || process.env.WM_USERNAME || process.env.WMO_USER;
  const password = process.env.STUDIO_PASSWORD || process.env.WM_PASSWORD || process.env.WMO_PASS;
  if (!baseUrl || !username || !password) {
    console.error('Missing STUDIO_BASE_URL/STUDIO_URL or credentials');
    process.exit(1);
  }

  const auth = new AuthService(baseUrl);
  const authCookie = await auth.login(username, password);
  const service = new StudioProjectService(baseUrl, authCookie);

  let ok = 0, failed = 0;
  for (const t of targets) {
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await service.deleteProject(t.id);
        console.log(`OK    ${t.name} (${t.id})`);
        ok++;
        lastError = '';
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < 3 && isRetryable(lastError)) {
          console.log(`RETRY ${t.name} (attempt ${attempt}/3) — ${lastError}`);
          await sleep(5000);
          continue;
        }
        break;
      }
    }
    if (lastError) {
      console.log(`FAIL  ${t.name} (${t.id}) — ${lastError}`);
      failed++;
    }
    await sleep(3000); // space out calls, stage is flaky under rapid requests
  }
  console.log(`\nDone: ${ok} deleted, ${failed} failed`);
}

main();
