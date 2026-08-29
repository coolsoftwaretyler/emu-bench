# Adapting an outside skill

Read this document together with [conventions.md](./conventions.md). The conventions define the target. This document covers the work of reaching that target from a skill that was written somewhere else.

## Contents

- Read the source first
- What always changes
- Generalize what is specific
- Where generalized content goes
- Scripts that need a dependency
- Documentation
- Keep the skill's judgment

## Read the source first

Read every file before you change anything. Learn what the skill does, which parts the user depends on, and which parts exist only because of where the skill was written.

Ask the user what they use the skill for, and ask what must survive the adaptation. An adaptation that removes the part the user valued is worse than no adaptation.

## What always changes

- The name takes the `ir-` prefix, and the frontmatter name matches the new directory name.
- `metadata.version` becomes 1, whatever version the source carried. The version is this collection's lifecycle signal, and it records nothing about the source.
- The frontmatter keeps the six fields of the Agent Skills specification. Remove a field that one agent alone reads, such as a field that controls invocation, arguments, or effort.
- Metadata from another ecosystem leaves the skill: a provider's interface file, a bundled license, a changelog, an installation guide.
- The layout maps onto the three forms of supporting material.
- The skill gains a MAACS README and a catalog row.

## Generalize what is specific

Examine every file for three kinds of specificity. Propose a general form for each finding, then let the user decide. Some findings are necessary to the skill, and only the user knows which ones.

- **Client-specific.** A client or product name, an internal host or URL, a bundle identifier, a repository path, a ticket prefix, a rule that belongs to one company's process, and the content of fixtures or sample output.
- **Machine-specific.** An absolute path that holds a username, a pinned tool version, a personal shell alias, a fixed port, and an assumption about installed software.
- **Provider-specific.** A frontmatter field that one agent reads, a tool name taken from one MCP server, an assumption that subagents exist, and an instruction that names one model.

### Client and confidential content

A MAACS skill installs into the projects of other clients, so content that identifies a client goes with it. Catch such content during the adaptation. The adaptation is the last point before the skill reaches another project.

Examine every file, not the instruction file alone. Comments, fixtures, sample output, and script defaults carry the same information.

Report each finding with the replacement that you propose. Let the user replace it, remove it, or generalize it. Do not delete such content silently. A real name sometimes makes an example clear, and the user knows what the client agreed to.

## Where generalized content goes

| The variable content is | Put it in |
| --- | --- |
| Known, finite, and owned by MAACS | one reference file for each option, with a registry in the instruction file |
| Supplied for each project, and owned by the developer | a directory of developer-owned material with `template.md`, plus a way for the skill to find each file, such as a registry entry or a fixed file name |
| Particular to one machine | a check at run time, or a question to the user |
| A mechanism that must not vary | a script |

Prefer a check at run time when the machine can answer the question. Prefer a question to the user when a wrong default costs the user something.

## Scripts that need a dependency

Read what the script requires before you judge its language. The limit is the dependency, not the language.

A script that runs on shell, Node, or Python 3 alone can stay as it is. A script that needs an install step, a package, or another runtime such as tsx, Bun, or Deno needs one of two changes. Rewrite it for what the target machine provides, or take it out of the skill and let the instruction file describe the work. Propose one of the two, and give the reason.

## Documentation

An imported skill arrives without a MAACS README. Write one from what the skill does now, not from the source's own documentation.

## Keep the skill's judgment

Adapt the shape, not the substance. A skill that reads as a bare checklist after the adaptation lost what made it work. Where the source explains why a step exists, keep the explanation.
