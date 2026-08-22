#!/usr/bin/env node
/**
 * 任务看板 MCP server（stdio，独立进程）。
 * 以 taskboard_* 工具封装看板 REST API，供 Claude Code 等 MCP 客户端接入。
 *
 * 配置（环境变量）：
 *   TASKBOARD_TOKEN     Agent API token（必填，看板 /agents 页创建）
 *   TASKBOARD_API_BASE  看板地址（默认 http://localhost:3000）
 *
 * Claude Code 接入：
 *   claude mcp add taskboard --env TASKBOARD_TOKEN=kbt_xxx -- node src/mcp/server.mjs
 * 详见 docs/agents/mcp.md。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TaskboardClient } from './client.mjs';
import { TOOL_DEFINITIONS, callTool } from './tools.mjs';

const client = new TaskboardClient();

const server = new McpServer({ name: 'taskboard', version: '0.1.0' });

for (const tool of TOOL_DEFINITIONS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema },
    async (args) => callTool(client, tool.name, args),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`taskboard MCP server ready (api: ${client.baseUrl})`);
