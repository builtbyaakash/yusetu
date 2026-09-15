#!/usr/bin/env node
import { startServer } from "./serve.js";
import { runStdioBridge } from "./stdio.js";

function printHelp(): void {
  console.log(`yusetu — MCP gateway

Usage:
  yusetu serve [--host HOST] [--port PORT]
  yusetu stdio [--port PORT]
  yusetu --help

Commands:
  serve   Start the HTTP control + MCP data plane (default)
  stdio   Stdio MCP bridge that forwards to http://127.0.0.1:$PORT/mcp
`);
}

function parseArgs(argv: string[]) {
  const args = [...argv];
  let command = "serve";
  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift()!;
  }

  const opts: { host?: string; port?: number; help?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--host") opts.host = args[++i];
    else if (a === "--port") opts.port = Number(args[++i]);
    else if (a?.startsWith("--host=")) opts.host = a.slice("--host=".length);
    else if (a?.startsWith("--port=")) opts.port = Number(a.slice("--port=".length));
  }
  return { command, opts };
}

async function main(): Promise<void> {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (opts.help || command === "help") {
    printHelp();
    return;
  }

  if (command === "stdio") {
    await runStdioBridge({ port: opts.port });
    return;
  }

  if (command === "serve") {
    await startServer({
      ...(opts.host !== undefined ? { host: opts.host } : {}),
      ...(opts.port !== undefined && !Number.isNaN(opts.port)
        ? { port: opts.port }
        : {}),
    });
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
