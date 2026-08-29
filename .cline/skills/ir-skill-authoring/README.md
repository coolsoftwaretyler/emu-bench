# ir-skill-authoring

This skill writes a new skill for the MAACS collection. It also adapts a skill from another source into the collection. It is for a developer who wants a new capability in `skills/` that follows the conventions of this repository.

The skill works with you before it writes a file. It asks about the capability, and it resolves its open questions. It waits for your approval.

## When to use it

Use this skill when you want a new MAACS skill. Use it also when a skill exists somewhere else, and you want that skill in the collection. Such a skill can be your own experiment, or a skill from a client project.

The skill runs in the MAACS checkout, because it writes into `skills/` and into the repository's own documentation. Do not use it for the CLI. Do not use it for a skill that stays in one client project.

## How to use it

Ask your agent to start the work:

> Use the ir-skill-authoring skill. I want a skill that runs our release checklist.

To bring in a skill that exists already, give the agent its location:

> Use the ir-skill-authoring skill to make ~/my-skills/screenshot-diff a MAACS skill.

Answer the agent's questions, then tell it to write the files. The agent creates no file before you approve the design.

The agent offers to test the skill after the files exist. If you accept, the agent builds a sandbox with its own test harness. If you decline, the agent does not ask again.

## What it produces

The skill creates the skill directory in `skills/`. The directory holds an instruction file, a README, and the supporting files that the design needs.

The skill then applies an editorial pass, runs `pnpm validate`, and adds a row to the skills catalog in the root README. The new README always takes the Simplified Technical English flavor. For the other files, you choose the flavor, or you skip the pass.

After that work, the skill continues to work with you. Each further request changes the skill.

## Notes

The conventions that the agent follows are in [references/conventions.md](./references/conventions.md). The additional rules for an imported skill are in [references/adaptation.md](./references/adaptation.md). Read either file to learn why the collection works as it does.
