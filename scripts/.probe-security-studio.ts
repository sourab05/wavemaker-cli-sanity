#!/usr/bin/env npx ts-node
// TEMP — diagnose the Security scan 404 on SECURITY_STUDIO_URL. Never prints credentials.
import axios from 'axios';
import dotenv from 'dotenv';
import { AuthService } from '../src/services/AuthService';

dotenv.config();

const tail = (s?: string) => (s ? '…' + s.slice(-8) : 'MISSING');

async function main() {
  const baseUrl = (process.env.SECURITY_STUDIO_URL || '').trim().replace(/\/$/, '');
  const user = process.env.SECURITY_USERNAME?.trim();
  const pass = process.env.SECURITY_PASSWORD?.trim();
  const projectId = process.env.SECURITY_PROJECT_ID?.trim();
  const studioProjectId = process.env.SECURITY_STUDIO_PROJECT_ID?.trim();
  if (!baseUrl || !user || !pass) throw new Error('Set SECURITY_STUDIO_URL, SECURITY_USERNAME, SECURITY_PASSWORD in .env');

  console.log(`Host: ${new URL(baseUrl).host}`);
  console.log(`Configured SECURITY_PROJECT_ID ${tail(projectId)}  SECURITY_STUDIO_PROJECT_ID ${tail(studioProjectId)}`);

  const cookie = (await new AuthService(baseUrl).login(user, pass)).split('=')[1];
  const headers = {
    Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json',
    Cookie: `auth_cookie=${cookie}`, Origin: baseUrl, Referer: `${baseUrl}/projects/`,
    'x-requested-with': 'XMLHttpRequest',
  };
  const get = (p: string) => axios.get(baseUrl + p, { headers, validateStatus: () => true });

  console.log('\n--- 1. Projects this account can see on this Studio ---');
  const list = await get('/projects/services/manageProjectsListing/projectsListByType?projectType=APPLICATION');
  console.log(`Status ${list.status}`);
  const projects: any[] = Array.isArray(list.data) ? list.data : [];
  for (const p of projects) {
    const hit = p.studioProjectId === projectId || p.projectId === studioProjectId ? '  <== CONFIGURED' : '';
    console.log(`  ${p.name}  WMPRJ ${p.studioProjectId}  proj ${p.projectId}  ${p.platformType}${hit}`);
  }
  if (!projects.length) console.log(JSON.stringify(list.data).slice(0, 300));

  if (projectId) {
    console.log('\n--- 2. Build trigger on the configured project (same call the pipeline makes) ---');
    const r = await axios.post(
      `${baseUrl}/studio/services/projects/${projectId}/native-mobile/build/NATIVE_MOBILE?profileName=development`,
      {}, { headers: { ...headers, Referer: `${baseUrl}/s/page/Main?project-id=${projectId}` }, validateStatus: () => true });
    console.log(`Status ${r.status}  ${JSON.stringify(r.data).slice(0, 400)}`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
