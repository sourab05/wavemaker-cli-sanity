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

/**
 * Provides the correct shell commands for a given package manager.
 *
 * npm link flow:
 *   CLI repo:        npm install → npm link --force
 *   Automation repo: npm link @wavemaker/wm-reactnative-cli
 *
 * yarn link flow:
 *   CLI repo:        yarn install → yarn link
 *   Automation repo: yarn link @wavemaker/wm-reactnative-cli
 */
export class PackageManagerCommands {
  readonly type: PackageManagerType;

  constructor(pm: PackageManagerType) {
    this.type = pm;
  }

  get label(): string {
    return this.type.toUpperCase();
  }

  /** Run the wm-reactnative CLI with the given arguments. */
  cli(args: string): string {
    if (this.type === 'yarn') {
      return `yarn wm-reactnative ${args}`;
    }
    return `npx @wavemaker/wm-reactnative-cli ${args}`;
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
      return `yarn wm-reactnative ${args}`;
    }
    return `wm-reactnative ${args}`;
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
