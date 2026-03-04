import * as path from 'path';
import * as fs from 'fs';
import AdmZip from 'adm-zip';

/**
 * Cross-platform ZIP extraction. Uses adm-zip (Node.js) instead of system unzip.
 */
export function extractZip(zipPath: string, extractTo: string): string {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`ZIP file not found: ${zipPath}`);
  }

  if (fs.existsSync(extractTo)) {
    fs.rmSync(extractTo, { recursive: true, force: true });
  }

  fs.mkdirSync(extractTo, { recursive: true });

  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractTo, true);
    return extractTo;
  } catch (error: unknown) {
    const err = error as Error;
    throw new Error(`Extraction failed: ${err.message}`);
  }
}
