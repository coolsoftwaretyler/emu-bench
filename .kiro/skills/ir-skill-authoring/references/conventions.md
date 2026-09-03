# MAACS skill conventions

## Contents

- What the repository enforces
- The name
- The frontmatter
- The description
- Composition
- References and the registry pattern
- Developer-owned material
- Scripts
- A skill that changes the machine
- The README and the catalog
- Writing the instructions

## What the repository enforces

Validation enforces the name and the version. Everything after those two is convention.

- **The name.** Lowercase letters, digits, and hyphens, at most 64 characters, and the `ir-` prefix. The frontmatter name equals the directory name. The Agent Skills specification requires that match, and the CLI reads the prefix to know which installed copies it manages.
- **The version.** `metadata.version` holds a whole number of 0 or greater. A new skill ships version 1, and the version stays at 1 while you author the skill. The version is the CLI's lifecycle signal, not a changelog.

One further check applies only to a skill that ships developer-owned material. The Developer-owned material section states that check.

Weigh the rest of this document against the skill that you are writing. A convention that the skill does not need is not a requirement. Structure is not a mark of quality, and an instruction file with no supporting material is a complete skill.

## The name

Build the name as a noun phrase that names the capability. Each name in the collection names a capability, and no name in the collection names an action.

| Name                 | Shape               |
| -------------------- | ------------------- |
| `ir-editorial-pass`  | adjective plus noun |
| `ir-living-docs`     | participle and noun |
| `ir-network-shaping` | noun plus gerund    |

Use as many words as the capability needs. A short name is easier to say and to type. A longer name triggers more reliably when the capability is narrow. Propose the name that fits the skill.

Avoid a verb-led name such as `ir-shape-network`. Avoid a vague name such as `ir-helper`.

Three other names follow from the skill name:

- The heading of the instruction file is the name without the prefix, in sentence case, such as `# Network shaping`.
- The heading of the README is the full name, such as `# ir-network-shaping`.
- Each file name inside the skill uses kebab-case.

The prefix also marks the skill as MAACS-managed. Eject takes a skill out of lifecycle management when it removes or replaces the prefix, so the prefix carries more than ownership.

## The frontmatter

Use `name`, `description`, and `metadata.version`. Add no other field.

The Agent Skills specification defines six fields: `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`. Keep to those six fields. A field that one agent alone reads breaks portability, and MAACS installs the same skill into the directories of many providers.

## The description

The name and the description are the only parts of a skill that are always in context, and the description decides whether the skill triggers. The description competes with every other installed skill, so make it specific.

Write it in three parts, in this order:

1. What the skill does, in the imperative. Name the mechanism when the mechanism matters.
2. When to use the skill. Name the phrasings and the situations that must reach it.
3. What the skill must not be used for. Give the reason when the reason is short.

Two descriptions from the collection show the pattern:

- `Apply a selected editorial flavor to prose, documentation, or human-facing messages. Use when the user asks for an editorial pass ... Do not use for code changes.`
- `Degrade this Mac's network with pfctl and dnctl, so you can test an app on a bad network. Use it when the user asks to throttle the network ... Do not use it for a physical phone, because its traffic does not transit this Mac.`

The published Agent Skills guidance asks for the third person. This collection uses the imperative, because its prose follows Simplified technical English. Follow the collection.

Keep the description under 1024 characters. Keep every statement about when to use the skill in the description. The body reaches the agent only after the skill triggers.

## Composition

The instruction file is the only required file. Supporting material takes three forms, and each form has a purpose:

- `references/` holds MAACS-owned context that the instruction file does not need on every run. The agent reads a reference file when a task selects it. A reference file therefore keeps the instruction file short, and it loads only what the work needs.
- `templates/` holds fixed message text, so output stays consistent where the exact wording matters.
- `scripts/` holds the mechanism. A script fits when an operation must be deterministic, when the agent writes the same code on every run, or when a person or a job must run the operation without an agent.

The collection is flat. It holds one directory for each skill, and it supports no grouping directory.

Keep the instruction file under 500 lines, and split it when it grows past that limit. Name each reference file from the instruction file, and state the condition that selects it. The agent then knows that the file exists and when the file applies.

Keep every reference file one level from the instruction file. An agent that finds a nested chain of references often previews each file instead of reading it, and the agent then works from partial information.

## References and the registry pattern

When a skill supports a set of known options that MAACS owns, give each option its own reference file. Then register the set in the instruction file.

`ir-editorial-pass` is the example. Its instruction file holds the registry and the selection rules, and it reads one flavor file after the user chooses. The registry makes every option visible at a low cost, and the skill loads only the selected option.

Give a reference file longer than 100 lines a contents list at the top. A preview then shows the full scope of the file.

## Developer-owned material

A shared skill sometimes needs content that only the installing project supplies, such as a tone that suits one client. A directory named `extensions` holds that content, at the level where the material belongs. The name is reserved.

- Ship `template.md` inside the directory, so the developer sees the form of the file to add. `.gitkeep` serves a directory that ships no template.
- Let the developer's file reach the skill. The skill's own design decides how; a registry entry in the MAACS-owned instruction file is one way. The skill's README gives the developer the steps.
- Mark the skill as extendable in the catalog.

Validation applies two rules. An instruction file that names an `extensions` path must ship such a directory. A shipped directory must hold `.gitkeep` or `template.md`.

Watch one consequence of the first rule. Validation reads the instruction file alone, and every mention of the path counts. A mention that only explains the pattern counts as well. Keep such an explanation in a reference file when the skill itself ships no such directory.

An update keeps the developer's files, and it replaces the files that MAACS owns. Removal deletes the whole skill directory, and the deletion includes the developer's files.

## Scripts

An installed skill runs on a machine that may hold neither the MAACS checkout nor its dependencies. A script therefore uses only what the machine provides already. It installs nothing, it resolves no dependency, and it reaches into no checkout.

Two languages meet that limit on a developer's Mac:

- Shell, without a feature that the default macOS shell lacks. macOS ships an old default shell.
- Node, without anything outside its standard library.

Python 3 meets the limit as well, when the script uses no third-party package. On macOS, Python 3 depends on the Xcode command line tools.

A tool that the machine may not hold stays out of a skill: tsx, Bun, Deno, and a package manager. A script that needs an install step stays out for the same reason.

Choose the language that the mechanism needs. Prefer shell for work on the operating system, such as a network command or process control. Prefer Node where the work reads or transforms structured data, because shell makes that work awkward.

A script owns the mechanism, and the instruction file owns the judgment. Let the script serve a person at a terminal or an automated job directly. Work that does not need an agent must not require one.

## A skill that changes the machine

State the effect before you act. Leave a recovery path that does not depend on the agent, because the same change can make the agent unreachable. The machine must return to its normal state without further instruction.

A skill takes administrator rights only when its task requires them. Two conditions apply.

The agent never receives the password, because the conversation and the provider's logs keep what the agent reads. The skill raises privilege one time for the whole task, through a desktop dialog that names the task. Sudo remembers an approval for each process, so a script that elevates at each step asks the developer at each step.

`ir-network-shaping` holds the reference implementation of this pattern. Its `with-sudo.sh` is written for another skill to copy.

## The README and the catalog

Every skill carries a `README.md` for a developer, in Simplified technical English. It holds an introduction, When to use it, How to use it, What it produces, and an optional Notes section. No provider reads it, so it changes nothing about discovery.

The catalog row in the root `README.md` holds the name, a one-line description, a link to the skill's README, and the extendable mark. The detail stays in the skill's own README.

## Writing the instructions

- Assume that the model is capable. Add only what the model does not have already. Each paragraph shares the context window with the conversation, so each paragraph must justify its cost.
- Explain why a rule exists. Do not make the wording stronger instead. A model that knows the reason handles the case that the instructions do not describe, and a capitalized demand is usually a sign of a missing reason.
- Match the freedom that you give to the fragility of the task. Give an exact command where a mistake is expensive and the sequence is fixed. Give direction alone where several routes reach the same result.
- Use one term for one thing throughout the skill.
- Leave out what dates. Describe the current method, and keep a superseded method in its own section when it still matters.
- Use forward slashes in every path.
- Give one default instead of a list of options, and name the exception where one exists.
- State whether the agent runs a script or reads it.
