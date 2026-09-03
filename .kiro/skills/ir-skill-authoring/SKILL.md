---
name: ir-skill-authoring
description: Write a new MAACS skill, or adapt an outside skill into this collection, with the conventions that this repository follows. Use it when the user asks to create a skill, to turn a repeated workflow into a skill, or to bring an existing skill into MAACS. Settle the design with the user first. Write no file before the user approves it. Do not use it for the CLI, for repository documentation, or for a skill that belongs to one client project.
metadata:
  version: 2
---

# Skill authoring

Add a skill to the MAACS collection in `skills/`. The result is a directory that the CLI installs, updates, and removes. The directory holds an `ir-` name, a version, an instruction file, and the supporting material that the skill needs.

Work with the user before you create a file. A skill that you write from assumptions becomes the instructions that every later agent follows.

## Confirm the checkout

This skill writes into the MAACS collection, so it runs in the MAACS checkout. Confirm that `skills/`, `.agents/docs/index.md`, and `.tools/validators/` are present.

If one of them is absent, report the missing checkout and stop. Do not create a skill directory in another repository. Do not fit these conventions to a different repository.

Read [references/conventions.md](./references/conventions.md) before you design anything. That file gives the collection's contract and the reason behind each convention.

## Two starting points

- **A new skill.** The user describes a capability, or the current session already contains the workflow to capture.
- **An outside skill.** The user has a skill from somewhere else: their own, an experiment, one written for another agent, or one from a client project. Read [references/adaptation.md](./references/adaptation.md) as well. Then follow the same collaboration.

Both starting points use the design conversation below, and both produce a MAACS skill.

## Settle the design first

Create no file until the user tells you to write.

Learn the skill through conversation. Ask about:

- the tasks that the skill serves
- the phrasings that must reach it
- what it must refuse
- the mechanism that it drives
- the steps that the user performs by hand today

Ask a few questions at a time. Follow the user's answers instead of a fixed list.

Raise each open question when it appears. Resolve every question before you write. Make the routine decisions yourself, and give the user each decision that changes what the skill becomes.

Put such a decision to the user as a question. Do not present it as a default that you chose already. A user who reads a finished proposal approves choices that they never made.

If the request needs no skill, say so. One step that the model already performs is not a skill. A fact that belongs in project documentation is not a skill.

Propose the composition as part of the design. Name each supporting file that you intend to create, and give the reason for each one. An instruction file alone is a complete skill.

When no question remains, state what you are about to create. Then wait for the user's approval. Keep the statement short and conversational, and do not repeat it every turn.

### Propose a name

Offer two or three candidates. Let the user choose one.

Build each candidate as a noun phrase that names the capability, not the action. `ir-network-shaping` follows the pattern. `ir-shape-network` does not. Before you offer a candidate, check `skills/` for a collision. [references/conventions.md](./references/conventions.md) gives the naming rules.

## Write the skill

Write the instruction file first. Then write the supporting material that the design named.

Write for another agent. Include what is useful and not obvious to that agent, and leave out what the agent knows already. Before you write the first draft, read the other skills in the collection for the house voice.

Add a reference file, a message template, a script, or a directory of developer-owned material only where the skill needs one. Structure that the skill does not need costs context on every run.

## Apply the editorial pass

Invoke the `ir-editorial-pass` skill for the prose of the new skill.

- The README always takes the Simplified technical English flavor.
- For the instruction file and the reference files, ask the user which flavor to apply, and where to apply it.
- Prefer Simplified technical English when the user states no preference.
- Skip the pass when the user declines it.
- A script's code stays out of scope. The comment block and the help text of a script are prose.

If the pass cannot run, do not claim that it ran. Report the failed step, then ask the user how to proceed.

## Validate

Run `pnpm validate`. The command rewrites files in place, so run it after the skill is complete.

Two checks read the skill. The first check requires a valid version. The second check requires agreement between the instruction file and each directory of developer-owned material. Fix what a check reports, then run the command again.

## Record it in the catalog

Add a row to the skills catalog in the root `README.md`. The row holds the name, a one-line description, and a link to the skill's README. Add the extendable mark when the skill carries developer-owned material. Write the description in Simplified technical English.

When the new skill changes durable project context, use the `ir-living-docs` skill. A new convention that the briefs describe is such a change.

## Test on request

Testing is the user's decision. Offer it one time, after the files exist. If the user declines, do not raise it again. Raise it again only when the user asks for it.

When the user accepts:

1. Propose the strategy first, and keep it short. Name the paths to exercise, the fixtures to create, and the location of the sandbox.
2. Build the sandbox outside `skills/`, so repository validation does not read it. Choose the location that suits the skill.
3. Take the coverage from the decision points of the skill: each branch, each selectable reference, each refusal, and each precondition.
4. Write the harness and the mock files yourself. The subject is the behavior of the skill, not the CLI.
5. Report what passed and what failed. If a path fails, change the skill, not the test.

## Iterate

Continue to work with the user after the files exist. Treat each further request as a change to the skill. Discuss the change, then apply it. Repeat the editorial pass on the files that changed, then run validation again. The version stays at 1.

## Finish

Report the files that you created, the catalog row, and the documentation that you changed. Report the test results when tests ran. Do not paste a whole file into the conversation unless the user asks for it.
