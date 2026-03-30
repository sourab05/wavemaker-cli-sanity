export type CliPlatform = 'classic' | 'ai';

export interface CliVariant {
  platform: CliPlatform;
  packageName: string;
  binaryName: string;
}

const AI_URL_PATTERNS = ['platform.wavemaker.ai'];

/**
 * Auto-detect CLI variant from STUDIO_URL.
 * URLs containing "platform.wavemaker.ai" → AI CLI.
 * Everything else (studio.wavemakeronline.com, dev-studio, etc.) → classic CLI.
 */
export function getCliVariant(): CliVariant {
  const studioUrl = (process.env.STUDIO_URL || '').toLowerCase();

  const isAi = AI_URL_PATTERNS.some((pattern) => studioUrl.includes(pattern));

  if (isAi) {
    return {
      platform: 'ai',
      packageName: '@wavemaker-ai/wm-reactnative-cli',
      binaryName: 'wm-reactnative-ai',
    };
  }

  return {
    platform: 'classic',
    packageName: '@wavemaker/wm-reactnative-cli',
    binaryName: 'wm-reactnative',
  };
}
