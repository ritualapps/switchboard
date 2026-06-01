/**
 * OS clipboard fallback (defence-in-depth).
 *
 * Every successful pickup-file write also copies the annotation payload to
 * the OS clipboard. If the Claude Code UserPromptSubmit hook misfires for
 * any reason, the operator can paste the payload manually into the agent's
 * prompt. Keeps wander-away-safe operation robust to single-sink failures.
 *
 * Cross-platform:
 *   macOS   -> pbcopy
 *   Linux   -> wl-copy (Wayland) OR xclip / xsel (X11)
 *   Windows -> clip
 *
 * Best-effort: if no tool is available, returns { ok: false, detail }.
 * The caller does NOT fail dispatch on clipboard failure -- clipboard is
 * the third sink; pickup-file (primary) + audit log (always) carry the
 * dispatch contract.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:process';

export interface ClipboardResult {
  ok: boolean;
  detail: string;
  tool?: string;
}

interface ClipboardTool {
  bin: string;
  args: string[];
}

function pickTool(): ClipboardTool | null {
  if (platform === 'darwin') {
    return { bin: 'pbcopy', args: [] };
  }
  if (platform === 'win32') {
    return { bin: 'clip', args: [] };
  }
  // Linux + others: prefer Wayland, fall back to X11.
  if (process.env.WAYLAND_DISPLAY) {
    return { bin: 'wl-copy', args: [] };
  }
  if (process.env.DISPLAY) {
    return { bin: 'xclip', args: ['-selection', 'clipboard'] };
  }
  // No display server detected. Try xsel as last resort (sometimes works
  // in headless setups via redirection).
  return { bin: 'xsel', args: ['--clipboard', '--input'] };
}

export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  const tool = pickTool();
  if (!tool) {
    return { ok: false, detail: 'no clipboard tool detected' };
  }
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: ClipboardResult) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(tool.bin, tool.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (err) {
      finish({ ok: false, detail: `spawn failed: ${(err as Error).message}`, tool: tool.bin });
      return;
    }
    child.on('error', (err) => {
      finish({ ok: false, detail: `${tool.bin} not available: ${err.message}`, tool: tool.bin });
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, detail: `copied via ${tool.bin}`, tool: tool.bin });
      } else {
        finish({ ok: false, detail: `${tool.bin} exit ${code}`, tool: tool.bin });
      }
    });
    try {
      child.stdin.end(text, 'utf8');
    } catch (err) {
      finish({ ok: false, detail: `write to ${tool.bin} stdin failed: ${(err as Error).message}`, tool: tool.bin });
    }
  });
}
