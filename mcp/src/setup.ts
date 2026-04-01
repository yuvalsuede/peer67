import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { LocalStore } from "./store.js";

function resolveProfile(): { dir: string; mcpKey: string; profile: string | null } {
  const profileArg = process.argv.find((a, i) => process.argv[i - 1] === "--profile");
  if (profileArg) {
    const name = profileArg.toLowerCase().replace(/[^a-z0-9-]/g, "");
    return {
      dir: process.env.PEER67_DIR ?? join(homedir(), `.peer67-${name}`),
      mcpKey: `peer67-${name}`,
      profile: name,
    };
  }
  return {
    dir: process.env.PEER67_DIR ?? join(homedir(), ".peer67"),
    mcpKey: "peer67",
    profile: null,
  };
}

const { dir: PEER67_DIR, mcpKey: MCP_SERVER_KEY, profile: PROFILE } = resolveProfile();

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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

  // Use absolute paths resolved at setup time — Claude Code may not have nvm in PATH
  const nodePath = process.execPath;
  const scriptPath = new URL("./index.js", import.meta.url).pathname;
  const entry: Record<string, unknown> = { command: nodePath, args: [scriptPath] };

  // For profiles, set PEER67_DIR so the MCP server uses the right store
  if (PROFILE) {
    entry.env = { PEER67_DIR };
  }

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
  process.stdout.write("\n  peer67 — encrypted ephemeral messaging\n");
  if (PROFILE) {
    process.stdout.write(`  Profile: ${PROFILE}\n`);
  }
  process.stdout.write("\n");

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

  // Step 2b: Email registration (mandatory — email is your identity)
  const emailArg = process.argv.find((a, i) => process.argv[i - 1] === "--email");
  const emailInput = emailArg ?? await prompt("  Email: ");
  if (!emailInput) {
    process.stdout.write("  Email is required.\n");
    process.exit(1);
  }

  const { registerEmail, pollVerification } = await import("./tools/register.js");
  try {
    const { email_hash } = await registerEmail(store, emailInput);
    process.stdout.write("  Check your email and click the verification link...\n");
    const verified = await pollVerification(store, email_hash, 120, 2000);
    if (verified) {
      await store.updateIdentity({ email: emailInput });
      process.stdout.write(`  \x1b[32m✓\x1b[0m Email verified (${emailInput})\n`);
    } else {
      process.stdout.write(`  \x1b[33m!\x1b[0m Verification timed out. Run "peer67 register ${emailInput}" to retry.\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    process.stdout.write(`  \x1b[31m✗\x1b[0m Registration failed: ${msg}\n`);
    process.stdout.write(`  Run "peer67 register ${emailInput}" to retry.\n`);
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

  if (PROFILE) {
    process.stdout.write(`\n  Ready! Open Claude Code — the "${PROFILE}" profile is available.\n`);
    process.stdout.write(`  Store: ${PEER67_DIR}\n`);
    process.stdout.write(`  MCP server: ${MCP_SERVER_KEY}\n\n`);
  } else {
    process.stdout.write('\n  Ready! Open Claude Code and say "connect me with someone"\n\n');
  }
}
