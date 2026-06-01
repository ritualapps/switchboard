# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] -- 2026-06-02

Initial public release.

Switchboard is a terminal dashboard for operators running many Claude Code
sessions at once. It gathers every active session into one board, surfaces the
ones waiting on you, and lets you review each session's output and reply inline
without switching terminals.

### Added

- Board surface that groups every Claude Code session by zone (NEEDS YOU,
  READY FOR REVIEW, RUNNING, TO DO, INACTIVE), refreshed on a 2s poll.
- Drill-in view with inline annotation, edit, and delete against the agent's
  output, plus batched hand-back that dispatches one reply per line and survives
  you stepping away.
- Three emission contracts agents write to the `~/.switchboard/` substrate:
  `/ringing`, `/blocked-on-input`, and `/checkpoint`, each with a reference
  skill and, where applicable, a reference implementation.
- Direct-slot plug-in (`1`-`9`) and the `switchboard cmd <N>` shell jump.
- Per-line defer (single-keystroke move to TO DO) and dismiss with a
  high-water mark.
- `switchboard install-hook` to wire the Claude Code pickup and session-end
  hooks and install the skill packages, backing up any file before overwrite.

[1.0.0]: https://github.com/ritualapps/switchboard/releases/tag/v1.0.0
