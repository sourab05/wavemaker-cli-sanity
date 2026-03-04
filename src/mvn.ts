import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import axios from 'axios';
import qs from 'qs';
import dotenv from 'dotenv';
dotenv.config();

interface WMProjectConfig {
  projectId: string;
  username: string;
  password: string;
  environment: 'stage' | 'prod';
  outputDir: string;
  authCookie?: string;
}

interface MavenBuildResult {
  stdout: string;
  stderr: string;
  artifactPath?: string;
}

interface RunCommandOptions {
  timeout: number;
  cwd?: string;
  successMessage?: string;
  onData?: (text: string, child: ChildProcess) => void;
}

class WaveMakerProjectManager {
  private config: WMProjectConfig;
  private baseUrl: string;
  private fileServiceUrl: string;

  constructor(config: WMProjectConfig) {
    this.config = config;
    
    // Set URLs based on environment
    if (config.environment === 'stage') {
      this.baseUrl = 'https://stage-studio.wavemakeronline.com';
      this.fileServiceUrl = 'https://stage.wavemakeronline.com/file-service';
    } else {
      this.baseUrl = 'https://www.wavemakeronline.com';
      this.fileServiceUrl = 'https://www.wavemakeronline.com/file-service';
    }
  }

  /**
   * Login to WaveMaker and get authentication cookie
   */
  async login(): Promise<string> {
    const loginUrl = `${this.baseUrl}/login/authenticate`;
    const loginPayload = qs.stringify({
      j_username: this.config.username,
      j_password: this.config.password
    });

    console.log(`[WM] Logging in to ${this.config.environment} environment...`);
    
    try {
      const response = await axios.post(loginUrl, loginPayload, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        maxRedirects: 0,
        validateStatus: (status) => status === 302
      });

      const cookieLine = response.headers['set-cookie']?.find((c: string) => c.startsWith('auth_cookie='));
      if (!cookieLine) {
        throw new Error('auth_cookie not found in login response');
      }

      const authCookie = cookieLine.split(';')[0];
      this.config.authCookie = authCookie;
      console.log('✅ Login successful');
      return authCookie;
    } catch (error: any) {
      console.error('❌ Login failed:', error.message);
      throw error;
    }
  }

  /**
   * Export project and get download URL
   */
  async exportProject(): Promise<string> {
    if (!this.config.authCookie) {
      await this.login();
    }

    const exportUrl = `${this.baseUrl}/studio/services/projects/${this.config.projectId}/export`;
    const cookieValue = this.config.authCookie!.split('=')[1];

    console.log(`[WM] Exporting project ${this.config.projectId}...`);

    try {
      const response = await axios.get(exportUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Cookie': `auth_cookie=${cookieValue}`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });

      let downloadPath: string;
      
      // Handle different response formats
      if (typeof response.data === 'string') {
        downloadPath = response.data.trim().replace(/"/g, '');
      } else if (response.data && response.data.result) {
        downloadPath = response.data.result;
      } else {
        throw new Error('Unexpected response format from export API');
      }

      // Construct full download URL
      let downloadUrl: string;
      if (downloadPath.startsWith('http')) {
        downloadUrl = downloadPath;
      } else if (downloadPath.startsWith('/')) {
        downloadUrl = `${this.fileServiceUrl}${downloadPath}`;
      } else {
        downloadUrl = `${this.fileServiceUrl}/${downloadPath}`;
      }

      console.log('✅ Export successful. Download URL:', downloadUrl);
      return downloadUrl;
    } catch (error: any) {
      console.error('❌ Export failed:', error.message);
      throw error;
    }
  }

  /**
   * Download project ZIP file
   */
  async downloadProject(downloadUrl: string): Promise<string> {
    if (!this.config.authCookie) {
      throw new Error('Not authenticated. Please login first.');
    }

    const cookieValue = this.config.authCookie.split('=')[1];
    const outputPath = path.join(this.config.outputDir, `${this.config.projectId}.zip`);

    // Ensure output directory exists
    if (!fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }

    console.log(`[WM] Downloading project to ${outputPath}...`);

    try {
      const response = await axios.get(downloadUrl, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cookie': `auth_cookie=${cookieValue}`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Referer': `${this.baseUrl}/s/page/Main?project-id=${this.config.projectId}`
        },
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          const fileSize = fs.statSync(outputPath).size;
          console.log(`✅ Download complete. File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
          resolve(outputPath);
        });
        writer.on('error', reject);
      });
    } catch (error: any) {
      console.error('❌ Download failed:', error.message);
      throw error;
    }
  }

  /**
   * Extract ZIP file
   */
  async extractZip(zipPath: string, extractTo?: string): Promise<string> {
    const extractPath = extractTo || path.join(
      this.config.outputDir, 
      this.config.projectId
    );

    console.log(`[WM] Extracting ${zipPath} to ${extractPath}...`);

    // Clean up existing directory if it exists
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }

    try {
      // Use unzip command (cross-platform with proper tools installed)
      execSync(`unzip -q "${zipPath}" -d "${extractPath}"`);
      console.log('✅ Extraction complete');
      return extractPath;
    } catch (error: any) {
      console.error('❌ Extraction failed:', error.message);
      throw error;
    }
  }

  /**
   * Complete workflow to download and extract a project
   */
  async downloadAndExtractProject(): Promise<string> {
    try {
      // Step 1: Login
      await this.login();

      // Step 2: Export project to get download URL
      const downloadUrl = await this.exportProject();

      // Step 3: Download the ZIP file
      const zipPath = await this.downloadProject(downloadUrl);

      // Step 4: Extract the ZIP file
      const extractedPath = await this.extractZip(zipPath);

      console.log(`\n✅ Project ${this.config.projectId} downloaded and extracted successfully`);
      return extractedPath;
    } catch (error) {
      console.error(`\n❌ Failed to download project ${this.config.projectId}`);
      throw error;
    }
  }
}

class MavenRunner {
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Run mvn clean install command
   * This builds the backend WAR file and installs it to local Maven repository
   * @returns Build result with WAR file path if successful
   */
  async cleanInstall(): Promise<MavenBuildResult> {
    const command = 'mvn clean install';
    console.log('\n[Maven] Running: mvn clean install');
    console.log(`[Maven] Working directory: ${this.projectPath}`);
    console.log('[Maven] This will generate the backend WAR file...');
    
    try {
      const result = await runCommand(command, {
        cwd: this.projectPath,
        timeout: 15 * 60 * 1000, // 15 minutes
        successMessage: 'BUILD SUCCESS'
      });
      
      // Verify WAR file generation
      const targetDir = path.join(this.projectPath, 'target');
      let warPath: string | undefined;
      
      if (fs.existsSync(targetDir)) {
        const files = fs.readdirSync(targetDir);
        const warFile = files.find(f => f.endsWith('.war') && !f.includes('mobile'));
        
        if (warFile) {
          warPath = path.join(targetDir, warFile);
          const fileSize = fs.statSync(warPath).size;
          console.log(`\n✅ Backend WAR file generated successfully:`);
          console.log(`   File: ${warFile}`);
          console.log(`   Path: ${warPath}`);
          console.log(`   Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
        } else {
          throw new Error('WAR file not found in target directory after successful build');
        }
      } else {
        throw new Error('Target directory not found after build');
      }
      
      console.log('✅ Maven clean install completed successfully\n');
      return { ...result, artifactPath: warPath };
      
    } catch (error: any) {
      console.error('❌ Maven clean install failed:', error.message);
      throw error;
    }
  }

  /**
   * Run mvn clean package with mobile server URL
   * This generates the React Native zip with specified backend URL
   * @param serverUrl - The backend server URL for mobile app to connect to:
   *                    - Use actual URL like "https://myapp.example.com" for custom backend
   *                    - Use "dev" for WaveMaker preview URL
   *                    - Use "none" for offline apps with no backend
   * @returns Build result with React Native ZIP path if successful
   */
  async cleanPackageForMobile(serverUrl: string): Promise<MavenBuildResult> {
    const command = `mvn clean package -Dmobile.serverUrl="${serverUrl}"`;
    console.log(`\n[Maven] Running: mvn clean package -Dmobile.serverUrl="${serverUrl}"`);
    console.log(`[Maven] Working directory: ${this.projectPath}`);
    console.log('[Maven] This will generate the React Native ZIP file...');
    
    try {
      const result = await runCommand(command, {
        cwd: this.projectPath,
        timeout: 20 * 60 * 1000, // 20 minutes for React Native build
        successMessage: 'BUILD SUCCESS'
      });
      
      // Verify React Native ZIP generation
      const targetDir = path.join(this.projectPath, 'target');
      let zipPath: string | undefined;
      
      if (fs.existsSync(targetDir)) {
        const files = fs.readdirSync(targetDir);
        // Look for pattern: <ProjectName>-native-mobile_<version>.zip
        const rnZip = files.find(f => f.includes('-native-mobile_') && f.endsWith('.zip'));
        
        if (rnZip) {
          zipPath = path.join(targetDir, rnZip);
          const fileSize = fs.statSync(zipPath).size;
          console.log(`\n✅ React Native ZIP generated successfully:`);
          console.log(`   File: ${rnZip}`);
          console.log(`   Path: ${zipPath}`);
          console.log(`   Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
          console.log(`   Server URL: ${serverUrl}`);
        } else {
          throw new Error('React Native ZIP file not found in target directory after successful build');
        }
      } else {
        throw new Error('Target directory not found after build');
      }
      
      console.log('✅ Maven clean package completed successfully\n');
      return { ...result, artifactPath: zipPath };
      
    } catch (error: any) {
      console.error('❌ Maven clean package failed:', error.message);
      throw error;
    }
  }
}

/**
 * Helper function to run shell commands
 */
function runCommand(
  command: string,
  options: RunCommandOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { timeout, cwd, successMessage, onData } = options;
    const env = { ...process.env, CI: 'false', NO_COLOR: '1' };
    
    const child = spawn(command, {
      shell: true,
      env,
      cwd,
      detached: true,
      stdio: 'pipe'
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        killProcess(child);
        reject(new Error(`Command timed out after ${timeout / 60000} minutes`));
      }
    }, timeout);

    const cleanup = () => {
      clearTimeout(timeoutId);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    };

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
      
      if (onData) onData(text, child);
      
      if (successMessage && text.includes(successMessage)) {
        if (!settled) {
          settled = true;
          cleanup();
          resolve({ stdout, stderr });
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        cleanup();
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Command failed with exit code ${code}`));
        }
      }
    });
  });
}

/**
 * Kill a process and its children
 */
function killProcess(child: ChildProcess): void {
  if (child.pid) {
    try {
      if (os.platform() === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch (e: any) {
      if (e.code !== 'ESRCH') {
        console.error('Failed to kill process:', e);
      }
    }
  }
}

// Test suite for WaveMaker project download and Maven automation
describe('WaveMaker Project Download and Maven Build', function() {
  this.timeout(30 * 60 * 1000); // 30 minutes timeout for the entire suite
  
  let projectPath: string;
  let warFilePath: string;
  let rnZipPath: string;
  
  const wmConfig: WMProjectConfig = {
    projectId: process.env.WM_PROJECT_ID || 'WMPRJ2c91808799e11fe40199e22292b100a6',
    username: process.env.WM_USERNAME || 'jeevan.inaparti@wavemaker.com',
    password: process.env.WM_PASSWORD || 'Wavemaker@123',
    environment: (process.env.WM_ENVIRONMENT as 'stage' | 'prod') || 'stage',
    outputDir: path.resolve(__dirname, '..', 'downloaded-projects')
  };

  // Mobile server URL for React Native build
  const mobileServerUrl = process.env.MOBILE_SERVER_URL || 'https://stage-studio.wavemakeronline.com/run-xyzabc123/services';

  before(async function() {
    console.log('\n========================================');
    console.log('WaveMaker Maven Build Test Suite');
    console.log('========================================');
    console.log(`Project ID: ${wmConfig.projectId}`);
    console.log(`Environment: ${wmConfig.environment}`);
    console.log(`Output Directory: ${wmConfig.outputDir}`);
    console.log(`Mobile Server URL: ${mobileServerUrl}`);
    console.log('========================================\n');
  });

  it('should download and extract WaveMaker project', async function() {
    this.timeout(10 * 60 * 1000); // 10 minutes for download
    
    const wmManager = new WaveMakerProjectManager(wmConfig);
    projectPath = await wmManager.downloadAndExtractProject();
    
    // Verify the project was extracted
    if (!fs.existsSync(projectPath)) {
      throw new Error('Project extraction failed - directory not found');
    }
    
    // Check for pom.xml
    const pomPath = path.join(projectPath, 'pom.xml');
    if (!fs.existsSync(pomPath)) {
      throw new Error('pom.xml not found in extracted project');
    }
    
    console.log('✅ Project downloaded and verified');
  });

  it('should run mvn clean install and verify WAR file generation', async function() {
    this.timeout(15 * 60 * 1000); // 15 minutes
    
    if (!projectPath) {
      this.skip();
    }
    
    const maven = new MavenRunner(projectPath);
    const result = await maven.cleanInstall();
    
    if (!result.artifactPath) {
      throw new Error('WAR file path not returned from build');
    }
    
    warFilePath = result.artifactPath;
    
    // Additional verification
    if (!fs.existsSync(warFilePath)) {
      throw new Error(`WAR file not found at expected path: ${warFilePath}`);
    }
    
    console.log('✅ Backend WAR file verified successfully');
  });

  it('should run mvn clean package with mobile server URL and verify React Native ZIP', async function() {
    this.timeout(20 * 60 * 1000); // 20 minutes for React Native build
    
    if (!projectPath) {
      this.skip();
    }
    
    const maven = new MavenRunner(projectPath);
    const result = await maven.cleanPackageForMobile(mobileServerUrl);
    
    if (!result.artifactPath) {
      throw new Error('React Native ZIP path not returned from build');
    }
    
    rnZipPath = result.artifactPath;
    
    // Additional verification
    if (!fs.existsSync(rnZipPath)) {
      throw new Error(`React Native ZIP not found at expected path: ${rnZipPath}`);
    }
    
    console.log('✅ React Native ZIP verified successfully');
  });

  after(function() {
    console.log('\n========================================');
    console.log('Test Suite Summary');
    console.log('========================================');
    if (warFilePath) {
      console.log(`Backend WAR: ${path.basename(warFilePath)}`);
    }
    if (rnZipPath) {
      console.log(`React Native ZIP: ${path.basename(rnZipPath)}`);
    }
    console.log('========================================');
    console.log('✅ WaveMaker Maven Test Suite Complete');
    console.log('========================================\n');
  });
});

export { WaveMakerProjectManager, MavenRunner, WMProjectConfig, MavenBuildResult };
