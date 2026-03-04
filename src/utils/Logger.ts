import chalk from 'chalk';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel;
  private context: string;

  constructor(context: string, level?: LogLevel) {
    this.context = context;
    this.level = level ?? LogLevel.INFO;
  }

  private prefix(): string {
    const timestamp = new Date().toISOString().slice(11, 23);
    return `[${timestamp}][${this.context}]`;
  }

  debug(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.log(chalk.gray(`${this.prefix()} ${message}`), ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.INFO) {
      console.log(chalk.cyan(`${this.prefix()} ${message}`), ...args);
    }
  }

  success(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.INFO) {
      console.log(chalk.green(`${this.prefix()} ✅ ${message}`), ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(chalk.yellow(`${this.prefix()} ⚠️  ${message}`), ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    console.error(chalk.red(`${this.prefix()} ❌ ${message}`), ...args);
  }

  step(stepNum: number, total: number, message: string): void {
    if (this.level <= LogLevel.INFO) {
      console.log(chalk.blue(`${this.prefix()} [Step ${stepNum}/${total}] ${message}`));
    }
  }

  separator(title?: string): void {
    const line = '='.repeat(60);
    console.log(`\n${line}`);
    if (title) {
      console.log(chalk.bold(`  ${title}`));
      console.log(line);
    }
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context);
}
