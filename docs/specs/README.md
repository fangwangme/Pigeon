# Specs
Specs describe what the system does and why. They are the standard every change is written and reviewed against.

## What a spec holds
- Behavior callers and users observe, including which errors are expected and how each surfaces.
- Interfaces and data shapes other code depends on.
- Trust boundaries: where outside input enters and is validated.
- Decisions with their reasons, including rejected alternatives worth remembering.

Not implementation steps, dated history, or counts that change with every edit.

## Naming
Name specs by module, feature area, or long-lived product surface. Do not prefix spec files with dates: `module-or-feature-name.md`

## Workflow
A behavior change updates the spec first, in the same branch as the code. A bug fix cites the clause the code violates. A spec is written for the area a change first touches; no area needs one before that. Plans, research, and review notes live in `.agents/`.
