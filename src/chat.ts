#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Fuse from "fuse.js";
import chalk from "chalk";
import * as prettier from "prettier";
import prettierPluginJava from "prettier-plugin-java";
import {
  TUI,
  ProcessTerminal,
  Container,
  Text,
  Markdown,
  Editor,
  Spacer,
  SelectList,
  Input,
  matchesKey,
  Key,
  truncateToWidth,
  CombinedAutocompleteProvider,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
  type SelectItem,
} from "@mariozechner/pi-tui";
import { getConfigPath, loadConfig, saveConfig } from "./config.js";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type AgentAction =
  | { type: "final"; answer: { summary: string; blocks?: Array<{ kind: "text" | "code"; content: string; language?: string }> } }
  | { type: "plan"; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { type: "read"; path: string; reason?: string }
  | { type: "write"; path: string; content: string; reason?: string }
  | { type: "edit"; path: string; search: string; replace: string; reason?: string }
  | { type: "bash"; command: string; args?: string[]; reason?: string }
  | { type: "task"; agent?: SubagentName; prompt: string; description?: string };

type AgentTurnResult = {
  type: "final" | "max_steps";
  summary: string;
  blocks: Array<{ kind: "text" | "code"; content: string; language?: string }>;
  steps: number;
};
type SkillMeta = { name: string; description: string; path: string };

type AgentMode = "answer" | "inspect" | "write";
type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" };
type SlashCommandResult = { type: "handled" } | { type: "exit" } | { type: "not_slash" } | { type: "skill_loaded" } | { type: "skill_with_task" } | { type: "fill_editor"; text: string };
type SubagentName = "explorer" | "planner" | "worker";
type SlashCommand = { name: string; description: string; aliases: string[]; kind: "builtin" | "skill"; skillPath?: string };
type SlashCommandMatch = { command: SlashCommand; score: number };

const BUILTIN_COMMANDS: Omit<SlashCommand, "kind">[] = [
  { name: "help", description: "显示可用斜杠命令", aliases: ["h", "?"] },
  { name: "clear", description: "清空当前会话上下文", aliases: ["cls", "reset"] },
  { name: "exit", description: "退出会话", aliases: ["quit", "q"] },
  { name: "agents", description: "查看内置子智能体", aliases: ["agent", "subagents"] },
  { name: "tools", description: "查看可用工具", aliases: ["tool"] },
  { name: "rules", description: "查看 agents.md 是否已加载", aliases: ["rule"] },
  { name: "skills", description: "列出所有可用技能", aliases: ["skill"] },
];

function buildSlashCommands(skills: SkillMeta[]): { commands: SlashCommand[]; warnings: string[] } {
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  const commands: SlashCommand[] = BUILTIN_COMMANDS.map((c) => ({ ...c, kind: "builtin" as const }));
  const warnings: string[] = [];

  for (const skill of skills) {
    let name = skill.name;
    if (builtinNames.has(name)) {
      name = `skill-${name}`;
      warnings.push(`技能 "${skill.name}" 与内置命令冲突，已重命名为 /${name}`);
    }
    builtinNames.add(name);
    commands.push({
      name,
      description: skill.description,
      aliases: [],
      kind: "skill",
      skillPath: skill.path,
    });
  }

  return { commands, warnings };
}

let slashCommands: SlashCommand[] = BUILTIN_COMMANDS.map((c) => ({ ...c, kind: "builtin" as const }));
let slashFuse = new Fuse(slashCommands, { keys: ["name", "aliases", "description"], threshold: 0.45, includeScore: true });

function searchSlashCommands(query: string): SlashCommandMatch[] {
  const normalized = query.trim().replace(/^\//, "").toLowerCase();
  if (!normalized) {
    return slashCommands.map((command) => ({ command, score: 1 }));
  }
  return slashFuse.search(normalized)
    .map((result) => ({
      command: result.item,
      score: 1 - (result.score ?? 1),
    }))
    .sort((a, b) => b.score - a.score || a.command.name.length - b.command.name.length);
}

function findExactSlashCommand(input: string): SlashCommand | null {
  const query = input.slice(1).trim().toLowerCase();
  if (!query) return null;
  for (const cmd of slashCommands) {
    if ([cmd.name, ...cmd.aliases].includes(query)) return cmd;
  }
  return null;
}

function renderSlashHelp(): string {
  const lines: string[] = ["commands>"];
  for (const cmd of slashCommands) {
    const prefix = cmd.kind === "skill" ? "📦 " : "";
    lines.push(`${prefix}/${cmd.name.padEnd(11)} ${cmd.description.slice(0, 55)}`);
  }
  return lines.join("\n");
}

async function pickSlashCommandTui(tui: TUI, matches: SlashCommandMatch[]): Promise<SlashCommand | null> {
  if (matches.length === 0) return null;

  const visible = matches.slice(0, 8);
  const items: SelectItem[] = visible.map((m) => ({
    value: m.command.name,
    label: `${m.command.kind === "skill" ? "📦 " : ""}/${m.command.name}`,
    description: m.command.description,
  }));

  const theme: SelectListTheme = {
    selectedPrefix: (s) => chalk.cyan(s),
    selectedText: (s) => chalk.cyan(s),
    description: (s) => chalk.gray(s),
    scrollInfo: (s) => chalk.gray(s),
    noMatch: (s) => chalk.red(s),
  };

  return new Promise((resolve) => {
    const list = new SelectList(items, visible.length, theme);
    const handle = tui.showOverlay(list, {
      anchor: "center",
      width: Math.min(50, tui.terminal.columns),
    });

    list.onSelect = (item) => {
      handle.hide();
      const cmd = visible.find((m) => m.command.name === item.value)?.command ?? null;
      resolve(cmd);
    };
    list.onCancel = () => {
      handle.hide();
      resolve(null);
    };

    handle.focus();
  });
}

async function handleSlashCommand(
  input: string,
  history: ChatMessage[],
  projectRules: string,
  tui: TUI,
  messagesContainer: Container,
): Promise<SlashCommandResult> {
  if (!input.startsWith("/")) {
    return { type: "not_slash" };
  }

  const exactCommand = findExactSlashCommand(input);
  const matches = searchSlashCommands(input);
  if (matches.length === 0) {
    return { type: "handled" };
  }

  const command = exactCommand ?? (await pickSlashCommandTui(tui, matches));
  if (!command) return { type: "handled" };

  // Skill picked from fuzzy picker (no exact match) → fill editor for task input
  if (!exactCommand && command.kind === "skill" && command.skillPath) {
    return { type: "fill_editor", text: `/${command.name} ` };
  }

  // Skill with exact match (/skillname or /skillname task) → load and execute
  if (command.kind === "skill" && command.skillPath) {
    try {
      const content = readFileSync(command.skillPath, "utf8");
      history.push({ role: "system", content: `技能指令已加载 (${command.name}):\n\n${content}` });
      addMessage(messagesContainer, `📦 已激活技能: ${command.name}`, "system");
      const taskMatch = input.match(new RegExp(`^/${command.name}\\s+(.+)$`, "i"));
      if (taskMatch) {
        history.push({ role: "user", content: taskMatch[1] });
        return { type: "skill_with_task" };
      }
      return { type: "skill_loaded" };
    } catch {
      addMessage(messagesContainer, `无法读取技能文件: ${command.skillPath}`, "error");
      return { type: "handled" };
    }
  }

  if (command.name === "help") {
    addMessage(messagesContainer, renderSlashHelp(), "system");
    return { type: "handled" };
  }
  if (command.name === "clear") {
    history.splice(1, history.length - 1);
    addMessage(messagesContainer, "会话上下文已清空。", "system");
    return { type: "handled" };
  }
  if (command.name === "exit") {
    return { type: "exit" };
  }
  if (command.name === "agents") {
    addMessage(messagesContainer, "explorer（只读探索）, planner（任务拆解）, worker（局部实现）", "system");
    return { type: "handled" };
  }
  if (command.name === "tools") {
    addMessage(messagesContainer, "read, write, edit, bash, task, plan", "system");
    return { type: "handled" };
  }
  if (command.name === "rules") {
    addMessage(messagesContainer, projectRules ? "agents.md 已加载" : "未发现 agents.md", "system");
    return { type: "handled" };
  }
  if (command.name === "skills") {
    const skillCmds = slashCommands.filter((c) => c.kind === "skill");
    if (skillCmds.length === 0) {
      addMessage(messagesContainer, "未发现任何技能。将 SKILL.md 放入 .agents/skills/ 目录即可。", "system");
    } else {
      const lines = [`skills (${skillCmds.length})>`];
      for (const s of skillCmds) {
        lines.push(`  /${s.name.padEnd(30)} ${s.description.slice(0, 50)}`);
      }
      addMessage(messagesContainer, lines.join("\n"), "system");
    }
    return { type: "handled" };
  }

  return { type: "handled" };
}

function loadProjectRules(): string {
  const rulesPath = join(process.cwd(), "agents.md");
  if (!existsSync(rulesPath)) {
    return "";
  }
  return readFileSync(rulesPath, "utf8").trim();
}

function formatProjectRules(rules: string): string {
  if (!rules) {
    return "";
  }
  return `\n\n项目规则（来自 agents.md，必须遵守）：\n${rules}`;
}

async function askDeepSeek(messages: ChatMessage[]): Promise<string> {
  const cfg = loadConfig();
  const key = process.env[cfg.apiKeyEnv] ?? cfg.apiKey;
  if (!key) {
    return `未找到 API Key，请先设置环境变量 ${cfg.apiKeyEnv}，或启动时按提示输入。`;
  }

  const response = await fetch(`${cfg.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.3,
      stream: false,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return `请求失败: ${response.status} ${response.statusText}\n${detail}`;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };

  return data.choices?.[0]?.message?.content?.trim() || "模型没有返回内容。";
}

type StreamCallbacks = {
  onThinking?: (chunk: string, fullText: string) => void;
  onContent?: (chunk: string, fullText: string) => void;
};

type StreamResult = {
  reasoning: string;
  content: string;
};

async function askDeepSeekStream(
  messages: ChatMessage[],
  callbacks?: StreamCallbacks,
): Promise<StreamResult> {
  const cfg = loadConfig();
  const key = process.env[cfg.apiKeyEnv] ?? cfg.apiKey;
  if (!key) {
    const msg = `未找到 API Key，请先设置环境变量 ${cfg.apiKeyEnv}，或启动时按提示输入。`;
    return { reasoning: "", content: msg };
  }

  const response = await fetch(`${cfg.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.3,
      stream: true,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    const msg = `请求失败: ${response.status} ${response.statusText}\n${detail}`;
    return { reasoning: "", content: msg };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { reasoning: "", content: "模型没有返回内容。" };
  }

  const decoder = new TextDecoder();
  let reasoning = "";
  let content = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const payload = trimmed.slice(6);
        if (payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string };
            }>;
          };
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            reasoning += delta.reasoning_content;
            callbacks?.onThinking?.(delta.reasoning_content, reasoning);
          }
          if (delta?.content) {
            content += delta.content;
            callbacks?.onContent?.(delta.content, content);
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { reasoning, content: content.trim() || "模型没有返回内容。" };
}

function parseAgentAction(raw: string): AgentAction | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = (fenceMatch?.[1] ?? raw).trim();
  try {
    const obj = JSON.parse(payload) as Partial<AgentAction>;
    if (
      obj.type === "final" &&
      typeof (obj as { answer?: { summary?: unknown } }).answer?.summary === "string"
    ) {
      const answer = (obj as { answer: { summary: string; blocks?: Array<{ kind: "text" | "code"; content: string; language?: string }> } }).answer;
      return {
        type: "final",
        answer: {
          summary: answer.summary,
          blocks: Array.isArray(answer.blocks) ? answer.blocks : [],
        },
      };
    }
    if (obj.type === "plan" && Array.isArray((obj as { items?: unknown }).items)) {
      const items = (obj as { items: unknown[] }).items
        .map((item) => item as Partial<PlanItem>)
        .filter(
          (item): item is PlanItem =>
            typeof item.content === "string" &&
            ["pending", "in_progress", "completed"].includes(String(item.status)),
        );
      return { type: "plan", items };
    }
    if (obj.type === "read" && typeof (obj as { path?: unknown }).path === "string") {
      return { type: "read", path: (obj as { path: string }).path, reason: typeof (obj as { reason?: unknown }).reason === "string" ? (obj as { reason: string }).reason : "" };
    }
    if (
      obj.type === "write" &&
      typeof (obj as { path?: unknown }).path === "string" &&
      typeof (obj as { content?: unknown }).content === "string"
    ) {
      const action = obj as { path: string; content: string; reason?: string };
      return { type: "write", path: action.path, content: action.content, reason: action.reason ?? "" };
    }
    if (
      obj.type === "edit" &&
      typeof (obj as { path?: unknown }).path === "string" &&
      typeof (obj as { search?: unknown }).search === "string" &&
      typeof (obj as { replace?: unknown }).replace === "string"
    ) {
      const action = obj as { path: string; search: string; replace: string; reason?: string };
      return { type: "edit", path: action.path, search: action.search, replace: action.replace, reason: action.reason ?? "" };
    }
    if (obj.type === "bash" && typeof (obj as { command?: unknown }).command === "string") {
      const action = obj as { command: string; args?: unknown[]; reason?: string };
      return {
        type: "bash",
        command: action.command,
        args: Array.isArray(action.args) ? action.args.map(String) : [],
        reason: action.reason ?? "",
      };
    }
    if (obj.type === "task" && typeof (obj as { prompt?: unknown }).prompt === "string") {
      const action = obj as { agent?: string; prompt: string; description?: string };
      const agent = ["explorer", "planner", "worker"].includes(String(action.agent))
        ? (action.agent as SubagentName)
        : "explorer";
      return {
        type: "task",
        agent,
        prompt: action.prompt,
        description: action.description ?? "subtask",
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isSafeInspectCommand(command: string, args: string[]): boolean {
  if (/\s/.test(command)) {
    return false;
  }

  const dangerousTokens = [">", ">>", "|", ";", "&&", "||", "`"];
  if (args.some((arg) => dangerousTokens.some((token) => arg.includes(token)))) {
    return false;
  }

  const cmd = command.toLowerCase();
  const safeCommands = new Set([
    "rg",
    "dir",
    "ls",
    "cat",
    "type",
    "pwd",
    "get-childitem",
    "get-content",
    "get-location",
  ]);
  if (safeCommands.has(cmd)) {
    return true;
  }

  if (cmd === "git") {
    const subcommand = (args[0] ?? "").toLowerCase();
    return ["status", "branch", "log", "show", "diff", "ls-files", "remote"].includes(subcommand);
  }

  return false;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getSubagentSystem(agent: SubagentName, projectRules: string): string {
  const base = `你是运行在 ${process.cwd()} 的 ${agent} 子智能体。你拥有独立上下文，只完成父智能体交给你的局部任务。`;
  const shared =
    "你每一步必须只返回 JSON。完成后只总结必要发现，不要输出完整过程。" +
    formatProjectRules(projectRules);

  if (agent === "planner") {
    return (
      base +
      '你专注拆解任务和制定执行计划。只能返回 {"type":"final","answer":{"summary":"..."}}，不要调用工具。' +
      shared
    );
  }
  if (agent === "worker") {
    return (
      base +
      '可用工具：{"type":"read","path":"..."}、{"type":"write","path":"...","content":"..."}、{"type":"edit","path":"...","search":"...","replace":"..."}、{"type":"bash","command":"...","args":["..."]}，或 {"type":"final","answer":{"summary":"..."}}。' +
      "优先用 read 理解上下文，修改时优先用 edit，必要时用 bash 验证。" +
      shared
    );
  }
  return (
    base +
    '可用工具：{"type":"read","path":"..."}、{"type":"bash","command":"...","args":["..."]}，或 {"type":"final","answer":{"summary":"..."}}。' +
    "你专注项目探索、架构扫描、定位文件。只能使用 read 和安全只读 bash。" +
    shared
  );
}

async function runSubagent(agent: SubagentName, prompt: string, projectRules: string): Promise<string> {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  const maxTurns = 12;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const raw = await askDeepSeek([
      {
        role: "system",
        content: getSubagentSystem(agent, projectRules),
      },
      ...messages,
    ]);
    const action = parseAgentAction(raw);
    if (!action) {
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: "格式错误。请只输出 read、bash 或 final JSON。" });
      continue;
    }
    if (action.type === "final") {
      return action.answer.summary;
    }
    if (agent === "planner") {
      messages.push({ role: "user", content: "planner 子智能体禁止调用工具。请直接返回 final 摘要。" });
      continue;
    }
    if (action.type === "plan" || action.type === "task") {
      messages.push({ role: "user", content: `子智能体禁止使用 ${action.type}。请改用 read、安全只读 bash，或 final。` });
      continue;
    }
    if (agent === "explorer" && (action.type === "write" || action.type === "edit")) {
      messages.push({ role: "user", content: `explorer 子智能体禁止使用 ${action.type}。请改用 read、安全只读 bash，或 final。` });
      continue;
    }
    if (agent === "explorer" && action.type === "bash" && !isSafeInspectCommand(action.command, action.args ?? [])) {
      messages.push({ role: "user", content: "子智能体只允许安全只读 bash。请改用 rg --files、git status 等只读命令，或 final。" });
      continue;
    }
    const result = await runTool(action, projectRules);
    messages.push({ role: "user", content: `工具执行结果 (${describeTool(action)}):\n${result}` });
  }

  return "子智能体达到最大轮次，未得到最终摘要。";
}

function runTool(action: Exclude<AgentAction, { type: "final" | "plan" }>, projectRules: string): Promise<string> {
  if (action.type === "read") {
    try {
      const stats = statSync(action.path);
      if (stats.isDirectory()) {
        const entries = readdirSync(action.path).sort();
        return Promise.resolve(
          [
            `[directory] ${action.path}`,
            ...entries.map((name) => `- ${name}`),
          ].join("\n"),
        );
      }
      return Promise.resolve(readFileSync(action.path, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Promise.resolve(`read failed: ${message}`);
    }
  }
  if (action.type === "write") {
    try {
      writeFileSync(action.path, action.content, "utf8");
      return Promise.resolve(`wrote ${action.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Promise.resolve(`write failed: ${message}`);
    }
  }
  if (action.type === "edit") {
    try {
      const current = readFileSync(action.path, "utf8");
      if (!current.includes(action.search)) {
        return Promise.resolve(`edit failed: search text not found in ${action.path}`);
      }
      writeFileSync(action.path, current.replace(action.search, action.replace), "utf8");
      return Promise.resolve(`edited ${action.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Promise.resolve(`edit failed: ${message}`);
    }
  }
  if (action.type === "task") {
    return runSubagent(action.agent ?? "explorer", action.prompt, projectRules);
  }
  return runCommand(action.command, action.args ?? []);
}

function describeTool(action: Exclude<AgentAction, { type: "final" | "plan" }>): string {
  if (action.type === "read") {
    return `read ${action.path}`;
  }
  if (action.type === "write") {
    return `write ${action.path}`;
  }
  if (action.type === "edit") {
    return `edit ${action.path}`;
  }
  if (action.type === "task") {
    return `task ${action.agent ?? "explorer"} ${action.description ?? "subtask"}`;
  }
  return `bash ${[action.command, ...(action.args ?? [])].join(" ")}`;
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${[
                command,
                ...args.map(quotePowerShellArg),
              ].join(" ")}`,
            ],
            { env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
          )
        : spawn(command, args, { shell: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      resolve(`error: ${err.message}`);
    });

    child.on("close", (code: number | null) => {
      const out = stdout.trim();
      const err = stderr.trim();
      resolve(
        [`exitCode=${code ?? 0}`, out ? `stdout:\n${out}` : "", err ? `stderr:\n${err}` : ""]
          .filter(Boolean)
          .join("\n\n"),
      );
    });
  });
}

// TUI helpers

const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.gray(s),
  selectList: {
    selectedPrefix: (s) => chalk.cyan(s),
    selectedText: (s) => chalk.cyan(s),
    description: (s) => chalk.gray(s),
    scrollInfo: (s) => chalk.gray(s),
    noMatch: (s) => chalk.red(s),
  },
};

const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.cyan(s),
  link: (s) => chalk.underline.blue(s),
  linkUrl: (s) => chalk.blue(s),
  code: (s) => chalk.yellow(s),
  codeBlock: (s) => chalk.gray(s),
  codeBlockBorder: (s) => chalk.gray(s),
  quote: (s) => chalk.italic.gray(s),
  quoteBorder: (s) => chalk.gray(s),
  hr: (s) => chalk.gray(s),
  listBullet: (s) => chalk.cyan(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
};

async function formatCode(code: string, language?: string): Promise<string> {
  const parserMap: Record<string, { parser: string; plugins?: prettier.Plugin[] }> = {
    ts: { parser: "typescript" },
    tsx: { parser: "typescript" },
    typescript: { parser: "typescript" },
    js: { parser: "babel" },
    jsx: { parser: "babel" },
    javascript: { parser: "babel" },
    json: { parser: "json" },
    json5: { parser: "json5" },
    css: { parser: "css" },
    scss: { parser: "scss" },
    less: { parser: "less" },
    html: { parser: "html" },
    vue: { parser: "vue" },
    angular: { parser: "angular" },
    markdown: { parser: "markdown" },
    md: { parser: "markdown" },
    mdx: { parser: "mdx" },
    yaml: { parser: "yaml" },
    yml: { parser: "yaml" },
    graphql: { parser: "graphql" },
    gql: { parser: "graphql" },
    java: { parser: "java", plugins: [prettierPluginJava] },
  };

  const entry = language ? parserMap[language.toLowerCase()] : undefined;
  if (!entry) {
    return code;
  }

  try {
    return await prettier.format(code, {
      parser: entry.parser,
      plugins: entry.plugins,
      printWidth: 100,
      tabWidth: 2,
    });
  } catch {
    return code;
  }
}

function addMessage(container: Container, text: string, role: "user" | "assistant" | "system" | "error"): void {
  if (role === "user") {
    // Divider before each user message to separate QA turns
    container.addChild(new Text(chalk.gray("─".repeat(40)), 1, 0));
    container.addChild(new Text(`${chalk.cyan.bold("▌")} ${text}`, 2, 0));
  } else if (role === "error") {
    container.addChild(new Text(`${chalk.red.bold("✖")} ${text}`, 2, 0));
  } else if (role === "system") {
    container.addChild(new Text(chalk.gray(text), 1, 0));
  } else {
    container.addChild(new Markdown(text, 2, 0, markdownTheme));
  }
  container.addChild(new Spacer(1));
}

async function displayAgentReply(reply: AgentTurnResult, messagesContainer: Container): Promise<void> {
  if (reply.blocks.length > 0) {
    const blocks = await Promise.all(
      reply.blocks.map(async (b) => {
        if (b.kind === "code") {
          const formatted = await formatCode(b.content, b.language);
          return ["```" + (b.language ?? ""), formatted, "```"].join("\n");
        }
        return b.content;
      }),
    );
    addMessage(messagesContainer, blocks.join("\n\n"), "assistant");
  } else {
    addMessage(messagesContainer, reply.summary, "assistant");
  }
}

async function tuiInput(tui: TUI, message: string): Promise<string> {
  return new Promise((resolve) => {
    const container = new Container();
    container.addChild(new Text(message, 1, 1));

    const input = new Input();
    container.addChild(input);

    const handle = tui.showOverlay(container, {
      anchor: "center",
      width: Math.min(60, tui.terminal.columns),
    });

    input.onSubmit = (value) => {
      handle.hide();
      resolve(value);
    };

    handle.focus();
  });
}

function formatPlanText(items: PlanItem[]): string {
  if (items.length === 0) return "";
  const lines = ["plan>"];
  for (const item of items) {
    const mark = item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : " ";
    lines.push(`- [${mark}] ${item.content}`);
  }
  return lines.join("\n");
}

function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = match[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!name || !desc) return null;
  return { name, description: desc };
}

function scanSkillDir(dir: string, seen: Set<string>): SkillMeta[] {
  const result: SkillMeta[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        const targetDir = st.isDirectory() ? fullPath : null;
        if (!targetDir) continue;

        // Direct skill: targetDir/SKILL.md
        const directMd = join(targetDir, "SKILL.md");
        if (existsSync(directMd)) {
          const content = readFileSync(directMd, "utf8");
          const meta = parseSkillFrontmatter(content);
          if (meta && !seen.has(meta.name)) {
            seen.add(meta.name);
            result.push({ name: meta.name, description: meta.description, path: directMd });
          }
          continue;
        }

        // Skill collection: targetDir/*/SKILL.md
        for (const sub of readdirSync(targetDir)) {
          const subMd = join(targetDir, sub, "SKILL.md");
          if (!existsSync(subMd)) continue;
          const content = readFileSync(subMd, "utf8");
          const meta = parseSkillFrontmatter(content);
          if (meta && !seen.has(meta.name)) {
            seen.add(meta.name);
            result.push({ name: meta.name, description: meta.description, path: subMd });
          }
        }
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // skip unreadable directories
  }
  return result;
}

function discoverSkills(): SkillMeta[] {
  const seen = new Set<string>();
  const all: SkillMeta[] = [];

  // Project skills
  const projectDir = join(process.cwd(), ".agents", "skills");
  if (existsSync(projectDir)) {
    all.push(...scanSkillDir(projectDir, seen));
  }

  // Global skills
  const globalDir = join(homedir(), ".agents", "skills");
  if (existsSync(globalDir)) {
    all.push(...scanSkillDir(globalDir, seen));
  }

  return all;
}

function formatSkillsPrompt(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = ["<available_skills>"];
  for (const s of skills) {
    lines.push(`  <skill>`);
    lines.push(`    <name>${s.name}</name>`);
    lines.push(`    <description>${s.description}</description>`);
    lines.push(`    <location>${s.path}</location>`);
    lines.push(`  </skill>`);
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

async function runAgentTurn(
  history: ChatMessage[],
  userInput: string,
  mode: AgentMode,
  projectRules: string,
  skills: SkillMeta[],
  tui: TUI,
  messagesContainer: Container,
): Promise<AgentTurnResult> {
  const maxSteps = 500;
  let plan: PlanItem[] = [];

  const toolsPrompt = [
    "你是 suncli，终端编程助手。工作目录: " + process.cwd() + "。每一步只返回一个 JSON action：",
    "",
    `read   {"type":"read","path":"..."}`,
    `write  {"type":"write","path":"...","content":"..."}`,
    `edit   {"type":"edit","path":"...","search":"...","replace":"..."}`,
    `bash   {"type":"bash","command":"...","args":[...]}`,
    `task   {"type":"task","agent":"explorer|planner|worker","prompt":"..."}`,
    `plan   {"type":"plan","items":[{"content":"...","status":"pending|in_progress|completed"}]}`,
    `final  {"type":"final","answer":{"summary":"...","blocks":[{"kind":"text|code","content":"..."}]}}`,
  ].join("\n");

  const modeHint = mode === "answer"
    ? "\n当前为问答模式，只允许 final。"
    : mode === "inspect"
    ? "\n当前为只读模式，禁止 write/edit。"
    : "";

  const loopMessages: ChatMessage[] = [
    {
      role: "system",
      content:
        toolsPrompt
        + modeHint
        + formatProjectRules(projectRules)
        + "\n" + formatSkillsPrompt(skills),
    },
    ...history,
    { role: "user", content: userInput },
  ];

  for (let step = 1; step <= maxSteps; step += 1) {
    // Thinking display widget
    const thinkingWidget = new Text(chalk.gray("💭 思考中..."), 1, 1);
    messagesContainer.addChild(thinkingWidget);
    tui.requestRender();

    const streamResult = await askDeepSeekStream(loopMessages, {
      onThinking: (_chunk, fullText) => {
        const preview = fullText.length > 200 ? "..." + fullText.slice(-200) : fullText;
        thinkingWidget.setText(chalk.gray(`💭 ${preview}`));
        tui.requestRender();
      },
      onContent: () => {
        thinkingWidget.setText(chalk.gray("💭 ..."));
        tui.requestRender();
      },
    });

    messagesContainer.removeChild(thinkingWidget);

    if (streamResult.reasoning) {
      const preview = streamResult.reasoning.length > 400
        ? streamResult.reasoning.slice(0, 400) + "..."
        : streamResult.reasoning;
      addMessage(messagesContainer, chalk.gray(`💭 ${preview}`), "system");
    }

    const raw = streamResult.content;
    const action = parseAgentAction(raw);

    if (!action) {
      loopMessages.push({ role: "assistant", content: raw });
      loopMessages.push({
        role: "user",
        content:
          '格式错误。请只输出合法 JSON，工具格式为 read/write/edit/bash，或 final answer。',
      });
      continue;
    }

    if (action.type === "final") {
      return {
        type: "final",
        summary: action.answer.summary,
        blocks: action.answer.blocks ?? [],
        steps: step,
      };
    }

    if (action.type === "plan") {
      const prevSnapshot = JSON.stringify(plan);
      plan = action.items;
      const nextSnapshot = JSON.stringify(plan);
      if (prevSnapshot !== nextSnapshot) {
        addMessage(messagesContainer, formatPlanText(plan), "system");
        tui.requestRender();
      }
      loopMessages.push({
        role: "user",
        content: `计划已更新:\n${plan.map((item) => `- [${item.status}] ${item.content}`).join("\n")}`,
      });
      continue;
    }

    const display = describeTool(action);
    if (mode === "answer") {
      loopMessages.push({
        role: "user",
        content: `当前任务为普通问答，禁止工具调用。请直接返回 final。你刚才的工具调用: ${display}`,
      });
      continue;
    }

    if (mode === "inspect" && action.type !== "read" && action.type !== "task" && !(action.type === "bash" && isSafeInspectCommand(action.command, action.args ?? []))) {
      loopMessages.push({
        role: "user",
        content: `当前任务为项目只读巡检，只允许 read、task 或安全只读 bash。请换用 read、task、bash rg --files、git status 等只读工具，或直接返回 final。被拒绝工具: ${display}`,
      });
      continue;
    }

    if (mode === "inspect" && action.type === "task" && action.agent === "worker") {
      loopMessages.push({
        role: "user",
        content: "inspect 模式禁止使用 worker 子智能体。请改用 explorer、planner、read、安全只读 bash，或直接返回 final。",
      });
      continue;
    }

    const result = await runTool(action, projectRules);
    loopMessages.push({
      role: "user",
      content: `工具执行结果 (${display}):\n${result}`,
    });
  }

  return {
    type: "max_steps",
    summary: "达到最大 Agent 步数上限，建议缩小任务范围后重试。",
    blocks: [],
    steps: maxSteps,
  };
}

export async function startChat(): Promise<void> {
  return new Promise<void>((resolve) => {
    const cfg = loadConfig();
    const projectRules = loadProjectRules();
    const skills = discoverSkills();

    // Build unified slash command list (builtin + skills)
    const buildResult = buildSlashCommands(skills);
    slashCommands = buildResult.commands;
    slashFuse = new Fuse(slashCommands, { keys: ["name", "aliases", "description"], threshold: 0.45, includeScore: true });

    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    const messagesContainer = new Container();
    tui.addChild(messagesContainer);

    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    const provider = new CombinedAutocompleteProvider(
      slashCommands.map((cmd) => ({ name: cmd.name, description: cmd.description })),
      process.cwd(),
    );
    editor.setAutocompleteProvider(provider);

    const inputOverlay = tui.showOverlay(editor, {
      anchor: "bottom-center",
      width: "100%",
      offsetY: 0,
    });

    const history: ChatMessage[] = [
      {
        role: "system",
        content: "你是 suncli，一个终端编程助手。你的工作是帮助用户阅读代码、编写修改文件、执行命令、分析项目。你直接回答用户问题，不主动探索环境。回答简洁可操作。",
      },
    ];

    addMessage(messagesContainer, `suncli chat (${cfg.model})`, "system");
    if (skills.length > 0) {
      addMessage(messagesContainer, `已加载 ${skills.length} 个技能，输入 / 可搜索。`, "system");
    }
    for (const w of buildResult.warnings) {
      addMessage(messagesContainer, `⚠ ${w}`, "system");
    }
    addMessage(messagesContainer, "输入 /help 查看命令，输入 /exit 退出。", "system");

    let apiKeyPromptDone = false;

    async function checkApiKey(): Promise<void> {
      const existingKey = process.env[cfg.apiKeyEnv] ?? cfg.apiKey;
      if (!existingKey && !apiKeyPromptDone) {
        apiKeyPromptDone = true;
        const key = await tuiInput(tui, `未检测到 API Key。推荐使用 DeepSeek API Key。\n请输入 API Key（直接回车可跳过）:`);
        if (key) {
          saveConfig({ apiKey: key });
          addMessage(messagesContainer, "API Key 已保存到本地配置。", "system");
        } else {
          addMessage(messagesContainer, `你也可以稍后设置环境变量 ${cfg.apiKeyEnv}。`, "system");
        }
        tui.requestRender();
      }
    }

    editor.onSubmit = async (text) => {
      const input = text.trim();
      if (!input) return;

      editor.setText("");
      editor.addToHistory(input);
      addMessage(messagesContainer, input, "user");
      tui.requestRender();

      if (input === "exit") {
        tui.stop();
        resolve();
        return;
      }

      await checkApiKey();

      const slashResult = await handleSlashCommand(input, history, projectRules, tui, messagesContainer);
      if (slashResult.type === "exit") {
        tui.stop();
        resolve();
        return;
      }
      if (slashResult.type === "handled") {
        tui.requestRender();
        return;
      }
      if (slashResult.type === "fill_editor") {
        editor.setText(slashResult.text);
        tui.requestRender();
        return;
      }
      if (slashResult.type === "skill_loaded") {
        addMessage(messagesContainer, "技能已就绪，请输入你的任务。", "system");
        tui.requestRender();
        return;
      }
      if (slashResult.type === "skill_with_task") {
        const taskMsg = [...history].reverse().find((m) => m.role === "user");
        const task = taskMsg?.content ?? input;
        const reply = await runAgentTurn(history, task, "write", projectRules, skills, tui, messagesContainer);
        history.push({ role: "assistant", content: reply.summary });
        await displayAgentReply(reply, messagesContainer);
        tui.requestRender();
        return;
      }

      try {
        const reply = await runAgentTurn(history, input, "write", projectRules, skills, tui, messagesContainer);

        history.push({ role: "user", content: input });
        history.push({ role: "assistant", content: reply.summary });
        await displayAgentReply(reply, messagesContainer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addMessage(messagesContainer, msg, "error");
      }

      tui.requestRender();
    };

    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        tui.stop();
        resolve();
        return { consume: true };
      }
      return undefined;
    });

    tui.setFocus(editor);
    tui.start();
  });
}
