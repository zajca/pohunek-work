// Child process execution with argv arrays only. Provider text must never be
// placed in argv by callers; there is no shell involved here.

export interface ExecOptions {
  readonly timeoutMs: number;
  /** Written to the child's stdin and closed; omitted means an empty stdin. */
  readonly stdin?: string;
  /** Overrides the inherited environment when given. Never carries secrets. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecResult {
  /** Null when the process was killed by the timeout or a signal. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** The binary could not be started (missing, not executable). */
export class SpawnError extends Error {
  public readonly binary: string;

  public constructor(binary: string, cause: unknown) {
    super(`cannot start ${binary}`, { cause });
    this.name = "SpawnError";
    this.binary = binary;
  }
}

export type Exec = (argv: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export const exec: Exec = async (argv, options) => {
  const [binary, ...args] = argv;
  if (binary === undefined) {
    throw new TypeError("exec requires a non-empty argv");
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([binary, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
    });
  } catch (cause) {
    throw new SpawnError(binary, cause);
  }

  const state = { timedOut: false };
  let onTimeout: () => void = () => undefined;
  const timedOutSignal = new Promise<void>((resolve) => {
    onTimeout = resolve;
  });
  const timer = setTimeout(() => {
    state.timedOut = true;
    child.kill("SIGKILL");
    onTimeout();
  }, options.timeoutMs);

  try {
    if (options.stdin !== undefined) {
      await Promise.resolve(child.stdin.write(options.stdin));
    }
    await Promise.resolve(child.stdin.end());
    const finished = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // A grandchild that inherited the pipes keeps them open after the kill, so
    // the timeout must not wait for the reads to finish.
    const outcome = await Promise.race([finished, timedOutSignal.then(() => null)]);
    if (outcome === null) {
      finished.catch(() => undefined);
      return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    }
    const [stdout, stderr, exitCode] = outcome;
    return { exitCode: state.timedOut ? null : exitCode, stdout, stderr, timedOut: state.timedOut };
  } finally {
    clearTimeout(timer);
  }
};
