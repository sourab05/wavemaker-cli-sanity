import * as fs from 'fs';
import * as path from 'path';

const sourcePath = path.resolve(__dirname, '../../scripts/security-results.js');
const results = require(fs.existsSync(sourcePath)
  ? sourcePath : path.resolve(__dirname, '../../../scripts/security-results.js'));

export type ScanStatus = 'clean' | 'findings' | 'failed' | 'skipped';
export interface ScanResult {
  status: ScanStatus;
  reason?: string;
  counts: { critical: number; high: number; moderate: number; low: number; total: number } | null;
  findings: Array<{
    name: string; version: string; title: string; severity: string; url: string;
    fix?: boolean | object; fixedIn?: string;
  }>;
}

export function readSecurityResult(tool: 'audit' | 'snyk', text: string): ScanResult {
  return results.readResult(tool, text);
}
