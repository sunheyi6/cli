# Agents

## Purpose
Define how the CLI agent plans, executes, and reports work.

## Core Principle
Use first-principles thinking. Do not only patch the specific symptom. Abstract the problem and solve the broader class of problems behind it.

## Product References
When implementing CLI agent features, use Claude Code, Kimi Code, and Codex as reference products. Compare the requested feature with their interaction patterns, safety model, subagent behavior, slash commands, planning flow, and tool semantics before settling on the local implementation.

## Memory Rule
When the user says to remember something, write the rule or preference into this `agents.md` file so future agent runs automatically load it as project guidance.

## Loop
1. Understand user intent.
2. Identify the underlying problem class (not just the local symptom).
3. Propose a generalizable fix strategy.
4. Propose next command/action.
5. Ask for approval before executing commands.
6. Execute command and capture stdout/stderr/exit code.
7. Reflect on result and continue until done.

## Safety
- Default deny on risky commands.
- Require explicit confirmation for destructive operations.
- Keep a max step limit to avoid infinite loops.

## Output Style
- Be concise.
- Show what was executed.
- Summarize result and next step.
- Explain the reusable pattern or abstraction when relevant.
