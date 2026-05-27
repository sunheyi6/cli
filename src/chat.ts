#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  Loader,
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
type IntentResult = {
  intent:
    | "代码解释"
    | "查看文件/架构"
    | "查错/分析"
    | "技术问答"
    | "新增文件"
    | "新增函数"
    | "修改现有代码"
    | "删除代码"
    | "执行命令"
    | "高危操作"
    | "非项目相关";
  confidence: number;
  risk: "low" | "medium" | "high";
  needsTool: boolean;
  tools: Array<"read" | "write" | "edit" | "bash" | "task">;
};
type AgentMode = "answer" | "inspect" | "write";
type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" };
type SlashCommandName = "help" | "clear" | "exit" | "agents" | "tools" | "rules";
type SlashCommandResult = "handled" | "exit" | "not_slash";
type SubagentName = "explorer" | "planner" | "worker";
type SlashCommand = { name: SlashCommandName; description: string; aliases: string[] };
type SlashCommandMatch = { command: SlashCommand; score: number };

const C_RESET = "\x1b[0m";
const C_INPUT = "\x1b[36m";
const C_OUTPUT = "\x1b[32m";
const C_META = "\x1b[90m";
const C_DONE = "\x1b[32m";

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "显示可用斜杠命令", aliases: ["h", "?"] },
  { name: "clear", description: "清空当前会话上下文", aliases: ["cls", "reset"] },
  { name: "exit", description: "退出会话", aliases: ["quit", "q"] },
  { name: "agents", description: "查看内置子智能体", aliases: ["agent", "subagents"] },
  { name: "tools", description: "查看可用工具", aliases: ["tool"] },
  { name: "rules", description: "查看 agents.md 是否已加载", aliases: ["rule"] },
];
const SLASH_FUSE = new Fuse(SLASH_COMMANDS, {
  keys: ["name", "aliases", "description"],
  threshold: 0.45,
  includeScore: true,
});

function advancePlanProgress(items: PlanItem[]): PlanItem[] {
  if (items.length === 0) {
    return items;
  }
  const next = items.map((item) => ({ ...item }));
  const activeIndex = next.findIndex((item) => item.status === "in_progress");
  if (activeIndex >= 0) {
    next[activeIndex].status = "completed";
  }
  const pendingIndex = next.findIndex((item) => item.status === "pending");
  if (pendingIndex >= 0) {
    next[pendingIndex].status = "in_progress";
  }
  return next;
}

function searchSlashCommands(query: string): SlashCommandMatch[] {
  const normalized = query.trim().replace(/^\//, "").toLowerCase();
  if (!normalized) {
    return SLASH_COMMANDS.map((command) => ({ command, score: 1 }));
  }
  return SLASH_FUSE.search(normalized)
    .map((result) => ({
      command: result.item,
      score: 1 - (result.score ?? 1),
    }))
    .sort((a, b) => b.score - a.score || a.command.name.length - b.command.name.length);
}

function findExactSlashCommand(input: string): SlashCommandName | null {
  const query = input.slice(1).trim().toLowerCase();
  if (!query) {
    return null;
  }

  for (const command of SLASH_COMMANDS) {
    if ([command.name, ...command.aliases].includes(query)) {
      return command.name;
    }
  }

  return null;
}

function renderSlashHelp(): string {
  const lines: string[] = [`${C_META}commands>${C_RESET}`];
  for (const command of SLASH_COMMANDS) {
    lines.push(`${C_META}/${command.name.padEnd(9)} ${command.description}${C_RESET}`);
  }
  return lines.join("\n");
}

async function pickSlashCommandTui(tui: TUI, matches: SlashCommandMatch[]): Promise<SlashCommandName | null> {
  if (matches.length === 0) {
    return null;
  }

  const visible = matches.slice(0, 8);
  const items: SelectItem[] = visible.map((m) => ({
    value: m.command.name,
    label: `/${m.command.name}`,
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
      resolve(item.value as SlashCommandName);
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
): Promise<SlashCommandResult> {
  if (!input.startsWith("/")) {
    return "not_slash";
  }

  const exactCommand = findExactSlashCommand(input);
  const matches = searchSlashCommands(input);
  if (matches.length === 0) {
    return "handled";
  }

  const command = exactCommand ?? (await pickSlashCommandTui(tui, matches));
  if (!command) {
    return "handled";
  }

  if (command === "help") {
    console.log(renderSlashHelp());
    return "handled";
  }
  if (command === "clear") {
    history.splice(1, history.length - 1);
    return "handled";
  }
  if (command === "exit") {
    return "exit";
  }
  if (command === "agents") {
    console.log(`${C_META}agents>${C_RESET} explorer（只读探索）, planner（任务拆解）, worker（局部实现）`);
    return "handled";
  }
  if (command === "tools") {
    console.log(`${C_META}tools>${C_RESET} read, write, edit, bash, task, plan`);
    return "handled";
  }
  if (command === "rules") {
    console.log(`${C_META}rules>${C_RESET} ${projectRules ? "agents.md 已加载" : "未发现 agents.md"}`);
    return "handled";
  }

  return "handled";
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
    choices?: Array<{ message?: { content?: string } }>;
  };

  return data.choices?.[0]?.message?.content?.trim() || "模型没有返回内容。";
}

function classifyIntentLocally(input: string): IntentResult | null {
  const text = input.toLowerCase();
  const projectWords = ["这个项目", "当前项目", "本项目", "项目", "代码库", "仓库", "工程"];
  const inspectWords = ["做什么", "什么功能", "有哪些功能", "功能", "架构", "目录", "文件", "结构"];
  const destructiveWords = ["删除", "清空", "移除", "reset", "rm ", "del ", "drop"];

  if (destructiveWords.some((word) => text.includes(word))) {
    return { intent: "高危操作", confidence: 0.9, risk: "high", needsTool: true, tools: ["bash"] };
  }

  if (projectWords.some((word) => text.includes(word)) && inspectWords.some((word) => text.includes(word))) {
    return { intent: "查看文件/架构", confidence: 0.95, risk: "low", needsTool: true, tools: ["read", "bash", "task"] };
  }

  if (["你是谁", "你可以做什么", "你能做什么"].some((word) => input.includes(word))) {
    return { intent: "非项目相关", confidence: 0.95, risk: "low", needsTool: false, tools: [] };
  }

  return null;
}

async function classifyIntent(input: string, history: ChatMessage[], projectRules: string): Promise<IntentResult | null> {
  const localIntent = classifyIntentLocally(input);
  if (localIntent) {
    return localIntent;
  }

  const raw = await askDeepSeek([
    {
      role: "system",
      content:
        `
你是严格的意图分类器。
请按照层级一步步思考，但不要输出思考过程，只输出最终JSON。

层级判断规则：
1. 是否与项目代码/文件相关？
   不相关 → intent: 非项目相关
2. 相关 → 判断是只读还是修改？
   只读 → 代码解释、查看文件/架构、查错/分析、技术问答
   修改 → 新增文件、新增函数、修改现有代码、删除代码、执行命令、高危操作

可用工具：
- read：读取文件内容（查看代码 / 配置）
- write：新建或覆盖文件（创建新文件）
- edit：精确局部修改（改函数、改配置）
- bash：执行终端命令（运行、安装、git 等）
- task：启动子智能体处理局部任务，隔离上下文，只返回摘要

请判断是否需要调用工具，以及具体可能需要哪些工具：
- 普通问答通常 needsTool=false, tools=[]
- 查看项目、解释代码、分析错误通常 needsTool=true, tools=["read"] 或 ["read","bash"]，复杂探索可加 "task"
- 新增文件通常 tools=["write"]
- 修改现有代码通常 tools=["read","edit"]，必要时加 "bash"
- 执行命令通常 tools=["bash"]
- 删除/高危操作通常 tools=["bash"] 且 risk=high

风险等级：
low：只读、问答
medium：新增、修改代码
high：删除代码、高危操作、执行系统命令

必须严格只输出JSON，格式：
{"intent":"...","confidence":0.0,"risk":"low|medium|high","needsTool":true,"tools":["read"]}
${formatProjectRules(projectRules)}
`.trim(),
    },
    ...history.slice(-6),
    { role: "user", content: input },
  ]);
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = (fenceMatch?.[1] ?? raw).trim();
  try {
    const parsed = JSON.parse(payload) as Partial<IntentResult>;
    if (!parsed.intent || !parsed.risk || typeof parsed.confidence !== "number") {
      return null;
    }
    return {
      intent: parsed.intent,
      confidence: parsed.confidence,
      risk: parsed.risk,
      needsTool: typeof parsed.needsTool === "boolean" ? parsed.needsTool : false,
      tools: Array.isArray(parsed.tools)
        ? parsed.tools.filter((tool): tool is "read" | "write" | "edit" | "bash" | "task" =>
            ["read", "write", "edit", "bash", "task"].includes(String(tool)),
          )
        : [],
    } as IntentResult;
  } catch {
    return null;
  }
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
    container.addChild(new Text(`${chalk.cyan("you>")} ${text}`, 1, 0));
  } else if (role === "error") {
    container.addChild(new Text(`${chalk.red("error>")} ${text}`, 1, 0));
  } else if (role === "system") {
    container.addChild(new Text(chalk.gray(text), 1, 0));
  } else {
    container.addChild(new Markdown(text, 1, 0, markdownTheme));
  }
  container.addChild(new Spacer(1));
}

async function tuiConfirm(tui: TUI, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const items: SelectItem[] = [
      { value: "yes", label: "Yes", description: "确认执行" },
      { value: "no", label: "No", description: "取消" },
    ];
    const theme: SelectListTheme = {
      selectedPrefix: (s) => chalk.green(s),
      selectedText: (s) => chalk.green(s),
      description: (s) => chalk.gray(s),
      scrollInfo: (s) => chalk.gray(s),
      noMatch: (s) => chalk.red(s),
    };
    const list = new SelectList(items, 2, theme);
    const container = new Container();
    container.addChild(new Text(message, 1, 1));
    container.addChild(list);

    const handle = tui.showOverlay(container, {
      anchor: "center",
      width: Math.min(60, tui.terminal.columns),
    });

    list.onSelect = (item) => {
      handle.hide();
      resolve(item.value === "yes");
    };
    list.onCancel = () => {
      handle.hide();
      resolve(false);
    };

    handle.focus();
  });
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

async function runAgentTurn(
  history: ChatMessage[],
  userInput: string,
  mode: AgentMode,
  allowedTools: IntentResult["tools"],
  projectRules: string,
  tui: TUI,
  messagesContainer: Container,
  spinner?: Loader,
): Promise<AgentTurnResult> {
  const maxSteps = 100;
  let plan: PlanItem[] = [];
  const loopMessages: ChatMessage[] = [
    {
      role: "system",
      content:
        `本轮意图识别建议工具: ${allowedTools.length ? allowedTools.join(", ") : "none"}。\n` +
        (mode === "write"
          ? '你是终端编码 Agent。你每一步必须只返回 JSON。可用格式：' +
            '{"type":"plan","items":[{"content":"...","status":"pending|in_progress|completed"}]}、' +
            '{"type":"read","path":"...","reason":"..."}、{"type":"write","path":"...","content":"...","reason":"..."}、{"type":"edit","path":"...","search":"...","replace":"...","reason":"..."}、{"type":"bash","command":"...","args":["..."],"reason":"..."} ' +
            '、{"type":"task","agent":"explorer|planner|worker","prompt":"...","description":"..."} ' +
            '或 {"type":"final","answer":{"summary":"...","blocks":[{"kind":"text","content":"..."},{"kind":"code","language":"ts","content":"..."}]}}。' +
            "工具含义：plan维护待办计划；read读取文件内容；write新建或覆盖文件；edit精确局部修改；bash执行终端命令；task启动独立上下文子智能体处理局部任务并返回摘要。内置子智能体：explorer=只读探索，planner=拆解计划，worker=局部实现。大任务先用 plan 写计划，每做完一步用 plan 更新状态。当任务完成时返回 final。不要输出 JSON 以外的内容。"
          : mode === "inspect"
            ? '你是项目只读巡检 Agent。你每一步必须只返回 JSON。可用格式：' +
              '{"type":"plan","items":[{"content":"...","status":"pending|in_progress|completed"}]}、' +
              '{"type":"read","path":"...","reason":"..."} 或 {"type":"bash","command":"...","args":["..."],"reason":"..."} 或 {"type":"task","agent":"explorer|planner","prompt":"...","description":"..."} ' +
              '或 {"type":"final","answer":{"summary":"...","blocks":[{"kind":"text","content":"..."},{"kind":"code","language":"ts","content":"..."}]}}。' +
              "工具含义：plan维护待办计划；read读取文件内容；bash只允许安全只读命令；task把局部探索/计划交给独立上下文子智能体并只接收摘要。inspect 模式只能使用 explorer 或 planner 子智能体。复杂问题先用 plan 写计划，每做完一步用 plan 更新状态。禁止 write/edit。"
            : '你是普通问答助手。你必须只返回 JSON，且只能使用 {"type":"final","answer":{"summary":"...","blocks":[...]}}。禁止返回 command、禁止建议执行命令。') +
        formatProjectRules(projectRules),
    },
    ...history,
    { role: "user", content: userInput },
  ];

  for (let step = 1; step <= maxSteps; step += 1) {
    const raw = await askDeepSeek(loopMessages);
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
      if (plan.some((item) => item.status !== "completed")) {
        plan = plan.map((item) => ({ ...item, status: "completed" }));
        addMessage(messagesContainer, formatPlanText(plan), "system");
        tui.requestRender();
      }
      return {
        type: "final",
        summary: action.answer.summary,
        blocks: action.answer.blocks ?? [],
        steps: step,
      };
    }

    if (action.type === "plan") {
      plan = action.items;
      spinner?.stop();
      addMessage(messagesContainer, formatPlanText(plan), "system");
      tui.requestRender();
      spinner?.start();
      loopMessages.push({
        role: "user",
        content: `计划已更新:\n${plan.map((item) => `- [${item.status}] ${item.content}`).join("\n")}`,
      });
      continue;
    }

    const display = describeTool(action);
    if (!allowedTools.includes(action.type)) {
      loopMessages.push({
        role: "user",
        content: `意图识别阶段认为本轮不应使用 ${action.type} 工具。允许工具: ${allowedTools.length ? allowedTools.join(", ") : "none"}。请改用允许工具或直接返回 final。被拒绝工具: ${display}`,
      });
      continue;
    }

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

    if (mode === "write" && action.type !== "read") {
      spinner?.stop();
      const ok = await tuiConfirm(tui, `调用工具: ${display} ?`);
      spinner?.start();
      if (!["y", "yes"].includes(ok ? "yes" : "no")) {
        loopMessages.push({
          role: "user",
          content: `命令被用户拒绝: ${display}`,
        });
        continue;
      }
    }

    const result = await runTool(action, projectRules);
    if (plan.length > 0) {
      const updatedPlan = advancePlanProgress(plan);
      const planChanged = JSON.stringify(updatedPlan) !== JSON.stringify(plan);
      if (planChanged) {
        plan = updatedPlan;
        spinner?.stop();
        addMessage(messagesContainer, formatPlanText(plan), "system");
        tui.requestRender();
        spinner?.start();
        loopMessages.push({
          role: "user",
          content: `计划已自动推进:\n${plan.map((item) => `- [${item.status}] ${item.content}`).join("\n")}`,
        });
      }
    }
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

    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    const messagesContainer = new Container();
    tui.addChild(messagesContainer);

    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    const provider = new CombinedAutocompleteProvider(
      SLASH_COMMANDS.map((cmd) => ({ name: cmd.name, description: cmd.description })),
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
        content: "You are a helpful coding assistant in terminal. Keep answers concise and actionable.",
      },
    ];

    addMessage(messagesContainer, `suncli chat (${cfg.model})`, "system");
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
      addMessage(messagesContainer, input, "user");
      tui.requestRender();

      if (input === "exit") {
        tui.stop();
        resolve();
        return;
      }

      await checkApiKey();

      const slashResult = await handleSlashCommand(input, history, projectRules, tui);
      if (slashResult === "exit") {
        tui.stop();
        resolve();
        return;
      }
      if (slashResult === "handled") {
        tui.requestRender();
        return;
      }

      const spinner = new Loader(tui, (s) => chalk.cyan(s), (s) => chalk.gray(s), "思考中");
      spinner.start();

      try {
        const intent = await classifyIntent(input, history, projectRules);
        if (intent?.risk === "high" || intent?.intent === "高危操作") {
          spinner.stop();
          const ok = await tuiConfirm(tui, "检测到高危意图，确认继续 Agent 执行?");
          if (!ok) {
            addMessage(messagesContainer, "已取消本次高危请求。", "system");
            tui.requestRender();
            return;
          }
          spinner.start();
        }

        const modeByIntent: Record<IntentResult["intent"], AgentMode> = {
          代码解释: "inspect",
          "查看文件/架构": "inspect",
          "查错/分析": "inspect",
          技术问答: "answer",
          新增文件: "write",
          新增函数: "write",
          修改现有代码: "write",
          删除代码: "write",
          执行命令: "write",
          高危操作: "write",
          非项目相关: "answer",
        };
        const mode = intent ? modeByIntent[intent.intent] : "write";
        const allowedTools = intent?.needsTool ? intent.tools : [];

        const reply = await runAgentTurn(history, input, mode, allowedTools, projectRules, tui, messagesContainer, spinner);
        spinner.stop();

        history.push({ role: "user", content: input });
        history.push({ role: "assistant", content: reply.summary });

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
          const md = blocks.join("\n\n");
          addMessage(messagesContainer, md, "assistant");
        } else {
          addMessage(messagesContainer, reply.summary, "assistant");
        }
      } catch (err) {
        spinner.stop();
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
