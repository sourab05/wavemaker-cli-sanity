import * as fs from 'fs';
import * as path from 'path';
import { getCliVariant } from './cli-variant';

export type PackageManagerType = 'npm' | 'yarn';

/**
 * Reads PACKAGE_MANAGER env var and returns the list of package managers to test.
 * Supported values: "npm" (default), "yarn", "both"
 */
export function getPackageManagers(): PackageManagerType[] {
  const raw = (process.env.PACKAGE_MANAGER || 'npm').toLowerCase().trim();
  if (raw === 'both') return ['npm', 'yarn'];
  if (raw === 'yarn') return ['yarn'];
  return ['npm'];
}

const variant = getCliVariant();

/**
 * Provides the correct shell commands for a given package manager.
 * CLI variant (classic/ai) is auto-detected from STUDIO_URL.
 *
 * npm link flow:
 *   CLI repo:        npm install → npm link --force
 *   Automation repo: npm link <packageName>
 *
 * yarn link flow:
 *   CLI repo:        yarn install → yarn link
 *   Automation repo: yarn link <packageName>
 */
export class PackageManagerCommands {
  readonly type: PackageManagerType;

  constructor(pm: PackageManagerType) {
    this.type = pm;
  }

  get label(): string {
    return this.type.toUpperCase();
  }

  /** Run the CLI with the given arguments. Resolves to correct binary based on STUDIO_URL. */
  cli(args: string): string {
    if (this.type === 'yarn') {
      return `yarn ${variant.binaryName} ${args}`;
    }
    return `npx ${variant.packageName} ${args}`;
  }

  /** Install dependencies in a project directory. */
  install(): string {
    return this.type === 'yarn' ? 'yarn install' : 'npm install';
  }

  /** Run a package.json script (e.g. "android", "ios"). */
  run(script: string): string {
    return this.type === 'yarn' ? `yarn ${script}` : `npm run ${script}`;
  }

  /** Direct CLI binary invocation (build commands). */
  cliBinary(args: string): string {
    if (this.type === 'yarn') {
      return `yarn ${variant.binaryName} ${args}`;
    }
    return `npx ${variant.binaryName} ${args}`;
  }

  /**
   * Remove the other package manager's lock file and node_modules from a project
   * directory to avoid mixed lock file warnings and stale .bin entries.
   * yarn → removes package-lock.json
   * npm  → removes yarn.lock
   * If the opposite lock file existed, also removes node_modules for a clean install.
   */
  cleanForInstall(projectDir: string): string[] {
    const removed: string[] = [];
    const staleLock = this.type === 'yarn' ? 'package-lock.json' : 'yarn.lock';
    const lockPath = path.join(projectDir, staleLock);
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
      removed.push(staleLock);

      const nmPath = path.join(projectDir, 'node_modules');
      if (fs.existsSync(nmPath)) {
        fs.rmSync(nmPath, { recursive: true, force: true });
        removed.push('node_modules');
      }
    }
    return removed;
  }

  /** Register a local package as a global link (run from inside the package directory). */
  linkRegister(): string {
    return this.type === 'yarn' ? 'yarn link' : 'npm link --force';
  }

  /** Consume a previously registered link in the current project. */
  linkConsume(packageName: string): string {
    return this.type === 'yarn'
      ? `yarn link ${packageName}`
      : `npm link ${packageName}`;
  }
}
