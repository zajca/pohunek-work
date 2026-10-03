// Runs a grandchild through execInteractive, the way `do <key> attach` runs
// `pohunek attach`; the test reads the grandchild's streams on this process's pipes.
import { execInteractive } from "../../src/util/exec.ts";

const code = await execInteractive(["/bin/sh", "-c", 'read line; echo "out:$line"; echo "err:$line" >&2; exit 4']);
process.exitCode = code ?? 1;
