---
name: ce-slack-research
description: "Search Slack for interpreted organizational context -- decisions, constraints, and discussion arcs -- and produce a synthesized research digest with cross-cutting analysis. Use when the user says 'search slack for', 'what did we discuss about', 'slack context for', or 'what does the team think about'. Differs from slack:find-discussions, which returns raw message results without synthesis."
---
<!-- ce-deplugin:convention -->
## Self-contained persona dispatch (no `agents/` directory)

This skill is self-contained: its specialist personas live under `references/personas/` and it depends on **no** registered subagent and **no** `agents/` directory.

Whenever the steps below name a `ce-*` specialist — e.g. `Task ce-<specialist>(args)`, "dispatch `ce-<specialist>`", or a persona-catalog entry:
1. Read `references/personas/<name>.md`.
2. Launch a subagent via the Task/Agent tool, passing that file's **entire contents as the subagent's instructions**, then append the specific args/context the step gives.
3. `subagent_type`: use **`Explore`** if the persona's "Operating constraints" line says read-only; otherwise **`general-purpose`**.
4. Honor the persona's "Operating constraints" line in your instruction to the subagent (tool/model limits are NOT otherwise enforced once de-plugin-ified).
Dispatch independent personas in parallel from the **main thread**; personas never spawn further subagents.



# /ce-slack-research

Search Slack for organizational context and receive an interpreted research digest.

## Usage

```
/ce-slack-research [topic or question]
/ce-slack-research
```

## Examples

```
/ce-slack-research free trial
/ce-slack-research What did we say about free trial recently?
/ce-slack-research free trial in #proj-reverse-trial
/ce-slack-research onboarding flow after:2026-03-01
```

The input can be a keyword, a natural language question, or include Slack search modifiers like channel hints (`in:#channel`) and date filters (`after:YYYY-MM-DD`). The agent extracts the topic and formulates searches from whatever form the input takes.

## Execution

If no argument is provided, ask what topic to research. Use the platform's blocking question tool: `AskUserQuestion` in Claude Code (call `ToolSearch` with `select:AskUserQuestion` first if its schema isn't loaded), `request_user_input` in Codex, `ask_user` in Gemini, `ask_user` in Pi (requires the `pi-ask-user` extension). Fall back to asking in plain text only when no blocking tool exists in the harness or the call errors (e.g., Codex edit modes) — not because a schema load is required. Never silently skip the question.

Dispatch `ce-slack-researcher` with the user's topic as the task prompt. Omit the `mode` parameter so the user's configured permission settings apply.

The agent handles everything from here -- Slack MCP discovery, search execution, thread reads, and synthesis. It returns a digest with:

- **Workspace identifier** so the user can verify the correct Slack instance was searched
- **Research-value assessment** (high / moderate / low / none) with justification
- **Findings organized by topic** with source channels and dates
- **Cross-cutting analysis** surfacing patterns across findings

If the agent reports that Slack is unavailable (MCP not connected or auth expired), relay the message to the user. Do not attempt alternative research methods.
