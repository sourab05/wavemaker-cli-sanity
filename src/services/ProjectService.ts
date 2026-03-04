import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { WMProjectConfig } from '../types';
import { extractZip } from '../utils/zip-utils';
import { createLogger } from '../utils/Logger';

const log = createLogger('ProjectService');

export class ProjectService {
  private config: WMProjectConfig;
  private baseUrl: string;
  private fileServiceUrl: string;

  constructor(config: WMProjectConfig) {
    this.config = config;

    if (config.environment === 'stage') {
      this.baseUrl = 'https://stage-studio.wavemakeronline.com';
      this.fileServiceUrl = 'https://stage-studio.wavemakeronline.com/file-service';
    } else {
      this.baseUrl = 'https://www.wavemakeronline.com';
      this.fileServiceUrl = 'https://www.wavemakeronline.com/file-service';
    }
  }

  async login(): Promise<string> {
    const loginUrl = `${this.baseUrl}/login/authenticate`;
    const loginPayload = require('qs').stringify({
      j_username: this.config.username,
      j_password: this.config.password,
    });

    log.info(`Logging in to ${this.config.environment} environment...`);

    const response = await axios.post(loginUrl, loginPayload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
      validateStatus: (status) => status === 302,
    });

    const cookieLine = response.headers['set-cookie']?.find(
      (c: string) => c.startsWith('auth_cookie=')
    );
    if (!cookieLine) {
      throw new Error('auth_cookie not found in login response');
    }

    this.config.authCookie = cookieLine.split(';')[0];
    log.success('Login successful');
    return this.config.authCookie;
  }

  async exportProject(): Promise<string> {
    if (!this.config.authCookie) await this.login();

    const exportUrl = `${this.baseUrl}/studio/services/projects/${this.config.projectId}/export`;
    const cookieValue = this.config.authCookie!.split('=')[1];

    log.info(`Exporting project ${this.config.projectId}...`);

    const data = {
      exportType: 'ZIP',
      targetName: 'test2',
      excludeGeneratedUIApp: true,
    };

    const response = await axios.post(exportUrl, data, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        origin: this.baseUrl,
        referer: `${this.baseUrl}/s/page/Main?project-id=${this.config.projectId}`,
        'x-requested-with': 'XMLHttpRequest',
        Cookie: `auth_cookie=${cookieValue}`,
      },
    });

    let downloadPath: string;
    if (typeof response.data === 'string') {
      downloadPath = response.data.trim().replace(/"/g, '');
    } else if (response.data?.result) {
      downloadPath = response.data.result;
    } else {
      throw new Error('Unexpected response format from export API');
    }

    let downloadUrl: string;
    if (downloadPath.startsWith('http')) {
      downloadUrl = downloadPath;
    } else if (downloadPath.startsWith('/')) {
      downloadUrl = `${this.fileServiceUrl}${downloadPath}`;
    } else {
      downloadUrl = `${this.fileServiceUrl}/${downloadPath}`;
    }

    log.success(`Export successful. Download URL: ${downloadUrl}`);
    return downloadUrl;
  }

  async downloadProject(downloadUrl: string): Promise<string> {
    if (!this.config.authCookie) {
      throw new Error('Not authenticated. Please login first.');
    }

    const cookieValue = this.config.authCookie.split('=')[1];
    const outputPath = path.join(this.config.outputDir, `${this.config.projectId}.zip`);

    if (!fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }

    log.info(`Downloading project to ${outputPath}...`);

    const response = await axios.get(downloadUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: `auth_cookie=${cookieValue}`,
        Referer: `${this.baseUrl}/s/page/Main?project-id=${this.config.projectId}`,
      },
      responseType: 'stream',
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        const fileSize = fs.statSync(outputPath).size;
        log.success(`Download complete. File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
        resolve(outputPath);
      });
      writer.on('error', (err) => {
        log.error(`Download stream error: ${err.message}`);
        reject(err);
      });
    });
  }

  async extractProject(zipPath: string, extractTo?: string): Promise<string> {
    const extractPath = extractTo || path.join(this.config.outputDir, this.config.projectId);
    log.info(`Extracting ${path.basename(zipPath)} to ${extractPath}...`);

    try {
      extractZip(zipPath, extractPath);
      log.success('Extraction complete');
      return extractPath;
    } catch (error: any) {
      log.error(`Extraction failed: ${error.message}`);
      throw error;
    }
  }

  async downloadAndExtract(): Promise<string> {
    log.separator('Project Download & Extract');

    await this.login();
    const downloadUrl = await this.exportProject();
    const zipPath = await this.downloadProject(downloadUrl);
    const extractedPath = await this.extractProject(zipPath);

    log.success(`Project ${this.config.projectId} ready at ${extractedPath}`);
    return extractedPath;
  }
}
