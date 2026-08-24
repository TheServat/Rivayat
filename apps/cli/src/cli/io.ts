/**
 * The terminal, behind an interface.
 *
 * Nothing under `src/commands` calls `console`. That is not tidiness: a command that
 * writes to the process's real stdout can only be tested by capturing a global, and a
 * captured global is shared state between tests running in the same worker. With the
 * writer injected, asserting on a command's output is asserting on a value.
 *
 * It also keeps the stream split honest. Machine-readable output goes to stdout and
 * diagnostics go to stderr, so `rv series cost --json | jq` works even when the command
 * is also complaining about something.
 */

export interface CliIo {
  /** One line to stdout. This is the command's answer. */
  out(line?: string): void;
  /** One line to stderr. Diagnostics, progress, warnings - never the answer. */
  err(line?: string): void;
}

/** The real terminal. The only place in the CLI that touches `process.stdout`. */
export class ProcessIo implements CliIo {
  constructor(
    private readonly stdout: NodeJS.WritableStream = process.stdout,
    private readonly stderr: NodeJS.WritableStream = process.stderr,
  ) {}

  out(line = ''): void {
    this.stdout.write(`${line}\n`);
  }

  err(line = ''): void {
    this.stderr.write(`${line}\n`);
  }
}

/** Collects output so a test can assert on it. */
export class BufferIo implements CliIo {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];

  out(line = ''): void {
    this.stdout.push(line);
  }

  err(line = ''): void {
    this.stderr.push(line);
  }

  /** Everything written to stdout, as one string. */
  get outText(): string {
    return this.stdout.join('\n');
  }

  /** Everything written to stderr, as one string. */
  get errText(): string {
    return this.stderr.join('\n');
  }
}
