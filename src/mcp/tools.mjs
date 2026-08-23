/**
 * MCP 工具面：taskboard_* 工具 → REST API 的映射层。
 * 覆盖 Agent 执行循环全流程：列（可认领列表）/ 认（认领）/ 释（释放）/
 * 报（执行报告）/ 移（移列请求验收）/ 评（评论）/ DoD（勾选附证据）＋ 任务详情 ＋ 创建后续任务。
 */
import { z } from 'zod';
import { ApiCallError } from './client.mjs';

const taskIdSchema = z.number().int().positive().describe('任务 id');
const columnSchema = z
  .enum(['to_plan', 'todo', 'in_progress', 'in_review', 'done'])
  .describe('目标列（Agent 仅可 in_progress → in_review；done 为成员专属，ADR-0001）');

export const TOOL_DEFINITIONS = [
  {
    name: 'taskboard_list_claimable',
    description: '列出当前 Agent 可认领的任务（属主「我的空间」、待办列、未指派或指派给自己）',
    inputSchema: {},
  },
  {
    name: 'taskboard_task_detail',
    description: '读取任务详情：任务本体 + 验收清单（DoD，含勾选与证据）+ 评论与执行报告流',
    inputSchema: { taskId: taskIdSchema },
  },
  {
    name: 'taskboard_create_task',
    description:
      '创建后续任务（落属主「我的空间」，初始状态固定为待规划）。执行中发现的新工作用它登记',
    inputSchema: {
      title: z.string().min(1).describe('任务标题'),
      description: z.string().optional().describe('任务描述'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('优先级，默认 medium'),
      labels: z.array(z.string()).optional().describe('标签'),
    },
  },
  {
    name: 'taskboard_claim_task',
    description: '认领任务：待办 → 进行中并独占持有（并发认领只有一个成功，冲突返回错误）',
    inputSchema: { taskId: taskIdSchema },
  },
  {
    name: 'taskboard_release_task',
    description: '释放任务：进行中 → 待办并放弃持有（无法继续执行时主动退回；仅持有者、仅进行中）',
    inputSchema: { taskId: taskIdSchema },
  },
  {
    name: 'taskboard_move_task',
    description: '移动任务（进行中 → 待验收，即请求人工验收）。注意：移入 done 会被协议拒绝',
    inputSchema: { taskId: taskIdSchema, to: columnSchema },
  },
  {
    name: 'taskboard_submit_report',
    description: '提交执行报告：自由文本 + 改动文件列表（仅持有该任务的 Agent 可提交）',
    inputSchema: {
      taskId: taskIdSchema,
      body: z.string().min(1).describe('报告正文'),
      changedFiles: z.array(z.string()).describe('改动文件列表'),
    },
  },
  {
    name: 'taskboard_add_comment',
    description: '在任务下添加评论（与成员互通）',
    inputSchema: { taskId: taskIdSchema, body: z.string().min(1).describe('评论内容') },
  },
  {
    name: 'taskboard_check_dod',
    description: '勾选验收清单（DoD）项并附证据说明（仅持有该任务的 Agent）',
    inputSchema: {
      taskId: taskIdSchema,
      itemId: z.number().int().positive().describe('DoD 项 id（见 taskboard_task_detail）'),
      evidence: z.string().optional().describe('证据说明，如测试输出、改动位置'),
    },
  },
];

/** name → REST 调用映射。 */
const OPERATIONS = {
  taskboard_list_claimable: (client) => client.listClaimable(),
  taskboard_task_detail: (client, args) => client.taskDetail(args.taskId),
  taskboard_create_task: (client, args) =>
    client.createTask({
      title: args.title,
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.labels !== undefined ? { labels: args.labels } : {}),
    }),
  taskboard_claim_task: (client, args) => client.claimTask(args.taskId),
  taskboard_release_task: (client, args) => client.releaseTask(args.taskId),
  taskboard_move_task: (client, args) => client.moveTask(args.taskId, args.to),
  taskboard_submit_report: (client, args) =>
    client.submitReport(args.taskId, args.body, args.changedFiles),
  taskboard_add_comment: (client, args) => client.addComment(args.taskId, args.body),
  taskboard_check_dod: (client, args) => client.checkDod(args.taskId, args.itemId, args.evidence ?? null),
};

const ARG_SCHEMAS = Object.fromEntries(
  TOOL_DEFINITIONS.map((tool) => [tool.name, z.object(tool.inputSchema)]),
);

/**
 * 执行一个工具：参数校验 → REST 映射 → 结果/错误统一为 MCP content。
 * 供 stdio server 与测试共用（测试直接打桩 HTTP 验证映射与透传）。
 */
export async function callTool(client, name, args) {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) {
    return errorResult(`unknown tool: ${name}`);
  }

  const parsed = ARG_SCHEMAS[name].safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return errorResult(`invalid arguments for ${name}: ${issues}`);
  }

  try {
    const payload = await OPERATIONS[name](client, parsed.data);
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (error) {
    if (error instanceof ApiCallError) {
      // 协议错误透传：Agent 依赖机器可读的 code 做下一步决策
      return errorResult(`${error.code}: ${error.message} (HTTP ${error.status})`);
    }
    return errorResult(`tool failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}
