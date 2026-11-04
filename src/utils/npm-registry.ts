import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_WM_NPM_REGISTRY =
  'https://repository.wavemaker.com/repository/wavemaker-npm-repo/';
export const DEFAULT_NPM_REGISTRY = DEFAULT_WM_NPM_REGISTRY;

function resolveRegistries(): { publicRegistry: string; wmRegistry: string } {
  const wmRegistry = process.env.WM_NPM_REGISTRY?.trim() || DEFAULT_WM_NPM_REGISTRY;
  return {
    publicRegistry: wmRegistry,
    wmRegistry,
  };
}

/** Apply npm registry config globally (npm config set). Call before npm install. */
export function configureNpmRegistry(): void {
  const { publicRegistry, wmRegistry } = resolveRegistries();
  for (const key of ['registry', '@wm:registry', '@wavemaker:registry', '@wavemaker-ai:registry']) {
    execFileSync('npm', ['config', 'set', key, key === 'registry' ? publicRegistry : wmRegistry], {
      stdio: 'inherit',
    });
  }
  // CLI codegen installs run outside this checkout and must inherit the same default.
  process.env.npm_config_registry = wmRegistry;
  process.env.NPM_CONFIG_REGISTRY = wmRegistry;
  process.env.WM_NPM_REGISTRY = wmRegistry;
}

/** Write project-local .npmrc so installs in that directory use the same registries. */
export function writeProjectNpmrc(projectDir: string): void {
  const { publicRegistry, wmRegistry } = resolveRegistries();
  const npmrc = [
    `registry=${publicRegistry}`,
    `@wm:registry=${wmRegistry}`,
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
