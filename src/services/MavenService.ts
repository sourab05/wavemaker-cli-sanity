import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { MavenBuildResult } from '../types';
import { runCommand } from '../utils/run-command';
import { extractZip } from '../utils/zip-utils';
import { createLogger } from '../utils/Logger';

const log = createLogger('MavenService');

export class MavenService {
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  async cleanInstall(): Promise<MavenBuildResult> {
    log.info('Running: mvn clean install');
    log.info(`Working directory: ${this.projectPath}`);

    try {
      const result = await runCommand('mvn clean install', {
        cwd: this.projectPath,
        timeout: 15 * 60 * 1000,
        successMessage: 'BUILD SUCCESS',
      });

      const warPath = this.findArtifact('.war', (f) => !f.includes('mobile'));
      if (!warPath) {
        throw new Error('WAR file not found in target directory after successful build');
      }

      const fileSize = fs.statSync(warPath).size;
      log.success(`Backend WAR generated: ${path.basename(warPath)} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

      const out = typeof result === 'object' ? result : { stdout: '', stderr: '' };
      return { ...out, artifactPath: warPath };
    } catch (error: any) {
      log.error(`Maven clean install failed: ${error.message}`);
      throw error;
    }
  }

  async cleanPackageForMobile(serverUrl: string): Promise<MavenBuildResult> {
    const command = `mvn clean package -Dmobile.serverUrl="${serverUrl}"`;
    log.info(`Running: ${command}`);
    log.info(`Working directory: ${this.projectPath}`);

    try {
      const result = await runCommand(command, {
        cwd: this.projectPath,
        timeout: 20 * 60 * 1000,
        successMessage: 'BUILD SUCCESS',
      });

      const zipPath = this.findArtifact('.zip', (f) => f.includes('-native-mobile_'));
      if (!zipPath) {
        throw new Error('React Native ZIP not found in target directory after build');
      }

      const fileSize = fs.statSync(zipPath).size;
      log.success(`RN ZIP generated: ${path.basename(zipPath)} (${(fileSize / 1024 / 1024).toFixed(2)} MB) | serverUrl=${serverUrl}`);

      const out = typeof result === 'object' ? result : { stdout: '', stderr: '' };
      return { ...out, artifactPath: zipPath };
    } catch (error: any) {
      log.error(`Maven clean package failed: ${error.message}`);
      throw error;
    }
  }

  async buildRnZip(serverUrl: string, suffix: string): Promise<string> {
    const result = await this.cleanPackageForMobile(serverUrl);
    if (!result.artifactPath) {
      throw new Error('React Native ZIP path not returned from build');
    }

    const newPath = result.artifactPath.replace('.zip', `-${suffix}.zip`);
    fs.renameSync(result.artifactPath, newPath);

    if (!fs.existsSync(newPath)) {
      throw new Error(`ZIP not found at expected path: ${newPath}`);
    }

    log.success(`RN ZIP renamed to: ${path.basename(newPath)}`);
    return newPath;
  }

  static extractAndPrepareProject(
    zipPath: string,
    outputDir: string,
    folderName: string
  ): string {
    const extractPath = path.join(outputDir, folderName);
    const extractLog = createLogger('MavenService');

    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }

    extractLog.info(`Extracting RN project to ${extractPath}...`);
    extractZip(zipPath, extractPath);

    extractLog.info('Running npm install in extracted project...');
    execSync('npm install', { cwd: extractPath, stdio: 'inherit' });

    extractLog.success(`RN project prepared at ${extractPath}`);
    return extractPath;
  }

  private findArtifact(extension: string, filter?: (filename: string) => boolean): string | undefined {
    const targetDir = path.join(this.projectPath, 'target');

    if (!fs.existsSync(targetDir)) {
      throw new Error('Target directory not found after build');
    }

    const files = fs.readdirSync(targetDir);
    const match = files.find(
      (f) => f.endsWith(extension) && (!filter || filter(f))
    );

    return match ? path.join(targetDir, match) : undefined;
  }
}
