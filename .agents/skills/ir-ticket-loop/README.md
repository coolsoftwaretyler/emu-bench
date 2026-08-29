# ir-ticket-loop

This skill works a repository's ticket files to completion in a loop. It picks the next workable ticket, and a Sonnet subagent implements it. An Opus subagent reviews the change. The skill commits approved work and continues until every ticket is done or parked. You get one commit per ticket and a report at the end.

## When to use it

Use this skill when a repository carries a directory of ticket files and you do not want to supervise each one:

- work the tickets
- pick up the next ticket
- work ticket T05
- burn down the backlog

Do not use it for a remote issue tracker, because it reads ticket files inside the repository. Do not use it in a repository without ticket files.

## How to use it

Ask your agent to run the skill:

> Use the ir-ticket-loop skill on tickets/.

The skill checks that the working tree is clean, reads your ticket directory's README for local rules, and then loops. For each ticket, a fresh Sonnet subagent implements and verifies, and an Opus subagent reviews the diff against the acceptance criteria. Rejected work receives up to three more attempts: two on Sonnet, then one on Opus. After that, the skill parks the ticket.

A ticket file needs four things: a status line, a dependency line, acceptance checkboxes, and verification commands. Rules in your ticket directory's README extend that contract and take precedence over it.

A parked ticket keeps its attempt in a named git stash, and its status line records the reason. To retry a parked ticket, set its status back to open.

## What it produces

- One commit per completed ticket, with the ticket file's checkboxes and status updated with evidence.
- A parked status and a named stash for each ticket the loop gave up on.
- A final report: done, parked, and blocked tickets, plus everything that needs a human.

## Notes

- The loop never amends, rebases, or force-pushes. The history is its audit trail.
- It needs an agent that can spawn subagents and choose a model per subagent, such as Claude Code. Without that, it offers to work the tickets in the main session instead.
- The skill stops when the working tree is dirty. It does not stash your work. Start it on a clean tree.
