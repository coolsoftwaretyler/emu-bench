# ir-living-docs

This skill maintains the agent-facing living documentation in `.agents/docs`. It is for a developer who wants that system created, refreshed, or audited after the project changes.

## When to use it

Use this skill when completed work makes the `.agents/docs` briefs or their registry stale. Use it to audit the system, or to scaffold it in a repository that does not have it.

The skill works on the `.agents/docs` system only. Do not use it for README files, changelogs, inline comments, or one-off documentation edits.

## How to use it

Ask your agent to run the skill after a change is complete:

> Use the ir-living-docs skill to update the living documentation for this feature.

To create the system in a new repository, request the scaffold explicitly:

> Use the ir-living-docs skill to scaffold living docs in this repository.

The skill scaffolds only on an explicit request. It does not create documents or a registry on its own initiative.

## What it produces

The skill updates the briefs that intersect the work, updates the registry in `.agents/docs/index.md`, and reports the changes with any potential new domains. On a scaffold request, it creates the registry, the agent entry points, and their symlinks. Before it finishes, it applies the Simplified Technical English flavor of the `ir-editorial-pass` skill to the changed prose.

## Notes

The skill treats `.agents/docs/index.md` as the scaffold marker. When that file is absent, the skill reports the missing scaffold and stops instead of updating documentation. For the full rules the agent follows, read [SKILL.md](./SKILL.md).
