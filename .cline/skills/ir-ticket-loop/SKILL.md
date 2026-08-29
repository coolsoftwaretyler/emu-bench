---
name: ir-ticket-loop
description: Work a repository's ticket directory to completion in a loop. Pick the next workable ticket by status and dependencies, implement it with a fresh Sonnet subagent, verify it, review the diff with an Opus subagent, then commit and continue until every ticket is done or parked. Use when the user asks to work the tickets, run the ticket loop, pick up the next ticket, work a named ticket, or burn down a backlog of ticket files. Do not use it for a remote issue tracker, because it reads ticket files inside the repository. Do not use it to rewrite git history.
metadata:
  version: 1
---

# Ticket loop

The session that runs this skill is the orchestrator. The orchestrator selects tickets, spawns subagents, acts on verdicts, commits, and keeps the ledger. The orchestrator never implements a ticket, never reads a diff, and never reads a source file. Each worker and each reviewer starts with fresh context, so the context cost of one ticket does not add to the next. That division keeps the loop token-efficient, and it keeps the review independent: the model that judges the work is not the model that produced the work.

A worker runs on Sonnet, and the reviewer runs on Opus. The escalation ladder below states the two exceptions.

## Preconditions

Check these before the first ticket. When one fails, stop and report it.

1. The repository is a git checkout, and the working tree is clean. Each ticket must produce an isolated diff and an isolated commit, and a dirty tree mixes the user's work into the first review. Do not stash the user's work to get a clean tree.
2. A ticket directory exists. Default to `tickets/`; the user can name another. The directory holds one Markdown file per ticket.
3. The agent can spawn subagents and choose a model per subagent (in Claude Code, the Agent tool). When the agent cannot, report the limitation. Then offer to work the tickets in this session, one at a time, without the model split.

## The ticket contract

The loop needs four things from a ticket file:

- A `**Status:**` line: `open` → `in progress` → `done`, with a date on done. This skill adds one more state: `parked — <reason> (<date>)`.
- A `**Depends on:**` line that names ticket ids, or states that nothing blocks the ticket.
- Acceptance criteria as Markdown checkboxes.
- A verification section with commands.

Read the ticket directory's README before the first ticket. Local rules there extend this contract, and they take precedence, because the repository owns its own process. A ticket that does not satisfy the contract is unworkable. Report it, then continue without it.

## Select a ticket

When the user named a ticket, work that ticket alone. When its dependencies are not done, say so and ask before you proceed.

When the user named no ticket, loop. A ticket is workable when its status is open and every dependency is done. When the README states an order, pick the first workable ticket in that order. When it does not, pick the workable ticket with the lowest id. When no ticket is workable and open tickets remain, stop and report what blocks each open ticket.

## Work a ticket

Spawn a fresh worker for the attempt. Fill [templates/worker-prompt.md](./templates/worker-prompt.md) and pass the result as the subagent's prompt. Run the worker in the foreground, because the loop is serial: the commit gate needs each result before the next ticket starts.

The worker implements the ticket, runs the verification commands, updates the ticket file, and reports back in at most 15 lines. The template states the full mandate. The worker does not commit, because the commit is the output of the review gate.

Start on Sonnet. When the ticket marks itself as high-risk, start on Opus instead, because one strong attempt costs less than a failed attempt plus an escalation.

When a worker needs something that only a human can supply — a password, hardware, an account, a credential — it reports `NEEDS ATTENTION` with the reason. Park the ticket and continue with the next one.

## Review the ticket

Spawn a fresh reviewer on Opus. Fill [templates/reviewer-prompt.md](./templates/reviewer-prompt.md) and pass the result as the prompt. Do not paste the ticket or the diff into the prompt: the reviewer has tools and reads both itself, and the orchestrator must not carry that context.

Act on the reviewer's final line alone.

- `VERDICT: approve` → commit.
- `VERDICT: revise` → follow the escalation ladder with the reviewer's findings.

## The escalation ladder

1. After the first `revise`, send the findings to the same worker as a continuation message. That worker already holds the context, and most findings are small.
2. After the second `revise`, spawn a fresh Sonnet worker with the findings. A worker that failed twice usually repeats its own approach.
3. After the third `revise`, spawn one Opus worker with the findings.
4. After the fourth `revise`, park the ticket.

Every attempt ends with a fresh review. The reviewer never continues across attempts: a fixed finding disappears, and an unfixed finding returns.

## Park a ticket

Parking preserves the work and lets the loop continue.

1. Run `git stash push -u -m "ir-ticket-loop: parked <id>"`. The stash preserves the attempt and keeps it out of the next ticket's diff.
2. Set the ticket status to `parked — <reason> (<date>)`, and commit that one-line edit as `<id>: park — <reason>`.
3. Record the stash name in the ledger.

The committed status prevents a later run from repeating a known failure. A human sets the status back to open to make the ticket workable again.

## Commit

After an approve verdict, stage the ticket's changes and commit as `<id>: <ticket title>`. When the host repository states its own commit conventions, follow them. Never amend, never rebase, never force-push: the history is the loop's audit trail, and some projects use commit timestamps as evidence.

Confirm that the tree is clean after the commit. A leftover file means that the worker changed something it did not report. Investigate before the next ticket.

## The ledger and the report

Keep one line per ticket in the conversation: id, outcome, review rounds, commit or stash. Do not keep more, because the ledger is all that the orchestrator carries between tickets.

The loop ends when no workable ticket remains. Report:

- each done ticket, with its commit
- each parked ticket, with its reason and its stash
- each blocked ticket, with the dependency that blocks it
- everything that needs the human, in one list they can act on
