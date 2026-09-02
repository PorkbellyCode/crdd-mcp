import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "crdd-mcp",
  version: "0.1.0",
});

// 트리 탐색에서 제외할 노이즈성 디렉토리
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

interface TreeNode {
  name: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

function buildTree(dirPath: string, depth: number, maxDepth: number): TreeNode[] {
  if (depth > maxDepth) {
    return [];
  }

  const entries = readdirSync(dirPath, { withFileTypes: true }).filter(
    (entry) => !IGNORE_DIRS.has(entry.name)
  );

  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          type: "dir" as const,
          children: buildTree(fullPath, depth + 1, maxDepth),
        };
      }
      return { name: entry.name, type: "file" as const };
    });
}

server.registerTool(
  "inspect_project",
  {
    title: "Inspect Project",
    description:
      "주어진 프로젝트 루트 경로의 디렉토리 구조를 분석해서 반환합니다. node_modules, .git 같은 노이즈 디렉토리는 제외합니다.",
    inputSchema: {
      projectPath: z.string().describe("분석할 프로젝트의 절대 경로"),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(6)
        .optional()
        .describe("탐색할 최대 디렉토리 깊이 (기본값 3)"),
    },
  },
  async ({ projectPath, maxDepth }) => {
    try {
      const tree = buildTree(projectPath, 0, maxDepth ?? 3);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ root: projectPath, tree }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `프로젝트 경로를 읽는 데 실패했습니다: ${(err as Error).message}`,
          },
        ],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("CRDD MCP server failed to start:", err);
  process.exit(1);
});
