import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { LocalStore } from "./store.js";

const PEER67_DIR = process.env.PEER67_DIR ?? join(homedir(), ".peer67");
const MCP_SERVER_KEY = "peer67";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isGloballyInstalled(): boolean {
  try {
    const result = execSync("which peer67", { encoding: "utf8" }).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

function resolveSettingsPath(): string {
  const primary = join(homedir(), ".claude", "settings.json");
  const legacy = join(homedir(), ".claude.json");

  if (existsSync(primary)) {
    try {
      const data = JSON.parse(readFileSync(primary, "utf8"));
      if (data.mcpServers !== undefined) return primary;
    } catch { /* fall through */ }
  }
  if (existsSync(legacy)) {
    try {
      const data = JSON.parse(readFileSync(legacy, "utf8"));
      if (data.mcpServers !== undefined) return legacy;
    } catch { /* fall through */ }
  }

  return primary;
}

function registerMcpServer(): { alreadyRegistered: boolean; path: string } {
  const settingsPath = resolveSettingsPath();
  const claudeDir = join(settingsPath, "..");

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  }

  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;

  if (mcpServers[MCP_SERVER_KEY]) {
    return { alreadyRegistered: true, path: settingsPath };
  }

  const entry = isGloballyInstalled()
    ? { command: "peer67", args: [] }
    : { command: "npx", args: ["-y", "@peer67/mcp"] };

  const updated = {
    ...settings,
    mcpServers: { ...mcpServers, [MCP_SERVER_KEY]: entry },
  };

  writeFileSync(settingsPath, JSON.stringify(updated, null, 2), "utf8");
  return { alreadyRegistered: false, path: settingsPath };
}

async function checkRelay(relayUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${relayUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

export async function setup(): Promise<void> {
  process.stdout.write("\n  peer67 — encrypted ephemeral messaging\n\n");

  // Step 1: Get name
  const nameArg = process.argv.find((a, i) => process.argv[i - 1] === "--name");
  const name = nameArg ?? await prompt("  What's your name? ");
  if (!name) {
    process.stdout.write("  Name is required.\n");
    process.exit(1);
  }

  // Step 2: Create identity
  const store = new LocalStore(PEER67_DIR);
  await store.init(name);
  process.stdout.write(`  \x1b[32m✓\x1b[0m Identity created as "${name}"\n`);

  // Step 2b: Optional email registration for discovery
  const emailInput = await prompt("  Email (optional, for discovery): ");
  if (emailInput) {
    const { registerEmail, pollVerification } = await import("./tools/register.js");
    const { email_hash } = await registerEmail(store, emailInput);
    process.stdout.write("  Waiting for you to click the verification link...\n");
    const verified = await pollVerification(store, email_hash, 120, 2000);
    if (verified) {
      await store.updateIdentity({ email: emailInput });
      process.stdout.write(`  \x1b[32m✓\x1b[0m Email verified — contacts can now find you as ${emailInput}\n`);
    } else {
      process.stdout.write(`  \x1b[33m!\x1b[0m Verification timed out. Click the link in your email later, or run "peer67 register <email>" to retry.\n`);
    }
  }

  // Step 3: Register MCP server
  const { alreadyRegistered, path } = registerMcpServer();
  if (alreadyRegistered) {
    process.stdout.write(`  \x1b[32m✓\x1b[0m MCP server already registered\n`);
  } else {
    process.stdout.write(`  \x1b[32m✓\x1b[0m MCP server registered in ${path}\n`);
  }

  // Step 4: Check relay
  const config = await store.getConfig();
  const relayOk = await checkRelay(config.default_relay);
  if (relayOk) {
    process.stdout.write(`  \x1b[32m✓\x1b[0m Relay reachable (${config.default_relay})\n`);
  } else {
    process.stdout.write(`  \x1b[33m!\x1b[0m Relay not reachable (messaging works when it's back)\n`);
  }

  process.stdout.write('\n  Ready! Open Claude Code and say "connect me with someone"\n\n');
}
