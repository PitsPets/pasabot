---

name: skill-author
description: "Use when the owner asks you to turn a way of working into a reusable skill, or to improve a skill you made earlier."
---

# Writing a skill

A skill is a short playbook another run of you (or another agent) can follow without this conversation. Write it
for a reader who is capable but has none of today's context.

## 1. Agree on the job

Ask, or work out from the conversation:

- When should the skill be used? This becomes the one-line `description`. Start it with "Use when ...".
- What does a good result look like? Collect one real example if the owner has one.
- What must never happen? Write these as plain rules.

## 2. Draft

- `name`: lowercase words joined by single dashes, at most 64 characters (`supplier-quotes`).
- Instructions in markdown: a few numbered steps, then the rules, then one short example. Prefer concrete checks
  ("totals match the sum of the lines") over adjectives ("be careful").
- Keep it under about 300 lines. Put long reference material in an extra file (for example `reference/terms.md`)
  and say in the steps when to read it.
- Never put passwords, keys or personal data in a skill. Refer to a secret by its vault name instead.

## 3. Save it

- New skill: call `skills_create` with the name, description, instructions and any extra files. The owner is
  asked first. The skill is switched on for you only; the owner decides who else gets it.
- Improving one you made: call `skills_revise`. Every save is a new revision and the old ones are kept, so the
  owner can roll back.
- You can only change skills you made. For anything else, describe the change to the owner.

## 4. Check

Read it back with `skills_read`, then try it once on a small real case and tell the owner what you changed.
