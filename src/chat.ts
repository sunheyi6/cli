import readline from "node:readline";
import { spawn } from "node:child_process";
import { loadConfig, saveConfig } from "./config.js";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type AgentAction =
  | { type: "final"; answer: { summary: string; blocks?: Array<{ kind: "text" | "code"; content: string; language?: string }> } }
  | { type: "command"; command: string; args?: string[]; reason?: string };

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
};
type AgentMode = "answer" | "inspect" | "write";

const C_RESET = "\x1b[0m";
const C_INPUT = "\x1b[36m";
const C_OUTPUT = "\x1b[32m";
const C_META = "\x1b[90m";

function hr(label: string): string {
  return `${C_META}-------------------- ${label} --------------------${C_RESET}`;
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

function askLine(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (line: string) => resolve(line.trim())));
}

function classifyIntentLocally(input: string): IntentResult | null {
  const text = input.toLowerCase();
  const projectWords = ["这个项目", "当前项目", "本项目", "项目", "代码库", "仓库", "工程"];
  const inspectWords = ["做什么", "什么功能", "有哪些功能", "功能", "架构", "目录", "文件", "结构"];
  const destructiveWords = ["删除", "清空", "移除", "reset", "rm ", "del ", "drop"];

  if (destructiveWords.some((word) => text.includes(word))) {
    return { intent: "高危操作", confidence: 0.9, risk: "high" };
  }

  if (projectWords.some((word) => text.includes(word)) && inspectWords.some((word) => text.includes(word))) {
    return { intent: "查看文件/架构", confidence: 0.95, risk: "low" };
  }

  if (["你是谁", "你可以做什么", "你能做什么"].some((word) => input.includes(word))) {
    return { intent: "非项目相关", confidence: 0.95, risk: "low" };
  }

  return null;
}

async function classifyIntent(input: string, history: ChatMessage[]): Promise<IntentResult | null> {
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

风险等级：
low：只读、问答
medium：新增、修改代码
high：删除代码、高危操作、执行系统命令

必须严格只输出JSON，格式：
{"intent":"...","confidence":0.0,"risk":"low|medium|high"}
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
    return parsed as IntentResult;
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
    if (obj.type === "command" && typeof obj.command === "string") {
      return {
        type: "command",
        command: obj.command,
        args: Array.isArray(obj.args) ? obj.args.map(String) : [],
        reason: typeof obj.reason === "string" ? obj.reason : "",
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

async function runAgentTurn(
  rl: readline.Interface,
  history: ChatMessage[],
  userInput: string,
  mode: AgentMode,
): Promise<AgentTurnResult> {
  const maxSteps = 8;
  const loopMessages: ChatMessage[] = [
    {
      role: "system",
      content:
        (mode === "write"
          ? '你是终端编码 Agent。你每一步必须只返回 JSON。可用格式：' +
            '{"type":"command","command":"...","args":["..."],"reason":"..."} ' +
            '或 {"type":"final","answer":{"summary":"...","blocks":[{"kind":"text","content":"..."},{"kind":"code","language":"ts","content":"..."}]}}。' +
            "当需要查看信息或执行操作时用 command；当任务完成时返回 final。不要输出 JSON 以外的内容。"
          : mode === "inspect"
            ? '你是项目只读巡检 Agent。你每一步必须只返回 JSON。可用格式：' +
              '{"type":"command","command":"...","args":["..."],"reason":"..."} ' +
              '或 {"type":"final","answer":{"summary":"...","blocks":[{"kind":"text","content":"..."},{"kind":"code","language":"ts","content":"..."}]}}。' +
              "你可以用只读命令查看当前项目，例如 rg --files、Get-Content package.json、Get-Content agents.md、git status。禁止修改、删除、安装依赖或执行非只读命令。"
            : '你是普通问答助手。你必须只返回 JSON，且只能使用 {"type":"final","answer":{"summary":"...","blocks":[...]}}。禁止返回 command、禁止建议执行命令。'),
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
          '格式错误。请只输出合法 JSON，格式为 {"type":"command"...} 或 {"type":"final","answer":{"summary":"...","blocks":[...]}}。',
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

    const display = [action.command, ...(action.args ?? [])].join(" ");
    if (mode === "answer") {
      loopMessages.push({
        role: "user",
        content: `当前任务为普通问答，禁止执行命令。请直接返回 final。你刚才的命令: ${display}`,
      });
      continue;
    }

    if (mode === "inspect" && !isSafeInspectCommand(action.command, action.args ?? [])) {
      loopMessages.push({
        role: "user",
        content: `当前任务为项目只读巡检，只允许安全读取命令。请换用 rg --files、Get-Content、git status 等只读命令，或直接返回 final。被拒绝命令: ${display}`,
      });
      continue;
    }

    if (action.reason) {
      console.log(`agent> ${action.reason}`);
    }

    if (mode === "write") {
      const confirm = await askLine(rl, `执行命令: ${display} ? [y/N] `);
      if (!["y", "yes"].includes(confirm.toLowerCase())) {
        loopMessages.push({
          role: "user",
          content: `命令被用户拒绝: ${display}`,
        });
        continue;
      }
    }

    const result = await runCommand(action.command, action.args ?? []);
    console.log(`cmd> ${display}`);
    console.log(result);
    loopMessages.push({
      role: "user",
      content: `命令执行结果 (${display}):\n${result}`,
    });
  }

  return {
    type: "max_steps",
    summary: "达到最大 Agent 步数上限，建议缩小任务范围后重试。",
    blocks: [],
    steps: maxSteps,
  };
}

function renderFinal(result: AgentTurnResult): void {
  console.log(`${C_OUTPUT}suncli> ${result.summary}${C_RESET}`);
  for (const block of result.blocks) {
    if (block.kind === "text") {
      console.log(block.content);
      continue;
    }
    if (block.kind === "code") {
      const lang = block.language ?? "code";
      console.log(`${C_META}--- ${lang} ---${C_RESET}`);
      console.log(block.content);
      console.log(`${C_META}-------------${C_RESET}`);
    }
  }
}

export async function startChat(): Promise<void> {
  const cfg = loadConfig();
  console.log(`suncli chat (${cfg.model})`);
  console.log("输入 exit 或 /exit 退出，输入 /help 查看可用命令。");

  const history: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a helpful coding assistant in terminal. Keep answers concise and actionable.",
    },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const existingKey = process.env[cfg.apiKeyEnv] ?? cfg.apiKey;
  if (!existingKey) {
    await new Promise<void>((resolve) => {
      console.log("未检测到 API Key。推荐使用 DeepSeek API Key。");
      rl.question("请输入 API Key（直接回车可跳过）: ", (line: string) => {
        const key = line.trim();
        if (key) {
          saveConfig({ apiKey: key });
          console.log("API Key 已保存到本地配置。");
        } else {
          console.log(`你也可以稍后设置环境变量 ${cfg.apiKeyEnv}。`);
        }
        resolve();
      });
    });
  }

  while (true) {
    console.log(hr("INPUT"));
    const input = await askLine(rl, `${C_INPUT}you> ${C_RESET}`);
      if (input === "/exit" || input === "exit") {
        rl.close();
        break;
      }
      if (input === "/help") {
        console.log("可用命令: /help, /exit, exit, /clear");
        continue;
      }
      if (input === "/clear") {
        history.splice(1, history.length - 1);
        console.log("已清空会话上下文。");
        continue;
      }
      const intent = await classifyIntent(input, history);
      if (intent) {
        console.log(
          `${C_META}意图 = ${intent.intent} | confidence=${intent.confidence.toFixed(2)} | risk=${intent.risk}${C_RESET}`,
        );
      }
      if (intent?.risk === "high" || intent?.intent === "高危操作") {
        const ok = await askLine(rl, `${C_META}检测到高危意图，确认继续 Agent 执行? [y/N] ${C_RESET}`);
        if (!["y", "yes"].includes(ok.toLowerCase())) {
          console.log(`${C_OUTPUT}suncli> 已取消本次高危请求。${C_RESET}`);
          continue;
        }
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
      const reply = await runAgentTurn(rl, history, input, mode);
      history.push({ role: "user", content: input });
      history.push({ role: "assistant", content: reply.summary });
      console.log(hr("OUTPUT"));
      renderFinal(reply);
      console.log(
        `${C_META}meta: steps=${reply.steps} model=${cfg.model} ts=${new Date().toISOString()}${C_RESET}`,
      );
  }

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      console.log("bye.");
      resolve();
    });
  });
}
