import { expect, test } from "bun:test";
import { join } from "node:path";

const PYTHON_PTY = String.raw`
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color"})
os.close(slave)
output = bytearray()
sent = False
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        output.extend(chunk)
        if not sent and sys.argv[3].encode() in output:
            os.write(master, bytes.fromhex(sys.argv[4]))
            sent = True
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
try:
    while True:
        ready, _, _ = select.select([master], [], [], 0)
        if not ready:
            break
        output.extend(os.read(master, 65536))
except OSError:
    pass
os.close(master)
print(json.dumps({"exit": child.returncode, "sent": sent, "alternate": b"\x1b[?1049h" in output, "restored": b"\x1b[?1049l" in output, "screen": sys.argv[3].encode() in output}))
`;

async function runPty(mode: "main" | "new-session", key: string): Promise<{ exit: number; sent: boolean; alternate: boolean; restored: boolean; screen: boolean }> {
  const app = join(import.meta.dir, "../../src/ink/app.tsx");
  const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:${JSON.stringify(mode)},selfBin:"/missing/pohunek-work",pohunekBin:"/missing/pohunek",timeoutMs:100,launchTimeoutMs:100,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open"});`;
  const process = Bun.spawn(["python3", "-c", PYTHON_PTY, Bun.which("bun") ?? "bun", source, mode === "main" ? "pohunek-work" : "pohunek-work new-session", Buffer.from(key).toString("hex")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout) as { exit: number; sent: boolean; alternate: boolean; restored: boolean; screen: boolean };
}

test("the Ink process enters and restores the terminal when the owner quits", async () => {
  const result = await runPty("main", "q");
  expect(result).toEqual({ exit: 0, sent: true, alternate: true, restored: true, screen: true });
});

test("the standalone session form cancels before creating a session", async () => {
  const result = await runPty("new-session", "\u001b");
  expect(result).toEqual({ exit: 0, sent: true, alternate: true, restored: true, screen: true });
});
