import axios from 'axios';
import qs from 'qs';
import { createLogger } from '../utils/Logger';

const log = createLogger('AuthService');

export class AuthService {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async login(username: string, password: string): Promise<string> {
    const loginUrl = `${this.baseUrl}/login/authenticate`;
    const payload = qs.stringify({ j_username: username, j_password: password });

    log.info(`Authenticating user "${username}" against ${this.baseUrl}...`);

    try {
      const response = await axios.post(loginUrl, payload, {
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

      const authCookie = cookieLine.split(';')[0];
      log.success('Login successful');
      return authCookie;
    } catch (error: any) {
      log.error(`Login failed: ${error.message}`);
      throw new Error(`Authentication failed for user "${username}": ${error.message}`);
    }
  }

  async getPreviewUrl(projectId: string, authCookie: string): Promise<string> {
    const previewApiUrl = `${this.baseUrl}/studio/services/projects/${projectId}/deployment/inplaceDeploy`;
    const cookieValue = authCookie.split('=')[1];

    log.info(`Fetching preview URL for project ${projectId}...`);

    try {
      const response = await axios.post(previewApiUrl, {}, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Cookie: `auth_cookie=${cookieValue}`,
        },
      });

      if (response.status !== 200 || !response.data.result) {
        throw new Error(`Unexpected response: status=${response.status}`);
      }

      const resultUrl = response.data.result;
      const previewUrl = resultUrl.startsWith('http') ? resultUrl : `https:${resultUrl}`;

      log.success(`Preview URL obtained: ${previewUrl}`);
      return previewUrl;
    } catch (error: any) {
      log.error(`Failed to get preview URL: ${error.message}`);
      throw new Error(`Failed to retrieve preview URL for project ${projectId}: ${error.message}`);
    }
  }

  extractCookieValue(authCookie: string): string {
    return authCookie.split('=')[1].trim();
  }
}
