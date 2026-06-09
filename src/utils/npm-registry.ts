import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const DEFAULT_WM_NPM_REGISTRY =
  'https://repository.wavemaker.com/repository/wavemaker-npm-repo/';

function resolveRegistries(): { publicRegistry: string; wmRegistry: string } {
  return {
    publicRegistry: process.env.NPM_REGISTRY?.trim() || DEFAULT_NPM_REGISTRY,
    wmRegistry: process.env.WM_NPM_REGISTRY?.trim() || DEFAULT_WM_NPM_REGISTRY,
  };
}

/** Apply npm registry config globally (npm config set). Call before npm install. */
export function configureNpmRegistry(): void {
  const { publicRegistry, wmRegistry } = resolveRegistries();
  execSync(`npm config set registry "${publicRegistry}"`, { stdio: 'inherit' });
  execSync(`npm config set @wavemaker:registry "${wmRegistry}"`, { stdio: 'inherit' });
  execSync(`npm config set @wavemaker-ai:registry "${wmRegistry}"`, { stdio: 'inherit' });
}

/** Write project-local .npmrc so installs in that directory use the same registries. */
export function writeProjectNpmrc(projectDir: string): void {
  const { publicRegistry, wmRegistry } = resolveRegistries();
  const npmrc = [
    `registry=${publicRegistry}`,
    `@wavemaker:registry=${wmRegistry}`,
    `@wavemaker-ai:registry=${wmRegistry}`,
    '',
  ].join('\n');

  fs.writeFileSync(path.join(projectDir, '.npmrc'), npmrc, 'utf-8');
}

/**
 * Set global npm registry config and write .npmrc in the target project.
 * Always call this immediately before npm/yarn install in that project.
 */
export function ensureNpmRegistry(projectDir: string): void {
  configureNpmRegistry();
  writeProjectNpmrc(projectDir);
}
