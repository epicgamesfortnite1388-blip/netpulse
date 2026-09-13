import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a system command with an argument array (never a shell string)
 * and a hard timeout. Output lines can be consumed incrementally via
 * `onStdoutLine`, which long probes use for live progress.
 */
export function runCommand(
  cmd: string,
  args: string[],
  options: { timeoutMs: number; onStdoutLine?: (line: string) => void },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let lineBuf = '';

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.onStdoutLine) {
        lineBuf += text;
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) options.onStdoutLine(line);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(err)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (options.onStdoutLine && lineBuf.trim()) options.onStdoutLine(lineBuf);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
