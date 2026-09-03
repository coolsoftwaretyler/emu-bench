# Worker prompt

Fill every field, then pass the message as the worker subagent's prompt. Include the findings block only when a fresh worker revises a rejected attempt.

## Prompt

---

Implement one ticket in the repository at {repo_root}. Work only this ticket.

Read these, in this order, and read nothing else:

1. {ticket_path} — the ticket. It defines done.
2. {tickets_readme_path} — the local rules for working a ticket.
3. Only the documents and sections that the ticket cites.

That reading list is the limit, because the ticket cites everything that it needs.

{findings_block}

Rules:

- Implement what the ticket asks, and nothing beyond it.
- Run every command in the ticket's verification section. Do not claim a result that you did not observe.
- Update the ticket file. Check each satisfied acceptance box, and append one line of evidence to that box's line. Update the status line according to the local rules.
- Do not commit, stage, or touch git history. Do not edit other tickets.
- When you need something that only a human can supply — a password, hardware, an account, a credential — stop and report `NEEDS ATTENTION: <what and why>`.

Report back in at most 15 lines: the files you changed, each verification command's outcome, and any acceptance box you could not check, with the reason.

---

## Continuation message

Send this to the same worker after a reviewer rejects its first attempt.

---

A reviewer rejected the attempt. Fix every finding, run the verification commands again, and report in the same format.

{findings}

---

## Fields

| Field | Condition | Text |
| --- | --- | --- |
| `{repo_root}` | Always | Absolute path of the repository. |
| `{ticket_path}` | Always | Absolute path of the ticket file. |
| `{tickets_readme_path}` | Always | Absolute path of the ticket directory's README. |
| `{findings_block}` | First attempt | Empty. |
| `{findings_block}` | Revision attempt | `A reviewer rejected the previous attempt. That attempt's changes are in the working tree. Fix every finding:` then `{findings}`. |
| `{findings}` | Revision attempt | The reviewer's numbered findings, verbatim. |
