import { execFileSync } from "node:child_process";
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

// git_diff에서 diff 대상을 고르는 옵션
const DIFF_TARGETS = ["working", "staged", "last-commit"] as const;
type DiffTarget = (typeof DIFF_TARGETS)[number];

interface DiffFile {
  status: string;
  path: string;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function parseNameStatus(raw: string): DiffFile[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed.split("\n").map((line) => {
    const [status = "", ...pathParts] = line.split("\t");
    return { status, path: pathParts.join("\t") };
  });
}

function buildDiffArgs(target: DiffTarget, nameStatus: boolean): string[] {
  const suffix = nameStatus ? ["--name-status"] : [];
  switch (target) {
    case "staged":
      return ["diff", "--cached", ...suffix];
    case "last-commit":
      return nameStatus
        ? ["show", "--format=", "--name-status", "HEAD"]
        : ["show", "--format=", "HEAD"];
    case "working":
    default:
      return ["diff", "HEAD", ...suffix];
  }
}

server.registerTool(
  "git_diff",
  {
    title: "Git Diff",
    description:
      "프로젝트의 git 변경사항을 조회합니다. target으로 워킹 디렉토리 전체 미커밋 변경, staging area, 가장 최근 커밋 중 하나를 고를 수 있고, filePath로 특정 파일/디렉토리로 범위를 좁힐 수 있습니다. 변경된 파일 목록(상태 포함)과 unified diff 본문을 함께 반환합니다.",
    inputSchema: {
      projectPath: z.string().describe("git 레포지토리의 절대 경로"),
      target: z
        .enum(DIFF_TARGETS)
        .optional()
        .describe(
          "diff 대상. working: 워킹 디렉토리의 모든 미커밋 변경(staged+unstaged, 기본값), staged: staging area에 올라간 변경만, last-commit: 가장 최근 커밋(HEAD)의 변경사항"
        ),
      filePath: z
        .string()
        .optional()
        .describe("특정 파일 또는 디렉토리로 diff 범위를 좁힐 때 사용하는 (레포 루트 기준) 상대 경로"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ projectPath, target, filePath }) => {
    const resolvedTarget: DiffTarget = target ?? "working";

    try {
      const nameStatusArgs = buildDiffArgs(resolvedTarget, true);
      const diffArgs = buildDiffArgs(resolvedTarget, false);

      if (filePath) {
        nameStatusArgs.push("--", filePath);
        diffArgs.push("--", filePath);
      }

      const files = parseNameStatus(runGit(nameStatusArgs, projectPath));
      const diff = runGit(diffArgs, projectPath);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { root: projectPath, target: resolvedTarget, files, diff },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `git diff 실행에 실패했습니다: ${(err as Error).message}`,
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
