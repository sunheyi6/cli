#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { startChat } from "./chat.js";
import { getConfigPath, loadConfig, saveConfig } from "./config.js";

const program = new Command();

program
  .name("suncli-ts")
  .description("Terminal-native TypeScript CLI agent (inspired by kimi-code)")
  .version("0.1.0");

program
  .command("hello")
  .description("Say hello")
  .option("-n, --name <name>", "Name to greet", "world")
  .action((opts: { name: string }) => {
    console.log(`hello, ${opts.name}`);
  });

program
  .command("run")
  .description("Run a local command")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument("<cmd>", "Command name, e.g. git")
  .argument("[args...]", "Command arguments")
  .action((cmd: string, args: string[]) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: true });

    child.on("exit", (code: number | null) => {
      process.exit(code ?? 0);
    });

    child.on("error", (err: Error) => {
      console.error("Failed to execute command:", err.message);
      process.exit(1);
    });
  });

program
  .command("chat")
  .description("Start interactive chat mode")
  .action(async () => {
    await startChat();
  });

const configCommand = program.command("config").description("Manage local config");

configCommand
  .command("show")
  .description("Show merged config")
  .action(() => {
    const cfg = loadConfig();
    const masked = {
      ...cfg,
      apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}...` : undefined,
    };
    console.log(JSON.stringify(masked, null, 2));
    console.log(`path: ${getConfigPath()}`);
  });

configCommand
  .command("set")
  .description("Set config fields")
  .option("--model <model>", "Model name, e.g. deepseek-chat")
  .option("--api-base-url <url>", "API base URL")
  .option("--api-key-env <name>", "API key env var name, e.g. DEEPSEEK_API_KEY")
  .option("--api-key <key>", "API key value (stored locally)")
  .action((opts: { model?: string; apiBaseUrl?: string; apiKeyEnv?: string; apiKey?: string }) => {
    const next = saveConfig({
      model: opts.model,
      apiBaseUrl: opts.apiBaseUrl,
      apiKeyEnv: opts.apiKeyEnv,
      apiKey: opts.apiKey,
    });
    console.log("saved config:");
    console.log(JSON.stringify(next, null, 2));
  });

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    await startChat();
    return;
  }
  program.parse();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`fatal: ${msg}`);
  process.exit(1);
});
