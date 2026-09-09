import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveDataDir } from "./storage.js";

// ---------------------------------------------------------------------------
// 학습 기록 저장 (마크다운)
//
// `claude/CRDD 학습 기록 저장 위치 설계` 문서 참고: Obsidian은 특별한 포맷이
// 아니라 [[wikilink]] 문법을 쓰는 마크다운 파일들의 폴더일 뿐이다. 그래서 여기서는
// Obsidian 전용 API를 쓰지 않고 그냥 설정된 폴더에 마크다운 파일을 쓴다.
// CRDD_VAULT_DIR을 실제 Obsidian vault(또는 그 하위 폴더)로 지정하면 그대로
// "연동"되고, 지정하지 않으면 기본 ~/.crdd/notes에 쌓인다 — Obsidian을 쓰지
// 않는 사용자도 일반 마크다운 파일로 똑같이 쓸 수 있다.
// ---------------------------------------------------------------------------

/** ~/.crdd/notes (CRDD_VAULT_DIR 환경변수로 덮어쓸 수 있음) */
export function resolveVaultDir(): string {
  return process.env["CRDD_VAULT_DIR"] || join(resolveDataDir(), "notes");
}

/** 사람이 vault를 탐색할 때 알아볼 수 있게, 프로젝트 폴더 이름은 경로 basename을 쓴다. */
function projectFolderName(projectPath: string): string {
  return sanitizeSegment(basename(projectPath) || "project");
}

/** 폴더/표시용 이름에서 파일시스템에 위험한 문자만 제거한다 (사람이 읽는 이름이라 최대한 원형 유지). */
function sanitizeSegment(input: string): string {
  const cleaned = input
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, "-")
    .trim();
  return (cleaned || "untitled").slice(0, 80);
}

/** 파일명용 slug. 한글은 유지하고, 그 외 특수문자는 "-"로 치환한다. */
function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "untitled").slice(0, 60);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function renderWikilinks(related: string[] | undefined): string {
  if (!related || related.length === 0) {
    return "";
  }
  return related.map((item) => `[[${item}]]`).join("\n");
}

export interface SaveResult {
  path: string;
  relativePath: string;
}

export interface SaveDecisionInput {
  projectPath: string;
  title: string;
  myUnderstanding: string;
  context?: string | undefined;
  alternative?: string | undefined;
  whyRejected?: string | undefined;
  verification?: string | undefined;
  related?: string[] | undefined;
}

/**
 * 설계/구현 결정 + 그에 대한 사용자 본인의 이해를 파일 하나로 저장한다.
 * 같은 날 같은 제목으로 다시 저장해도 기존 파일을 덮어쓰지 않고 번호를 붙인다
 * (destructiveHint: false를 실제로 보장하기 위함).
 */
export function saveDecision(input: SaveDecisionInput): SaveResult {
  const vaultDir = resolveVaultDir();
  const projectDir = join(
    vaultDir,
    projectFolderName(input.projectPath),
    "decisions"
  );
  mkdirSync(projectDir, { recursive: true });

  const baseName = `${todayStamp()}-${slugify(input.title)}`;
  let fileName = `${baseName}.md`;
  let counter = 2;
  while (existsSync(join(projectDir, fileName))) {
    fileName = `${baseName}-${counter}.md`;
    counter += 1;
  }
  const filePath = join(projectDir, fileName);

  const sections: string[] = [`# ${input.title}`];
  if (input.context) {
    sections.push(`## Context\n${input.context}`);
  }
  sections.push(`## My Understanding\n${input.myUnderstanding}`);
  if (input.alternative) {
    sections.push(`## Alternative\n${input.alternative}`);
  }
  if (input.whyRejected) {
    sections.push(`## Why rejected?\n${input.whyRejected}`);
  }
  if (input.verification) {
    sections.push(`## Verification\n${input.verification}`);
  }
  const links = renderWikilinks(input.related);
  if (links) {
    sections.push(`## Related\n${links}`);
  }

  const content = sections.join("\n\n") + "\n";
  writeFileSync(filePath, content, "utf-8");

  return {
    path: filePath,
    relativePath: join(projectFolderName(input.projectPath), "decisions", fileName),
  };
}

export interface SaveLearningRecordInput {
  projectPath: string;
  concept: string;
  understanding: string;
  verification?: string | undefined;
  related?: string[] | undefined;
}

/**
 * concept별로 파일 하나에 학습 기록을 계속 append한다 (덮어쓰지 않음).
 * answer가 갱신하는 JSON 점수와 달리, 여기엔 사용자가 자기 말로 쓴
 * 이해 내용이 그대로 남아야 한다 — AI가 대신 쓴 "이상적인 답"을 넣으면 안 된다.
 */
export function saveLearningRecord(input: SaveLearningRecordInput): SaveResult {
  const vaultDir = resolveVaultDir();
  const projectDir = join(
    vaultDir,
    projectFolderName(input.projectPath),
    "learning"
  );
  mkdirSync(projectDir, { recursive: true });

  const fileName = `${slugify(input.concept)}.md`;
  const filePath = join(projectDir, fileName);
  const isNewFile = !existsSync(filePath);

  const entryLines: string[] = [];
  if (isNewFile) {
    entryLines.push(`# ${input.concept} 학습 기록`, "");
  }
  entryLines.push(`## ${new Date().toISOString()}`);
  if (input.verification) {
    entryLines.push(input.verification, "");
  }
  entryLines.push(input.understanding);
  const links = renderWikilinks(input.related);
  if (links) {
    entryLines.push("", links);
  }
  entryLines.push("", "---", "");

  appendFileSync(filePath, entryLines.join("\n"), "utf-8");

  return {
    path: filePath,
    relativePath: join(projectFolderName(input.projectPath), "learning", fileName),
  };
}
