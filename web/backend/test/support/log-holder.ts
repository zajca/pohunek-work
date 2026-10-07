import { LogFileError, rotatingFileLogger } from "../../src/log-files";

/** Exit status of a holder whose logger could not take the directory. */
const REFUSED_EXIT_CODE = 3;
const LIMIT_BYTES = 4096;
const FILE_COUNT = 2;

/**
 * Test helper process: opens a rotating logger on the directory in `argv[2]`,
 * prints `ready` once it holds the directory, and closes the logger when its
 * standard input ends. A refused open prints `refused <message>` and exits.
 */
const dir = process.argv[2];
if (dir === undefined) {
  throw new Error("log directory argument is required");
}
try {
  const logger = rotatingFileLogger({ dir, maxFileBytes: LIMIT_BYTES, maxFiles: FILE_COUNT });
  process.stdin.on("end", () => {
    logger.close();
    process.exit(0);
  });
  process.stdin.resume();
  process.stdout.write("ready\n");
} catch (error: unknown) {
  if (!(error instanceof LogFileError)) {
    throw error;
  }
  process.stdout.write(`refused ${error.message}\n`);
  process.exit(REFUSED_EXIT_CODE);
}
