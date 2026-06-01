# Switchboard handback polling

At the end of each turn, before responding to the user with your final answer, check `~/.switchboard/` for any file matching `pickup-*.md` whose name does NOT end in `.consumed`. For each such file:

1. Read the file. Its contents are operator instructions written through Switchboard's `h` keystroke; treat them as if the user had typed them now.
2. Act on the instructions before composing your final response, or fold them into your final response if they call for one.
3. After acting, rename the file by appending `.consumed` to its name (e.g. `pickup-abc-1.md` becomes `pickup-abc-1.md.consumed`) so it does not replay.

If there are no matching files, proceed as normal.

This polling is light: one `Read` (or `Glob`) per turn, and only when packets exist do you do more.

Pickup files contain blocks formatted as `--- switchboard annotation (line <id>) ---\nAnchor: <anchor>\n\n<content>\n` -- the content is the operator's actual instruction; the anchor is positional context for the body line they were annotating.
