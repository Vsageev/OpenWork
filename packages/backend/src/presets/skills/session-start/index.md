# Session Start

At the beginning of each session, gather the local context that is most likely
to matter for the current task before you act.

## Typical flow

1. Inspect the local entrypoint and any files named by the user.
2. Search for the exact feature, term, config, or path involved in the task.
3. Read only the most relevant matching files or sections.
4. Search for everything that might me ralated, don't stop after the first find.

## Unix search examples

```bash
# Find the files most likely to matter
rg --files | rg 'session-start|AGENTS|skill|preset'

# Search for the exact concept before opening files
rg -n "search first|read only what is needed|clarification" .

# Read only the relevant section instead of dumping the whole file
sed -n '1,160p' packages/backend/src/presets/skills/session-start/index.md
```

