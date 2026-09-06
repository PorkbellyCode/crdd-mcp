import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// 이해도 점수 저장소
//
// 인지부채 점수는 "프로젝트"가 아니라 "이 개발자와 이 프로젝트 사이의 관계"에
// 속하는 값이므로, 레포 안(<repo>/.crdd/)이 아니라 사용자 홈 디렉터리 아래
// (~/.crdd/projects/<첫 커밋 SHA>.json)에 저장한다.
// (설계 근거: 프로젝트 문서 "CRDD 이해도 점수 유지 설계")
// ---------------------------------------------------------------------------

/** history 배열이 무한히 커지지 않도록 두는 상한 */
const HISTORY_LIMIT = 200;

export interface ConceptRecord {
  /** 0~100 사이의 이해도 점수 */
  score: number;
  /** 이 개념이 걸쳐 있는 파일들의 (프로젝트 루트 기준) 상대 경로 */
  files: string[];
  /** 이 개념을 마지막으로 quiz로 검증했을 때의 commit SHA */
  lastVerifiedCommit: string;
  /** 마지막으로 quiz를 본 시각 (ISO 8601) */
  lastQuizAt: string;
}

export interface HistoryEntry {
  /** 기록 시각 (ISO 8601) */
  at: string;
  /** 채점 시점의 commit SHA */
  commit: string;
  concept: string;
  correct: number;
  total: number;
  scoreBefore: number;
  scoreAfter: number;
}

export interface ProjectStore {
  /** 첫 커밋 SHA. 폴더 이동/이름 변경/다른 머신 clone에도 안 변하는 식별자 */
  projectId: string;
  /** 참고용 표시 경로일 뿐, 식별 키로 쓰지 않는다 */
  projectPath: string;
  updatedAt: string;
  concepts: Record<string, ConceptRecord>;
  history: HistoryEntry[];
}

/** ~/.crdd (CRDD_DATA_DIR 환경변수로 덮어쓸 수 있음) */
export function resolveDataDir(): string {
  return process.env["CRDD_DATA_DIR"] || join(homedir(), ".crdd");
}

export function getStorePath(projectId: string): string {
  return join(resolveDataDir(), "projects", `${projectId}.json`);
}

/**
 * 프로젝트의 첫 커밋 SHA를 프로젝트 식별자로 사용한다.
 * 경로 이동/이름 변경/다른 머신에서의 clone과 무관하게 유지되는
 * 유일한 값이기 때문이다 (경로나 remote URL은 식별 키로 쓰지 않는다).
 * 여러 root commit이 있는 저장소는 드문 케이스이므로 그중 첫 줄만 사용한다.
 */
export function getProjectId(projectPath: string): string {
  let output: string;
  try {
    output = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: projectPath,
      encoding: "utf-8",
    });
  } catch (err) {
    throw new Error(
      `git 저장소가 아니거나 커밋이 없어 프로젝트 식별자를 만들 수 없습니다: ${(err as Error).message}`
    );
  }

  const firstRoot = output.trim().split("\n")[0]?.trim();
  if (!firstRoot) {
    throw new Error("첫 커밋 SHA를 찾을 수 없습니다 (커밋이 없는 저장소).");
  }
  return firstRoot;
}

function createEmptyStore(projectId: string, projectPath: string): ProjectStore {
  return {
    projectId,
    projectPath,
    updatedAt: new Date().toISOString(),
    concepts: {},
    history: [],
  };
}

/**
 * projectPath에 대응하는 저장소를 읽는다. 파일이 없으면 빈 저장소를 새로
 * 만들어 반환한다 (디스크에 쓰지는 않는다 — 쓰기는 saveStore 호출 시점뿐,
 * inspect_project/git_diff 같은 read-only 도구가 저장소를 초기화하지 않도록
 * 하기 위함).
 */
export function loadStore(projectPath: string): ProjectStore {
  const projectId = getProjectId(projectPath);
  const storePath = getStorePath(projectId);

  if (!existsSync(storePath)) {
    return createEmptyStore(projectId, projectPath);
  }

  let raw: string;
  try {
    raw = readFileSync(storePath, "utf-8");
  } catch (err) {
    throw new Error(
      `저장소 파일을 읽는 데 실패했습니다: ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `저장소 파일이 손상되어 파싱할 수 없습니다 (${storePath}): ${(err as Error).message}`
    );
  }

  const store = parsed as Partial<ProjectStore> | null;
  if (!store || typeof store !== "object" || !store.concepts || !store.history) {
    // 구조가 깨졌다고 조용히 빈 저장소로 취급하지 않는다 — 그렇게 하면
    // 쌓여있던 이해도 이력이 사용자 모르게 사라질 수 있다.
    throw new Error(`저장소 파일 구조가 예상과 다릅니다 (${storePath}).`);
  }
  return store as ProjectStore;
}

/**
 * 저장소를 디스크에 쓴다. 같은 디렉터리에 임시 파일을 먼저 쓰고 rename하는
 * 방식으로 원자적 쓰기를 보장한다 (여러 Claude 세션이 동시에 같은 파일을
 * 건드려도 파일이 반쯤 쓰인 상태로 깨지지 않도록).
 */
export function saveStore(store: ProjectStore): void {
  const storePath = getStorePath(store.projectId);
  mkdirSync(dirname(storePath), { recursive: true });

  const toWrite: ProjectStore = {
    ...store,
    updatedAt: new Date().toISOString(),
    // 무한히 커지지 않도록 최근 HISTORY_LIMIT건만 유지
    history: store.history.slice(-HISTORY_LIMIT),
  };

  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2), "utf-8");
  renameSync(tmpPath, storePath);
}
