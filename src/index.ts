import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getStorePath, loadStore, saveStore } from "./storage.js";

const server = new McpServer({
  name: "crdd-mcp",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// 공통 상수 / 헬퍼
// ---------------------------------------------------------------------------

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

// 검색 대상에서 제외할 lock 파일 (내용이 크고 이해도와 무관한 노이즈)
const LOCK_FILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
]);

// 시크릿이 담길 가능성이 높아 LLM 컨텍스트로 올리면 안 되는 파일
const SENSITIVE_FILE_PATTERNS = [
  /^\.env($|\.)/,
  /^id_rsa($|\.)/,
  /\.pem$/,
  /\.key$/,
  /^credentials$/,
];

const MAX_READ_BYTES = 200 * 1024; // read_file 단일 파일 상한
const MAX_SEARCH_FILE_BYTES = 512 * 1024; // search_code에서 스캔할 파일 상한
const MAX_SCAN_FILES = 5000; // search_code에서 훑을 파일 개수 상한
const MAX_QUIZ_FILE_BYTES = 40 * 1024; // generate_quiz 자료에 담을 파일당 상한
const MAX_QUIZ_DIFF_CHARS = 60000; // generate_quiz 자료에 담을 diff 상한

function isSensitiveFile(fileName: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

/**
 * filePath가 projectPath 밖으로 벗어나지 못하게 막고 절대 경로를 돌려준다.
 * (../.. 같은 경로로 프로젝트 외부 파일을 읽는 것을 방지)
 */
function resolveInside(projectPath: string, filePath: string): string {
  const root = resolve(projectPath);
  const target = resolve(root, filePath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(
      `프로젝트 루트 밖의 경로에는 접근할 수 없습니다: ${filePath}`
    );
  }
  return target;
}

/** NUL 바이트가 있으면 바이너리로 간주한다 */
function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

interface ReadResult {
  content: string;
  bytes: number;
  truncated: boolean;
}

/** 텍스트 파일을 상한까지만 읽는다. 바이너리면 예외를 던진다. */
function readTextFile(absolutePath: string, maxBytes: number): ReadResult {
  const buffer = readFileSync(absolutePath);
  if (isProbablyBinary(buffer)) {
    throw new Error("바이너리 파일은 읽을 수 없습니다.");
  }
  const truncated = buffer.length > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  return {
    content: slice.toString("utf-8"),
    bytes: buffer.length,
    truncated,
  };
}

/** 정규식 메타문자를 이스케이프해서 리터럴 검색으로 만든다 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** IGNORE_DIRS를 건너뛰며 파일 절대 경로를 모은다 (심볼릭 링크는 순환 방지를 위해 제외) */
function walkFiles(currentPath: string, acc: string[], limit: number): void {
  if (acc.length >= limit) {
    return;
  }

  let entries;
  try {
    entries = readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return; // 권한이 없는 디렉토리는 조용히 건너뛴다
  }

  for (const entry of entries) {
    if (acc.length >= limit) {
      return;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        walkFiles(join(currentPath, entry.name), acc, limit);
      }
      continue;
    }
    if (entry.isFile()) {
      acc.push(join(currentPath, entry.name));
    }
  }
}

function textContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorContent(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// inspect_project
// ---------------------------------------------------------------------------

// CRDD 파일 가중치 설계 — 1단계: 경로 기반 tier.
// AST 없이도 "대충 맞는 우선순위"를 매기기 위한 첫 시그널이다. fan-in(피참조
// 횟수), 경계/위험 파일 보너스는 다음 단계에서 추가하고, 그때 critical/core
// tier가 더해진다. 지금은 peripheral(테스트/설정/문서류)과 나머지(normal)
// 두 단계만 구분한다.
type FileTier = "peripheral" | "normal";

const TIER_WEIGHTS: Record<FileTier, number> = {
  peripheral: 0.3,
  normal: 1,
};

// 이 이름의 디렉터리 아래에 있는 파일은 peripheral로 본다
const PERIPHERAL_DIR_NAMES = new Set([
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "docs",
  "doc",
  "examples",
  "example",
  ".github",
]);

// 파일명이 이 패턴에 매치하면 peripheral로 본다 (설정/문서/라이선스류)
const PERIPHERAL_FILE_PATTERNS = [
  /\.config\.[cm]?[jt]sx?$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^vitest\.config/i,
  /^jest\.config/i,
  /^README(\.[a-z0-9]+)?$/i,
  /^CHANGELOG(\.[a-z0-9]+)?$/i,
  /^LICENSE(\.[a-z0-9]+)?$/i,
  /\.md$/i,
];

/** 프로젝트 루트 기준 상대 경로만 보고 tier를 판정한다 (fan-in 없이도 계산 가능) */
function getFileTier(relativePath: string): FileTier {
  const segments = relativePath.split("/");
  const fileName = segments[segments.length - 1] ?? relativePath;
  const dirSegments = segments.slice(0, -1);

  if (dirSegments.some((segment) => PERIPHERAL_DIR_NAMES.has(segment))) {
    return "peripheral";
  }
  if (PERIPHERAL_FILE_PATTERNS.some((pattern) => pattern.test(fileName))) {
    return "peripheral";
  }
  return "normal";
}

interface TreeNode {
  name: string;
  type: "file" | "dir";
  children?: TreeNode[];
  /** 파일에만 표시된다. 경로 기반 tier (fan-in/경계 보너스 반영 전 1단계) */
  tier?: FileTier;
  /** TIER_WEIGHTS[tier]와 동일한 값. concept 가중치 계산에 바로 쓸 수 있게 함께 반환 */
  weight?: number;
}

function buildTree(
  dirPath: string,
  depth: number,
  maxDepth: number,
  relPath = ""
): TreeNode[] {
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
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          type: "dir" as const,
          children: buildTree(fullPath, depth + 1, maxDepth, entryRelPath),
        };
      }
      const tier = getFileTier(entryRelPath);
      return {
        name: entry.name,
        type: "file" as const,
        tier,
        weight: TIER_WEIGHTS[tier],
      };
    });
}

server.registerTool(
  "inspect_project",
  {
    title: "Inspect Project",
    description:
      "주어진 프로젝트 루트 경로의 디렉토리 구조를 분석해서 반환합니다. node_modules, .git 같은 노이즈 디렉토리는 제외합니다. 각 파일에는 경로 기반 중요도 tier(peripheral/normal)와 weight가 함께 표시됩니다 — 아직 fan-in/경계 파일 보너스는 반영되지 않은 1단계 근사치입니다.",
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
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ projectPath, maxDepth }) => {
    try {
      const tree = buildTree(projectPath, 0, maxDepth ?? 3);
      return textContent({ root: projectPath, tree });
    } catch (err) {
      return errorContent(
        `프로젝트 경로를 읽는 데 실패했습니다: ${(err as Error).message}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

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

/** 현재 HEAD commit SHA. generate_quiz가 퀴즈 생성 시점을 기록하기 위해 사용한다. */
function getHeadSha(projectPath: string): string {
  return runGit(["rev-parse", "HEAD"], projectPath).trim();
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

interface DiffResult {
  target: DiffTarget;
  files: DiffFile[];
  diff: string;
}

function collectDiff(
  projectPath: string,
  target: DiffTarget,
  filePath?: string
): DiffResult {
  const nameStatusArgs = buildDiffArgs(target, true);
  const diffArgs = buildDiffArgs(target, false);

  if (filePath) {
    nameStatusArgs.push("--", filePath);
    diffArgs.push("--", filePath);
  }

  return {
    target,
    files: parseNameStatus(runGit(nameStatusArgs, projectPath)),
    diff: runGit(diffArgs, projectPath),
  };
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
        .describe(
          "특정 파일 또는 디렉토리로 diff 범위를 좁힐 때 사용하는 (레포 루트 기준) 상대 경로"
        ),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ projectPath, target, filePath }) => {
    const resolvedTarget: DiffTarget = target ?? "working";

    try {
      const result = collectDiff(projectPath, resolvedTarget, filePath);
      return textContent({ root: projectPath, ...result });
    } catch (err) {
      return errorContent(
        `git diff 실행에 실패했습니다: ${(err as Error).message}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

server.registerTool(
  "read_file",
  {
    title: "Read File",
    description:
      "프로젝트 안의 특정 파일 내용을 읽어서 반환합니다. startLine/endLine으로 범위를 좁힐 수 있습니다. 프로젝트 루트 밖의 경로, 바이너리 파일, .env 같은 시크릿 파일은 거부합니다.",
    inputSchema: {
      projectPath: z.string().describe("프로젝트 루트의 절대 경로"),
      filePath: z
        .string()
        .describe("읽을 파일의 (프로젝트 루트 기준) 상대 경로"),
      startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("읽기 시작할 줄 번호 (1부터 시작, 기본값 1)"),
      endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("읽기를 끝낼 줄 번호 (포함, 기본값은 파일 끝)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ projectPath, filePath, startLine, endLine }) => {
    try {
      const absolutePath = resolveInside(projectPath, filePath);
      const fileName = absolutePath.split(sep).pop() ?? "";

      if (isSensitiveFile(fileName)) {
        return errorContent(
          `시크릿이 담길 수 있는 파일이라 읽지 않습니다: ${filePath}`
        );
      }

      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        return errorContent(`파일이 아닙니다: ${filePath}`);
      }

      const { content, bytes, truncated } = readTextFile(
        absolutePath,
        MAX_READ_BYTES
      );
      const lines = content.split("\n");
      const totalLines = lines.length;

      const from = Math.min(startLine ?? 1, totalLines);
      const to = Math.min(endLine ?? totalLines, totalLines);

      if (from > to) {
        return errorContent(
          `startLine(${from})이 endLine(${to})보다 클 수 없습니다.`
        );
      }

      return textContent({
        path: filePath,
        bytes,
        totalLines,
        startLine: from,
        endLine: to,
        // 파일이 상한(200KB)을 넘어 잘렸다면 그 사실을 명시한다
        truncatedByteLimit: truncated,
        content: lines.slice(from - 1, to).join("\n"),
      });
    } catch (err) {
      return errorContent(
        `파일을 읽는 데 실패했습니다: ${(err as Error).message}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// search_code
// ---------------------------------------------------------------------------

interface SearchMatch {
  path: string;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

interface SearchOptions {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  extensions?: string[];
  maxResults: number;
  contextLines: number;
}

function searchProject(projectPath: string, options: SearchOptions) {
  const root = resolve(projectPath);
  const files: string[] = [];
  walkFiles(root, files, MAX_SCAN_FILES);

  const pattern = new RegExp(
    options.isRegex ? options.query : escapeRegExp(options.query),
    options.caseSensitive ? "" : "i"
  );

  const matches: SearchMatch[] = [];
  let scannedFiles = 0;
  let truncated = false;

  for (const absolutePath of files) {
    if (matches.length >= options.maxResults) {
      truncated = true;
      break;
    }

    const fileName = absolutePath.split(sep).pop() ?? "";
    if (LOCK_FILES.has(fileName) || isSensitiveFile(fileName)) {
      continue;
    }
    if (
      options.extensions &&
      !options.extensions.some((ext) => fileName.endsWith(ext))
    ) {
      continue;
    }

    let result: ReadResult;
    try {
      if (statSync(absolutePath).size > MAX_SEARCH_FILE_BYTES) {
        continue;
      }
      result = readTextFile(absolutePath, MAX_SEARCH_FILE_BYTES);
    } catch {
      continue; // 바이너리이거나 읽을 수 없는 파일은 건너뛴다
    }

    scannedFiles += 1;
    const lines = result.content.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!pattern.test(line)) {
        continue;
      }
      if (matches.length >= options.maxResults) {
        truncated = true;
        break;
      }

      const match: SearchMatch = {
        path: relative(root, absolutePath),
        line: index + 1,
        text: line,
      };

      if (options.contextLines > 0) {
        match.before = lines.slice(
          Math.max(0, index - options.contextLines),
          index
        );
        match.after = lines.slice(index + 1, index + 1 + options.contextLines);
      }

      matches.push(match);
    }
  }

  return { scannedFiles, matchCount: matches.length, truncated, matches };
}

server.registerTool(
  "search_code",
  {
    title: "Search Code",
    description:
      "프로젝트 코드베이스에서 키워드나 정규식으로 검색합니다. node_modules 같은 노이즈 디렉토리, lock 파일, 바이너리, .env 같은 시크릿 파일은 자동으로 제외합니다. 특정 개념과 관련된 코드가 어디에 있는지 찾을 때 사용합니다.",
    inputSchema: {
      projectPath: z.string().describe("프로젝트 루트의 절대 경로"),
      query: z.string().describe("검색할 문자열 또는 정규식 패턴"),
      isRegex: z
        .boolean()
        .optional()
        .describe("query를 정규식으로 해석할지 여부 (기본값 false)"),
      caseSensitive: z
        .boolean()
        .optional()
        .describe("대소문자를 구분할지 여부 (기본값 false)"),
      extensions: z
        .array(z.string())
        .optional()
        .describe('검색할 확장자 목록 (예: [".ts", ".tsx"]). 생략하면 전체'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("반환할 최대 매치 수 (기본값 50)"),
      contextLines: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe("각 매치의 앞뒤로 함께 반환할 줄 수 (기본값 0)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({
    projectPath,
    query,
    isRegex,
    caseSensitive,
    extensions,
    maxResults,
    contextLines,
  }) => {
    try {
      const options: SearchOptions = {
        query,
        isRegex: isRegex ?? false,
        caseSensitive: caseSensitive ?? false,
        maxResults: maxResults ?? 50,
        contextLines: contextLines ?? 0,
      };
      if (extensions) {
        options.extensions = extensions;
      }

      const result = searchProject(projectPath, options);
      return textContent({ root: projectPath, query, ...result });
    } catch (err) {
      return errorContent(`검색에 실패했습니다: ${(err as Error).message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// generate_quiz
//
// 중요: 이 tool은 질문 문장을 직접 만들지 않는다. 프로젝트의 실제 자료(구조/diff/
// 파일 내용)를 모아서 반환하고, 질문 생성과 채점은 호출한 쪽(Claude)이 담당한다.
// 서버는 "무엇을 근거로 물어볼지"와 "어떤 형식으로 답을 만들지"만 정의한다.
// ---------------------------------------------------------------------------

const QUIZ_SOURCES = ["diff", "files", "structure"] as const;
type QuizSource = (typeof QUIZ_SOURCES)[number];

const QUIZ_LEVELS = ["awareness", "understanding", "reasoning"] as const;

const QUIZ_INSTRUCTIONS = [
  "아래 material은 CRDD가 수집한 이 프로젝트의 실제 자료입니다. 다음 규칙에 따라 퀴즈를 생성하세요.",
  "1. 일반적인 프로그래밍 상식 퀴즈를 만들지 마세요. 반드시 material에 담긴 이 프로젝트의 구조/코드/변경사항에 근거한 질문만 만듭니다.",
  "2. 각 질문에 이해도 단계(level)를 지정하세요. awareness: 이 코드가 존재하고 어떤 역할인지 아는가 / understanding: 동작 과정과 데이터 흐름을 설명할 수 있는가 / reasoning: 왜 이렇게 설계했는지, 다른 선택지 대비 트레이드오프를 설명할 수 있는가.",
  "3. 각 질문에 rubric을 반드시 포함하세요. rubric은 '정답에 반드시 포함돼야 하는 핵심 포인트' 목록입니다. 이후 evaluate_answer가 이 rubric으로 채점하므로, 세션이 달라져도 채점 기준이 흔들리지 않도록 구체적으로 작성해야 합니다.",
  "4. 답을 미리 알려주지 마세요. 질문만 제시하고, 사용자의 답변을 받은 뒤 rubric으로 평가합니다.",
  "5. material 안에서 근거를 확인할 수 있는 질문만 만드세요. 추측해야만 답할 수 있는 질문은 제외합니다.",
  "6. 사용자 답변을 rubric으로 채점한 뒤에는, 이 응답에 담긴 commit 값을 evaluate_answer의 commit 파라미터로 그대로 넘겨서 채점 결과를 저장하세요.",
].join("\n");

const QUIZ_RESPONSE_SCHEMA = {
  questions: [
    {
      id: "q1",
      level: "understanding (awareness | understanding | reasoning 중 하나)",
      concept: "이 질문이 속한 개념/영역 이름",
      question: "사용자에게 보여줄 질문 문장",
      relatedFiles: ["질문의 근거가 되는 파일 경로"],
      rubric: ["정답에 반드시 포함돼야 하는 핵심 포인트 1", "핵심 포인트 2"],
    },
  ],
};

interface QuizFileMaterial {
  path: string;
  content: string;
  truncated: boolean;
  error?: string;
}

function collectQuizFiles(
  projectPath: string,
  filePaths: string[]
): QuizFileMaterial[] {
  return filePaths.map((filePath) => {
    try {
      const absolutePath = resolveInside(projectPath, filePath);
      const fileName = absolutePath.split(sep).pop() ?? "";
      if (isSensitiveFile(fileName)) {
        return {
          path: filePath,
          content: "",
          truncated: false,
          error: "시크릿이 담길 수 있는 파일이라 제외했습니다.",
        };
      }
      const { content, truncated } = readTextFile(
        absolutePath,
        MAX_QUIZ_FILE_BYTES
      );
      return { path: filePath, content, truncated };
    } catch (err) {
      return {
        path: filePath,
        content: "",
        truncated: false,
        error: (err as Error).message,
      };
    }
  });
}

server.registerTool(
  "generate_quiz",
  {
    title: "Generate Quiz",
    description:
      "프로젝트 기반 퀴즈를 만들기 위한 자료를 수집해서 반환합니다. 이 tool 자체는 질문 문장을 만들지 않고, 프로젝트 구조와 (source에 따라) diff 또는 파일 내용, 그리고 질문 생성 규칙과 응답 스키마를 함께 돌려줍니다. 실제 질문 생성은 이 결과를 받은 쪽에서 수행합니다.",
    inputSchema: {
      projectPath: z.string().describe("프로젝트 루트의 절대 경로"),
      source: z
        .enum(QUIZ_SOURCES)
        .optional()
        .describe(
          "퀴즈 자료의 출처. diff: 최근 변경사항 기반(기본값), files: 지정한 파일들의 내용 기반(이미 작성된 코드 학습용), structure: 프로젝트 구조만 기반(콜드 스타트 진단용)"
        ),
      target: z
        .enum(DIFF_TARGETS)
        .optional()
        .describe("source가 diff일 때 어떤 변경을 볼지 (기본값 working)"),
      files: z
        .array(z.string())
        .optional()
        .describe("source가 files일 때 읽을 파일들의 상대 경로 목록"),
      concept: z
        .string()
        .optional()
        .describe("이 퀴즈가 다루는 개념/영역 이름 (예: Audio Pipeline)"),
      questionCount: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("생성을 요청할 질문 개수 (기본값 5)"),
      levels: z
        .array(z.enum(QUIZ_LEVELS))
        .optional()
        .describe("출제할 이해도 단계 목록 (기본값: 세 단계 모두)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({
    projectPath,
    source,
    target,
    files,
    concept,
    questionCount,
    levels,
  }) => {
    const resolvedSource: QuizSource = source ?? "diff";

    try {
      // evaluate_answer가 "이 퀴즈는 어느 commit 시점 코드를 근거로 냈는지"를
      // 알아야 lastVerifiedCommit을 정확히 기록할 수 있어 항상 같이 반환한다.
      const commit = getHeadSha(projectPath);

      // 어떤 source든 프로젝트 구조는 배경 맥락으로 항상 포함한다
      const material: Record<string, unknown> = {
        structure: buildTree(projectPath, 0, 2),
      };

      if (resolvedSource === "diff") {
        const diffResult = collectDiff(projectPath, target ?? "working");

        if (diffResult.files.length === 0) {
          return errorContent(
            `변경사항이 없어서 diff 기반 퀴즈를 만들 자료가 없습니다 (target: ${diffResult.target}). 이미 작성된 코드로 퀴즈를 내려면 source를 "files"로, 프로젝트 구조 진단은 "structure"로 호출하세요.`
          );
        }

        const diffTruncated = diffResult.diff.length > MAX_QUIZ_DIFF_CHARS;
        material["diff"] = {
          target: diffResult.target,
          files: diffResult.files,
          truncated: diffTruncated,
          patch: diffTruncated
            ? diffResult.diff.slice(0, MAX_QUIZ_DIFF_CHARS)
            : diffResult.diff,
        };
      }

      if (resolvedSource === "files") {
        if (!files || files.length === 0) {
          return errorContent(
            'source가 "files"일 때는 files 파라미터에 읽을 파일 경로를 하나 이상 지정해야 합니다.'
          );
        }
        material["files"] = collectQuizFiles(projectPath, files);
      }

      const payload: Record<string, unknown> = {
        projectPath,
        commit,
        source: resolvedSource,
        requestedQuestionCount: questionCount ?? 5,
        targetLevels: levels ?? [...QUIZ_LEVELS],
        material,
        instructions: QUIZ_INSTRUCTIONS,
        responseSchema: QUIZ_RESPONSE_SCHEMA,
      };
      if (concept) {
        payload["concept"] = concept;
      }

      return textContent(payload);
    } catch (err) {
      return errorContent(
        `퀴즈 자료를 수집하는 데 실패했습니다: ${(err as Error).message}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// evaluate_answer
//
// 이 tool은 채점을 하지 않는다. rubric 대비 정답 판정은 generate_quiz와
// 마찬가지로 호출한 쪽(Claude)이 이미 끝낸 상태로 넘어온다. 서버는 그 결과를
// storage.ts의 concept/history 스키마에 반영해서 저장하기만 한다.
// ---------------------------------------------------------------------------

const ANSWER_OUTCOMES = [
  "first_try",
  "after_hint",
  "after_explanation",
  "unresolved",
] as const;
type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];

// CRDD 오답 처리와 학습 루프 설계: 정답에 도달하기까지 힌트/설명을 거칠수록
// "스스로 이해한 정도"는 낮다고 보고 배점을 차등한다. 첫 시도 채점과 설명을
// 읽고 맞춘 채점을 같은 점수로 처리하면 이해도 추이 자체가 무의미해진다.
const OUTCOME_WEIGHTS: Record<AnswerOutcome, number> = {
  first_try: 1,
  after_hint: 0.6,
  after_explanation: 0.3,
  unresolved: 0,
};

server.registerTool(
  "evaluate_answer",
  {
    title: "Evaluate Answer",
    description:
      "generate_quiz로 낸 퀴즈에 대해 이미 채점이 끝난 결과를 이해도 점수 저장소에 반영합니다. 이 tool 자체는 채점하지 않습니다 — rubric 대비 정답 여부 판단은 호출한 쪽(Claude)이 끝낸 뒤, 그 결과(개념별 outcome)만 저장합니다.",
    inputSchema: {
      projectPath: z.string().describe("프로젝트 루트의 절대 경로"),
      commit: z
        .string()
        .describe(
          "퀴즈가 생성된 시점의 commit SHA (generate_quiz 응답의 commit 값을 그대로 전달)"
        ),
      answers: z
        .array(
          z.object({
            concept: z.string().describe("이 답변이 속한 개념/영역 이름"),
            outcome: z
              .enum(ANSWER_OUTCOMES)
              .describe(
                "first_try: 첫 시도에 정답(배점 1.0) / after_hint: 놓친 포인트를 알려준 뒤 정답(0.6) / after_explanation: 설명을 보고 재답변해서 정답(0.3) / unresolved: 끝까지 rubric을 충족하지 못함(0.0)"
              ),
            files: z
              .array(z.string())
              .optional()
              .describe(
                "이 질문의 근거가 된 파일 경로들 (개념-파일 매핑을 갱신/누적하는 데 사용)"
              ),
          })
        )
        .min(1)
        .describe(
          "이번 퀴즈 세션에서 채점이 끝난 답변들 (한 세션에 여러 개념이 섞여 있어도 됨)"
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
  },
  async ({ projectPath, commit, answers }) => {
    try {
      const store = loadStore(projectPath);
      const now = new Date().toISOString();

      // concept별로 답변을 묶는다 (한 퀴즈 세션이 여러 개념을 다룰 수 있으므로)
      const grouped = new Map<string, typeof answers>();
      for (const answer of answers) {
        const bucket = grouped.get(answer.concept);
        if (bucket) {
          bucket.push(answer);
        } else {
          grouped.set(answer.concept, [answer]);
        }
      }

      const results: Array<{
        concept: string;
        scoreBefore: number;
        scoreAfter: number;
        delta: number;
        correct: number;
        total: number;
        files: string[];
        lastVerifiedCommit: string;
      }> = [];

      for (const [concept, conceptAnswers] of grouped) {
        const correct = conceptAnswers.reduce(
          (sum, answer) => sum + OUTCOME_WEIGHTS[answer.outcome],
          0
        );
        const total = conceptAnswers.length;
        // MVP 점수 공식: 영역별 quiz 문항 수 대비 (배점 반영) 정답 비율.
        const scoreAfter = Math.round((correct / total) * 100);

        const existing = store.concepts[concept];
        const scoreBefore = existing?.score ?? 0;

        const newFiles = conceptAnswers.flatMap((answer) => answer.files ?? []);
        const mergedFiles = Array.from(
          new Set([...(existing?.files ?? []), ...newFiles])
        );

        store.concepts[concept] = {
          score: scoreAfter,
          files: mergedFiles,
          lastVerifiedCommit: commit,
          lastQuizAt: now,
        };

        store.history.push({
          at: now,
          commit,
          concept,
          correct,
          total,
          scoreBefore,
          scoreAfter,
        });

        results.push({
          concept,
          scoreBefore,
          scoreAfter,
          delta: scoreAfter - scoreBefore,
          correct,
          total,
          files: mergedFiles,
          lastVerifiedCommit: commit,
        });
      }

      saveStore(store);

      return textContent({
        projectId: store.projectId,
        storePath: getStorePath(store.projectId),
        results,
      });
    } catch (err) {
      return errorContent(
        `채점 결과를 저장하는 데 실패했습니다: ${(err as Error).message}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// 서버 기동
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("CRDD MCP server failed to start:", err);
  process.exit(1);
});
