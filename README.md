# CRDD (Code Recognition Debt Deductor)

AI를 활용한 바이브코딩 과정에서 발생하는 개발자의 **인지부채(Cognitive Debt)** — "코드는 동작하지만 왜 이렇게 만들어졌는지 설명하지 못하는 상태" — 를 측정하고, 프로젝트 기반 퀴즈와 학습 루프로 줄여나가는 MCP 서버입니다.

AI가 코드를 대신 작성하는 걸 막지 않습니다. 대신 개발자가 자신의 프로젝트와 변경사항을 얼마나 이해하고 있는지 측정하고, 부족한 부분을 학습하도록 돕습니다.

## 동작 방식

CRDD는 별도의 LLM이나 채점 로직을 갖고 있지 않습니다. 이 MCP 서버는 프로젝트 구조, git diff, 파일 내용 같은 **자료를 모아서 반환**할 뿐이고, 실제 질문 생성·채점·설명은 이 서버를 호출하는 Claude가 수행합니다. 즉 CRDD는 "Claude와 개발자 사이의 이해/학습 계층"으로 동작합니다.

```
Claude (Desktop / Code)
        │ MCP
        ▼
  CRDD MCP Server ── 프로젝트 구조 / git diff / 이해도 점수 저장소
```

## 요구사항

- Node.js
- pnpm (`devEngines.packageManager`에 명시된 버전 — 없다면 `corepack enable` 후 `corepack prepare pnpm@latest --activate`)
- 분석하려는 프로젝트가 git 저장소일 것 (`diff`, `quiz`의 commit 추적 기능이 git에 의존합니다)

## 설치

```bash
git clone <이 저장소 URL>
cd crdd-mcp
pnpm install
```

별도 빌드 단계 없이 `tsx`로 TypeScript를 바로 실행합니다.

## MCP 클라이언트에 등록

### Claude Desktop

`claude_desktop_config.json`에 아래 항목을 추가하세요 (경로는 실제 클론 위치의 절대 경로로 바꿔주세요).

```json
{
  "mcpServers": {
    "crdd": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/crdd-mcp/src/index.ts"]
    }
  }
}
```

### Claude Code

Claude Code CLI의 MCP 서버 추가 기능(`claude mcp add` 등, 정확한 사용법은 `claude mcp --help` 참고)으로 위와 같은 명령(`npx tsx /absolute/path/to/crdd-mcp/src/index.ts`)을 등록하거나, 프로젝트/사용자 설정의 MCP 서버 목록에 위 JSON과 동일한 내용을 추가하세요.

등록 후 정상 연결됐다면 `inspect`, `diff`, `read`, `search`, `quiz`, `answer`, `score`, `decide`, `learn` 9개 tool이 노출됩니다.

## 환경변수 (선택)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CRDD_DATA_DIR` | `~/.crdd` | 이해도 점수 저장소(`projects/<projectId>.json`)가 쌓이는 위치 |
| `CRDD_VAULT_DIR` | `<CRDD_DATA_DIR>/notes` | `decide`/`learn`이 저장하는 학습 기록(마크다운)의 위치. Obsidian vault(또는 그 하위 폴더) 경로를 지정하면 별도 연동 없이 그대로 vault 노트가 됩니다. |

이해도 점수와 학습 기록은 **프로젝트가 아니라 사용자 소유**입니다 — 여러 프로젝트를 분석해도 이 폴더 하나에 프로젝트별로 쌓입니다. 협업 레포에 커밋되는 파일이 아니므로 `.gitignore`에 추가할 필요도 없습니다 (애초에 레포 밖에 저장됩니다).

## 구조 시각화 (선택사항)

`inspect`가 반환하는 프로젝트 구조는 기본적으로 텍스트 트리로 표시됩니다. 다이어그램으로 보고 싶다면 Claude Code 플러그인 [diagram-design](https://github.com/cathrynlavery/diagram-design)을 설치하세요.

```
/plugin marketplace add cathrynlavery/diagram-design
```

- 설치돼 있으면: CRDD가 구조를 아키텍처 다이어그램/트리/dependency graph 등으로 시각화해서 보여줍니다.
- 설치돼 있지 않으면: 별도 설정 없이 자동으로 기본 텍스트 트리 형식으로 표시됩니다.

CRDD 서버 자체는 이 플러그인이 설치돼 있는지 알 수 없습니다 — 설치 여부에 따라 Claude가 알아서 있으면 쓰고 없으면 텍스트로 폴백하는 방식이라, CRDD를 쓰기 위해 반드시 설치해야 하는 필수 항목은 아닙니다.

## 사용법

설치 후 Claude에게 자연어로 요청하면 됩니다.

- "이 프로젝트 구조 분석해줘" → `inspect`
- "최근 변경사항 기반으로 퀴즈 내줘" → `quiz` (`source: "diff"`)
- "이 프로젝트 처음 보는데 진단 퀴즈로 시작해줘" → `quiz` (`source: "structure"`, cold start용)
- "내 인지부채 현황 보여줘" → `score`
- "이 설계 결정 기록해줘" / "방금 배운 거 정리해줘" → `decide` / `learn`

## MVP 범위와 알려진 한계

이 프로젝트는 AST 분석, Vector DB/RAG, 자체 LLM 서버, 웹 대시보드 없이 "Git diff + 프로젝트 구조 + 실제 코드"만으로 동작하는 MVP입니다. 파일 중요도 가중치는 현재 경로 기반 tier(테스트/설정/문서류만 낮은 가중치)만 반영돼 있고, fan-in이나 API 경계 파일 보너스는 아직 없습니다. 코드가 바뀌어도 이해도 점수를 자동으로 깎지는 않고 "재확인 필요" 표시만 합니다.
