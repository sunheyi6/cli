# suncli-ts

Terminal-native TypeScript CLI agent, inspired by [pi](https://github.com/earendil-works/pi-coding-agent) and kimi-code.

## Features

- **Interactive TUI chat** — powered by `@mariozechner/pi-tui`
- **Streaming responses** — real-time token output with thinking/reasoning display
- **Code formatting** — auto-formats output code blocks via Prettier (21 languages including Java)
- **Skills system** — loads `.agents/skills/` compatible with the Agent Skills standard, auto-trigger + manual `/skill:name` commands
- **Slash commands** — `/help`, `/clear`, `/exit`, `/agents`, `/tools`, `/rules`, `/skills`, plus skills as first-class commands
- **Input history** — up/down key navigation through chat history
- **Sub-agents** — `explorer` (read-only), `planner` (task decomposition), `worker` (local implementation)
- **Plan mode** — agent-managed task planning
- **Visual separators** — per-turn dividers between Q&A pairs

## Quick Start

```bash
# Install
git clone https://github.com/sunheyi6/cli.git
cd cli
npm install

# Configure API key
npm run dev
# Enter your DeepSeek API key when prompted, or set DEEPSEEK_API_KEY env var

# Or configure in file
npx tsx src/index.ts config set --api-key sk-your-key
```

## CLI Commands

```bash
suncli-ts              # Start interactive chat
suncli-ts hello        # Say hello
suncli-ts run <cmd>    # Run a local command
suncli-ts config show  # Show current config
suncli-ts config set   # Set config fields
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all slash commands |
| `/clear` | Clear session context |
| `/exit` | Quit session |
| `/agents` | List built-in sub-agents |
| `/tools` | List available tools |
| `/rules` | Check if agents.md is loaded |
| `/skills` | List available skills |

Skills are first-class slash commands — type `/` to fuzzy-search all commands including skills.

## Skills

Place skill directories in `.agents/skills/` (project) or `~/.agents/skills/` (global):

```
.agents/skills/my-skill/
├── SKILL.md    # Frontmatter (name + description) + instructions
├── scripts/
└── references/
```

Compatible with [Agent Skills standard](https://agentskills.io) — reuse skills from Claude Code, Codex, or pi.

## Agent Tools

The agent uses JSON actions:

| Action | Description |
|--------|-------------|
| `read` | Read file contents |
| `write` | Create or overwrite files |
| `edit` | Precise text replacement |
| `bash` | Execute terminal commands |
| `task` | Dispatch sub-agent |
| `plan` | Declare/update task plan |
| `final` | Return final answer |

## Configuration

Config stored at `~/.suncli/config.json`:

```json
{
  "model": "deepseek-chat",
  "apiBaseUrl": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "apiKey": "sk-..."
}
```

## Design Philosophy

- **Less is more** — no intent classification, no client-side plan auto-advance. The agent decides.
- **No confirmation dialogs** — all tools execute directly. Safety is the user's responsibility.
- **Pi-compatible skills** — reuse your existing skill ecosystem.

## License

MIT
