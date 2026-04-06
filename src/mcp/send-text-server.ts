#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "send-text",
  version: "1.0.0",
});

server.tool(
  "send_text",
  "Send a text message to the user in the current chat topic. Use this to deliver results, summaries, or any text content to the user. Do NOT call the Telegram API directly — use this tool instead.",
  { text: z.string().describe("The message text to send to the user") },
  async ({ text }) => {
    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Message queued for delivery (${text.length} chars)`,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
