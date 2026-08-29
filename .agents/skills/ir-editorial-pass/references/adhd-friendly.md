# ADHD-friendly

This flavor organizes human-facing prose so the reader can quickly find the current state, the next action, the relevant constraints, and the visible outcome. It reduces restart cost after distraction without assuming that the reader needs less detail, a simpler tone, or a particular diagnosis.

## What this flavor assumes about reading

Every rule below follows from five conditions:

- Anything not on screen is unavailable. Prose that says "keep in mind X" has already lost X.
- Knowing the answer and acting on it are separate steps. Text that explains without naming an action stops at the first.
- Starting costs the most. The first action carries disproportionate weight.
- Vague durations do not register. "Some work" and "a few hours" read identically.
- Progress registers only when visible. A win inside a recap is not one.

## Lead with what matters

- Start with the answer, result, or first action. Put background after it only when the background helps the reader act.
- When the reader must do something, make the first line a small, concrete action they can begin now.
- When a command, path, link, or snippet is the answer, put it first and add prose after it only when the prose is necessary. When it belongs to a specific step, keep it with that step.
- State the specific object and desired result. Do not begin with a vague invitation to think, explore, review, or get started.
- Remove preambles that announce the response instead of giving it ("Let me...", "I'll...", "To answer your question...").

## Shape work into bounded steps

- Use a numbered list for work with more than one step.
- Give each step one bounded action. No step contains _and then_ twice.
- Use the fewest steps that still let the reader complete the work safely.
- Keep a flat list to five items or fewer. When more work is necessary, group it by priority, phase, or "do now" versus "later."
- Put required actions before optional improvements. Clearly label an alternative or optional path.
- Keep prerequisites with the step that needs them instead of leaving them in a distant paragraph.

## Make state and progress visible

- State what is complete, what changed, and what remains in direct language.
- For an unfinished task, end with one concrete next action when one exists. Size it so the reader can start immediately; "open the file" qualifies.
- For a completed task, state the usable outcome and stop. Do not add a generic invitation or recap.
- A turn that continues earlier work opens with the current step and the next one, rather than relying on the reader to remember either.
- Use a step count only when it makes progress easier to judge. Do not manufacture a plan just to show a count.
- Give a concrete time estimate when a supported estimate is useful. Include the condition behind a range or estimate.
- An estimate, completion claim, or confidence level with nothing behind it is a factual defect, not a formatting one.
- The first and last lines, read alone, carry the next action and what changed.

## Keep attention on the task

- Finish the primary issue before introducing a secondary one.
- Separate an additional issue with a clear label such as _Separately_ or _Later_. Do not bury it in a "by the way" aside.
- A question answerable from the work itself appears answered, not asked. Only one unresolved question appears, and only when it blocks progress.
- Present choices in ranked order when the reader asks for options. Give a short trade-off for each choice and make the recommendation clear.
- Use headings that let the reader return to a specific part of a longer explanation.
- Keep necessary context near the decision or action it supports.

## Use direct, matter-of-fact language

- State an error as the failure, its established cause, and the available fix or next action. Do not add alarm, apology, or vague reassurance.
- Preserve real uncertainty, but remove hedging that adds no information ("perhaps," "could possibly"). Deleting a hedge that carries real uncertainty manufactures confidence.
- Replace idioms, figurative phrases, and motivational slogans with the literal action or fact ("circle back," "get the ball rolling," "on the same page").
- Remove canned acknowledgments ("Great question," "Looking at your..."), promises to help, self-narration, recaps of completed work ("I've now done X, Y, and Z, which means..."), and generic closing pleasantries ("Hope this helps," "Feel free to ask").
- Do not turn a concise answer into a terse one. Retain the facts, safety conditions, and explanation the reader needs.
- Use neutral, respectful language. Do not make assumptions about the reader's ability, focus, or medical history.

## Balance and safety

- When a rule here would remove the answer itself, the answer stays and the shape yields.
- Keep confirmation, warnings, and full context for destructive, irreversible, or safety-sensitive actions.
- Keep a detailed explanation detailed when the user asks to learn, compare, or troubleshoot. Make it skimmable with headings and bounded sections.
- Preserve required formatting, legal wording, quotations, code, commands, and technical details.
- Do not remove a condition, exception, or dependency merely to make the answer shorter.
- A short clarifying question replaces a guess when the ambiguity would make the next action unsafe or incorrect.

## Examples

| Pattern | Less accessible | ADHD-friendly |
| --- | --- | --- |
| Lead with the action | "I changed the setting. You should now run the test." | "Setting changed. Next: run the test." |
| Bounded steps | "Open `config.ts`, set `retryLimit` to 3, save the file, and run the test." | "1. Open `config.ts`.<br>2. Set `retryLimit` to 3.<br>3. Save the file.<br>4. Run the test." |
| Visible state | "The schema is updated, and the next thing is to backfill the column." | "Schema updated. Next: backfill the column." |
| Concrete estimate | "This task takes about 15 minutes when tests already cover the change." | "Estimate: 15 minutes if tests already cover the change." |
| Tangent isolation | "Fix the failing test. By the way, the dependency is out of date." | "Fix the failing test.<br><br>Separately: the dependency is out of date." |
| Direct error | "Oh no, the upload failed because the token is missing." | "Upload failed: token is missing." |
| Literal wording | "Let's get the ball rolling on the migration." | "Start the migration." |
| Stop when complete | "The report is ready. Let me know if you need anything else." | "The report is ready." |
