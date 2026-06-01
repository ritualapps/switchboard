# Switchboard examples

User-contributed recipes for using Switchboard in ways the V1 binary doesn't directly ship.

The most interesting category for V1 is **handback delivery** (see the README's "Handback delivery (V1)" section). The V1 binary writes pickup files when you press `h`; how Claude Code starts processing those packets without you typing is the open question. Agent-side recipes (instructions you add to your `CLAUDE.md`) are the lowest barrier to contribution and the highest leverage, because they don't require a Switchboard release.

## Contributing a recipe

1. Create a directory under `examples/` named after the shape (e.g. `examples/your-recipe/`).
2. Include a `CLAUDE.md` or `SKILL.md` snippet that does the work, plus a `README.md` explaining what it does, trade-offs, and known failure modes.
3. Open a PR.

Recipes don't need to be perfect. Honestly named trade-offs are more useful than confident claims.

## Current recipes

- [`agent-as-watcher/`](./agent-as-watcher/) -- the simplest shape; the agent polls its own pickup directory at end of turn.
