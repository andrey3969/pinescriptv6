# Humanizer skill (local customization)

This folder includes [blader/humanizer](https://github.com/blader/humanizer) v4.0.0 (MIT licensed), with small local changes.

## Local differences

- For direct rewrite requests, return one ready-to-send version instead of a draft + critique + revision.
- For "sound like me" requests, favor casual, straightforward writing that matches any supplied examples without inventing facts.
- Keep all of Humanizer's 26 editorial pattern checks and safeguards.

## Use

Ask your Claude Code or other compatible agent to "humanize this message" or use `/humanizer` if your agent supports slash commands for skills.

## Upstream updates

Compare `SKILL.md` with https://github.com/blader/humanizer/blob/main/SKILL.md before updating, then reapply the two local changes documented above.

License: see `LICENSE`.
