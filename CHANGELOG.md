# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] -- 2026-06-04

The morning after launch I caught it on my own board: a session I'd started with a slash command showed Claude Code's raw `<command-name>` wrapper as its title, multi-line and spilling into the rows below. v1.0.0 stripped control bytes from titles but trusted the text itself to be display-ready, and a slash-command wrapper, a hook injection, or a pasted multi-line prompt is not. v1.0.1 routes every title through a single boundary that guarantees one clean line, so the board holds its layout whatever a session is named.

### Fixed

- A slash-command session title (e.g. `/new switchboard bugs`) now reads as the command you typed, not Claude Code's raw wrapper.
- A multi-line title collapses to one line, so it no longer pushes the rows beneath it out of place.
- The same cleaning now covers AI-set and custom titles, not only the first prompt.

### Notes

- Nothing changed in the CLI, your settings, or anything under `~/.switchboard/`. The upgrade is drop-in.
- A regression test pins every title to one clean line across the input shapes that broke it, so the next wrapper-format change is caught before it ships.

[1.0.1]: https://github.com/ritualapps/switchboard/releases/tag/v1.0.1

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
