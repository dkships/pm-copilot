#!/usr/bin/env node
// Local MCP tool runner — call a pm-copilot tool in isolation, no Claude Code restart.
//
// Usage (build first so dist/ exists):
//   npm run build && npm run tool -- --list
//   npm run tool -- <tool_name> '<json-params>'
//   e.g. npm run tool -- get_feature_requests '{"portal_name":"acme","status":"open"}'
//
// NOTE: tool output may include configured source names/URLs (and, for the
// analysis tools, customer text that has already been PII-scrubbed). Redact
// before pasting anywhere shared.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "index.js");
const [name, rawParams] = process.argv.slice(2);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
});
const client = new Client({ name: "pm-copilot-tool-runner", version: "1.0.0" });
await client.connect(transport);

try {
  if (!name || name === "--list") {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name} — ${t.title ?? ""}`);
  } else {
    const result = await client.callTool({
      name,
      arguments: rawParams ? JSON.parse(rawParams) : {},
    });
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
    console.error("[note] output may include source names/URLs — redact before sharing");
    if (result.isError) console.error("[error] tool returned isError");
    console.log(text);
    console.error(`[size] ${Buffer.byteLength(text, "utf8")} bytes`);
  }
} finally {
  await client.close();
}
