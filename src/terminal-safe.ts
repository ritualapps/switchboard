/**
 * Terminal-control sanitisation.
 *
 * Switchboard renders strings that originate in Claude Code transcripts and in
 * agent-written emission files -- titles, body text, summaries, checkpoint
 * messages. That content is not trusted: anything an agent, a tool result, a
 * fetched page, or another local process can write into a transcript becomes
 * input here. Ink's <Text> passes raw bytes through to stdout, so an embedded
 * escape sequence (OSC clipboard write, title-setting, cursor/screen control,
 * hyperlinks) would be interpreted by the operator's terminal.
 *
 * `stripTerminalControls` removes escape sequences and control bytes before
 * such strings reach the render tree. Newlines and tabs are preserved -- the
 * body viewport splits on "\n" itself, so stripping it would break multi-line
 * rendering -- everything else in the C0/C1 control range, and any ESC-
 * introduced CSI/OSC sequence, is dropped.
 */

// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESC = /\x1b[@-Z\\-_]?/g;
// C0 controls except tab (\x09) and newline (\x0a), plus DEL (\x7f).
// eslint-disable-next-line no-control-regex
const C0_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;
// eslint-disable-next-line no-control-regex
const C1_CONTROLS = /[\x80-\x9f]/g;

export function stripTerminalControls(s: string): string {
  if (!s) return s;
  return s
    .replace(CSI_SEQUENCE, '')
    .replace(OSC_SEQUENCE, '')
    .replace(OTHER_ESC, '')
    .replace(C0_CONTROLS, '')
    .replace(C1_CONTROLS, '');
}
