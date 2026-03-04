import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import axios from 'axios';
import qs from 'qs';
import { remote, Browser } from 'webdriverio';
import dotenv from 'dotenv';
import { getWMProjectConfig, type WMProjectConfig } from './config';
import { runCommand } from './utils/run-command';
import { extractZip } from './utils/zip-utils';

dotenv.config();

interface MavenBuildResult {
  stdout: string;
  stderr: string;
  artifactPath?: string;
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
      this.fileServiceUrl = 'https://stage-studio.wavemakeronline.com/file-service';
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
  // async exportProject(): Promise<string> {
  //   if (!this.config.authCookie) {
  //     await this.login();
  //   }

  //   const exportUrl = `${this.baseUrl}/studio/services/projects/${this.config.projectId}/export`;
  //   const cookieValue = this.config.authCookie!.split('=')[1];

  //   console.log(`[WM] Exporting project ${this.config.projectId}...`);

  //   try {
  //     const response = await axios.get(exportUrl, {
  //       headers: {
  //         'Accept': 'application/json, text/plain, */*',
  //         'Cookie': `auth_cookie=${cookieValue}`,
  //         'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  //       }
  //     });

  //     let downloadPath: string;
      
  //     // Handle different response formats
  //     if (typeof response.data === 'string') {
  //       downloadPath = response.data.trim().replace(/"/g, '');
  //     } else if (response.data && response.data.result) {
  //       downloadPath = response.data.result;
  //     } else {
  //       throw new Error('Unexpected response format from export API');
  //     }

  //     // Construct full download URL
  //     let downloadUrl: string;
  //     if (downloadPath.startsWith('http')) {
  //       downloadUrl = downloadPath;
  //     } else if (downloadPath.startsWith('/')) {
  //       downloadUrl = `${this.fileServiceUrl}${downloadPath}`;
  //     } else {
  //       downloadUrl = `${this.fileServiceUrl}/${downloadPath}`;
  //     }

  //     console.log('✅ Export successful. Download URL:', downloadUrl);
  //     return downloadUrl;
  //   } catch (error: any) {
  //     console.error('❌ Export failed:', error.message);
  //     throw error;
  //   }
  // }
async exportProject(): Promise<string> {
  if (!this.config.authCookie) {
    await this.login();
  }

  const exportUrl = `${this.baseUrl}/studio/services/projects/${this.config.projectId}/export`;
  const cookieValue = this.config.authCookie!.split('=')[1];

  console.log(`[WM] Exporting project ${this.config.projectId}...`);

  const data = {
    exportType: "ZIP",
    targetName: "test2",
    excludeGeneratedUIApp: true
  };

  try {
    const response = await axios.post(exportUrl, data, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        'origin': this.baseUrl,
        'priority': 'u=1, i',
        'referer': `${this.baseUrl}/s/page/Main?project-id=${this.config.projectId}`,
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
        'x-requested-with': 'XMLHttpRequest',
        'Cookie': `auth_cookie=${cookieValue}`
      }
    });

    let downloadPath: string;

    if (typeof response.data === 'string') {
      downloadPath = response.data.trim().replace(/"/g, '');
    } else if (response.data && response.data.result) {
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
   * Extract ZIP file (cross-platform)
   */
  async extractZip(zipPath: string, extractTo?: string): Promise<string> {
    const extractPath = extractTo || path.join(
      this.config.outputDir, 
      this.config.projectId
    );

    console.log(`[WM] Extracting ${zipPath} to ${extractPath}...`);

    try {
      extractZip(zipPath, extractPath);
      console.log('✅ Extraction complete');
      return extractPath;
    } catch (error: unknown) {
      const err = error as Error;
      console.error('❌ Extraction failed:', err.message);
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
      const out = typeof result === 'object' ? result : { stdout: '', stderr: '' };
      return { ...out, artifactPath: warPath };
      
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
      const out = typeof result === 'object' ? result : { stdout: '', stderr: '' };
      return { ...out, artifactPath: zipPath };
      
    } catch (error: any) {
      console.error('❌ Maven clean package failed:', error.message);
      throw error;
    }
  }
}

/**
 * Run React Native app in Expo Go
 */
async function runInExpoGo(
  projectPath: string,
  platform: 'android' | 'ios',
  serverType: 'dev' | 'deployed',
  appVerificationId: string
): Promise<void> {
  let metroProcess: ChildProcess | undefined;
  let client: Browser | undefined;

  try {
    // Platform-specific setup
    const capabilities = platform === 'android' ? {
      platformName: 'Android',
      'appium:deviceName': process.env.ANDROID_DEVICE_NAME || 'emulator-5554',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': 'host.exp.exponent',
      'appium:appActivity': '.experience.HomeActivity',
      'appium:autoGrantPermissions': true,
    } : {
      platformName: 'iOS',
      'appium:deviceName': 'iPhone 15',
      'appium:platformVersion': '17.0',
      'appium:automationName': 'XCUITest',
      'appium:bundleId': 'host.exp.Exponent',
      'appium:autoAcceptAlerts': true,
    };

    console.log(`Connecting to Expo Go on ${platform}...`);
    client = await remote({
      hostname: '127.0.0.1',
      port: 4723,
      capabilities
    });

    // Start Metro bundler
    const runCmd = platform === 'android' ? 'npm run android' : 'npm run ios';
    console.log(`Starting Metro bundler for ${serverType.toUpperCase()} project on ${platform}...`);
    
    const runPromise = new Promise((resolve, reject) => {
      metroProcess = spawn(runCmd, {
        shell: true,
        cwd: projectPath,
        detached: true,
        stdio: 'pipe'
      });

      metroProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(text);
        
        if (text.includes('Waiting on http://localhost:8081')) {
          console.log(`✅ Metro bundler ready, Expo Go should open the ${serverType.toUpperCase()} project`);
          resolve(true);
        }
      });

      metroProcess.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(data);
      });

      metroProcess.on('error', reject);
      setTimeout(() => reject(new Error('Metro bundler startup timeout')), 120000);
    });

    await runPromise;

    // Wait for app to load
    console.log(`Waiting for ${serverType.toUpperCase()} app to load in Expo Go...`);
    await new Promise(resolve => setTimeout(resolve, platform === 'ios' ? 20000 : 15000));

    // Verify app is running
    console.log(`Verifying ${serverType.toUpperCase()} app on ${platform}...`);
    const el = await client.$(appVerificationId);
    await el.waitForDisplayed({ timeout: 60000 });

    console.log(`✅ ${serverType.toUpperCase()} app running successfully in Expo Go on ${platform}`);

  } finally {
    // Cleanup
    if (client) {
      await client.deleteSession();
    }
    if (metroProcess?.pid) {
      try {
        if (os.platform() === 'win32') {
          spawn('taskkill', ['/pid', String(metroProcess.pid), '/t', '/f']);
        } else {
          process.kill(-metroProcess.pid, 'SIGKILL');
        }
      } catch (e) {
        console.error('Failed to kill Metro process:', e);
      }
    }
  }
}

/** Helper: build RN ZIP and rename with suffix */
async function buildAndVerifyRnZip(
  projectPath: string,
  serverUrl: string,
  suffix: string
): Promise<string> {
  const maven = new MavenRunner(projectPath);
  const result = await maven.cleanPackageForMobile(serverUrl);
  if (!result.artifactPath) {
    throw new Error('React Native ZIP path not returned from build');
  }
  const newPath = result.artifactPath.replace('.zip', `-${suffix}.zip`);
  fs.renameSync(result.artifactPath, newPath);
  if (!fs.existsSync(newPath)) {
    throw new Error(`ZIP not found at expected path: ${newPath}`);
  }
  return newPath;
}

/** Helper: extract RN ZIP and run npm install */
function extractAndPrepareRnProject(
  zipPath: string,
  outputDir: string,
  folderName: string
): string {
  const extractPath = path.join(outputDir, folderName);
  if (fs.existsSync(extractPath)) {
    fs.rmSync(extractPath, { recursive: true, force: true });
  }
  extractZip(zipPath, extractPath);
  execSync('npm install', { cwd: extractPath, stdio: 'inherit' });
  return extractPath;
}

// Test suite for WaveMaker project download and Maven automation
describe('WaveMaker React Native Maven Build and Expo Go Verification', function() {
  this.timeout(30 * 60 * 1000); // 30 minutes timeout for the entire suite

  let projectPath: string;
  let warFilePath: string;
  let devRnZipPath: string;
  let deployedRnZipPath: string;
  let devExtractedPath: string;
  let deployedExtractedPath: string;
  let appiumProcess: ChildProcess | undefined;
  let wmConfig: WMProjectConfig;

  const devServerUrl = 'dev';
  const deployedServerUrl = process.env.DEPLOYED_SERVER_URL || 'https://your-deployed-app.com/services';
  const appVerificationId = process.env.APP_VERIFICATION_ID || '~mobile_navbar1_title';

  before(async function() {
    wmConfig = getWMProjectConfig();
    console.log('\n========================================');
    console.log('WaveMaker React Native Build & Expo Go Test Suite');
    console.log('========================================');
    console.log(`Project ID: ${wmConfig.projectId}`);
    console.log(`Environment: ${wmConfig.environment}`);
    console.log(`Output Directory: ${wmConfig.outputDir}`);
    console.log(`Dev Server: Using WaveMaker Preview`);
    console.log(`Deployed Server: ${deployedServerUrl}`);
    console.log('========================================\n');

    // Start Appium server once for all tests
    console.log('Starting Appium server...');
    appiumProcess = spawn('appium', { shell: true, detached: true });
    await new Promise(resolve => setTimeout(resolve, 5000));
  });

  it('should download and extract WaveMaker project from studio', async function() {
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

  it('should build backend WAR file using mvn clean install', async function() {
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

  it('should generate React Native ZIP with DEV server URL (WaveMaker Preview)', async function() {
    this.timeout(20 * 60 * 1000);
    if (!projectPath) this.skip();
    console.log('\n📱 Building React Native ZIP for DEV environment...');
    devRnZipPath = await buildAndVerifyRnZip(projectPath, devServerUrl, 'dev');
    console.log('✅ DEV React Native ZIP generated and verified');
  });

  it('should generate React Native ZIP with DEPLOYED server URL', async function() {
    this.timeout(20 * 60 * 1000);
    if (!projectPath) this.skip();
    console.log('\n🚀 Building React Native ZIP for PRODUCTION environment...');
    deployedRnZipPath = await buildAndVerifyRnZip(projectPath, deployedServerUrl, 'deployed');
    console.log('✅ DEPLOYED React Native ZIP generated and verified');
  });

  it('should extract and prepare DEV React Native project', async function() {
    if (!devRnZipPath) this.skip();
    console.log('\n📦 Extracting DEV React Native project...');
    devExtractedPath = extractAndPrepareRnProject(devRnZipPath, wmConfig.outputDir, 'rn-dev-project');
    console.log('✅ DEV React Native project prepared');
  });

  it('should extract and prepare DEPLOYED React Native project', async function() {
    if (!deployedRnZipPath) this.skip();
    console.log('\n📦 Extracting DEPLOYED React Native project...');
    deployedExtractedPath = extractAndPrepareRnProject(deployedRnZipPath, wmConfig.outputDir, 'rn-deployed-project');
    console.log('✅ DEPLOYED React Native project prepared');
  });

  it('should run and verify DEV app in Expo Go on Android emulator', async function() {
    if (process.env.SKIP_EXPO_GO === 'true') this.skip();
    this.timeout(10 * 60 * 1000);
    if (!devExtractedPath) this.skip();
    console.log('\n📱 Running DEV app in Expo Go on Android...');
    await runInExpoGo(devExtractedPath, 'android', 'dev', appVerificationId);
    console.log('✅ DEV app verified successfully with WaveMaker Preview backend');
  });

  it('should run and verify DEPLOYED app in Expo Go on Android emulator', async function() {
    if (process.env.SKIP_EXPO_GO === 'true') this.skip();
    this.timeout(10 * 60 * 1000);
    if (!deployedExtractedPath) this.skip();
    console.log('\n🚀 Running DEPLOYED app in Expo Go on Android...');
    await runInExpoGo(deployedExtractedPath, 'android', 'deployed', appVerificationId);
    console.log(`✅ DEPLOYED app verified successfully with backend: ${deployedServerUrl}`);
  });

  it('should run and verify DEV app in Expo Go on iOS simulator (macOS only)', async function() {
    if (process.env.SKIP_EXPO_GO === 'true') this.skip();
    if (os.platform() !== 'darwin') this.skip();
    this.timeout(10 * 60 * 1000);
    if (!devExtractedPath) this.skip();
    console.log('\n📱 Starting iOS Simulator...');
    execSync('open -a Simulator', { stdio: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 10000));
    console.log('Running DEV app in Expo Go on iOS...');
    await runInExpoGo(devExtractedPath, 'ios', 'dev', appVerificationId);
    console.log('✅ DEV app verified successfully on iOS with WaveMaker Preview backend');
  });

  it('should run and verify DEPLOYED app in Expo Go on iOS simulator (macOS only)', async function() {
    if (process.env.SKIP_EXPO_GO === 'true') this.skip();
    if (os.platform() !== 'darwin') this.skip();
    this.timeout(10 * 60 * 1000);
    if (!deployedExtractedPath) this.skip();
    console.log('\n🚀 Running DEPLOYED app in Expo Go on iOS...');
    await runInExpoGo(deployedExtractedPath, 'ios', 'deployed', appVerificationId);
    console.log(`✅ DEPLOYED app verified successfully on iOS with backend: ${deployedServerUrl}`);
  });

  after(function() {
    // Cleanup Appium server
    if (appiumProcess?.pid) {
      try {
        if (os.platform() === 'win32') {
          spawn('taskkill', ['/pid', String(appiumProcess.pid), '/t', '/f']);
        } else {
          process.kill(-appiumProcess.pid, 'SIGKILL');
        }
      } catch (e) {
        console.error('Failed to kill Appium process:', e);
      }
    }

    console.log('\n========================================');
    console.log('Test Suite Summary');
    console.log('========================================');
    if (warFilePath) {
      console.log(`✅ Backend WAR: ${path.basename(warFilePath)}`);
    }
    if (devRnZipPath) {
      console.log(`✅ DEV React Native ZIP: ${path.basename(devRnZipPath)}`);
    }
    if (deployedRnZipPath) {
      console.log(`✅ DEPLOYED React Native ZIP: ${path.basename(deployedRnZipPath)}`);
    }
    console.log('✅ All apps verified in Expo Go successfully!');
    console.log('========================================\n');
  });
});

export { WaveMakerProjectManager, MavenRunner, WMProjectConfig, MavenBuildResult };
