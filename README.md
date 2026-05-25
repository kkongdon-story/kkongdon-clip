# 🎬 kkongdon capture

> **유튜브 영상 · 웹 페이지**를 단축키 한 번으로 Markdown 노트로 변환하는 Chrome 확장  
> AI가 자동으로 요약·번역·태그까지 달아줍니다. Obsidian, 노션과 바로 연동됩니다.

---

## ✨ 이런 분께 딱 맞습니다

| 상황 | 활용법 |
|---|---|
| 📚 강의 영상 10개를 정리해야 할 때 | 단축키 한 번 → AI 요약 노트 자동 생성 |
| 🌐 영어 영상인데 한국어로 이해하고 싶을 때 | 자막 자동 번역 (Ollama 무료) |
| 📰 긴 웹 아티클을 나중에 읽고 싶을 때 | 본문 + 이미지 → Markdown 저장 |
| 🔍 리서치 중 탭 10개를 한 번에 정리할 때 | 멀티탭 배치 캡처 (예정) |
| 🗃️ Obsidian 지식베이스를 자동으로 쌓고 싶을 때 | wiki 포맷으로 엔티티 링크 자동 생성 |

---

## 🚀 핵심 기능

### 📹 유튜브 캡처
- **`Ctrl+Shift+S`** — 자막 전체를 한 번에 저장 *(기본값 — `chrome://extensions/shortcuts`에서 변경 가능)*
- **`Ctrl+Shift+F`** — 현재 프레임 이미지 첨부 *(기본값, 변경 가능)*
- 다국어 자막 자동 선택 · STT(Whisper) 폴백 (자막 없는 영상도 OK)
- AI 자막 정리 — 중복 제거, 문장 자연스럽게 다듬기
- 영어 → 한국어 자동 번역 (또는 원하는 언어)

### 🌐 웹 페이지 캡처
- **`Ctrl+Shift+A`** — 현재 페이지 본문 전체 저장 *(기본값, 변경 가능)*
- ✅ **광고·메뉴 자동 제거** — `<nav>`, `<header>`, `<aside>`, `.ad` 등을 걷어내고 `<article>` / `<main>` 본문만 깔끔하게 추출
- ✅ **이미지 URL 포함** — 설정 페이지 → *웹 캡처 이미지 포함* 토글 ON 시 `![alt](url)` 이미지 섹션 자동 추가 (레시피·제품 리뷰 등, 기본 OFF)
- ✅ **하이라이트 캡처** — 텍스트를 드래그로 선택한 상태에서 `Ctrl+Shift+A`를 누르면 선택 영역만 별도 MD로 저장

### 🤖 AI 요약·분석
- **핵심 포인트 10~15개** 자동 추출
- **개요 + 층위 분석** 생성
- AI 태그 자동 분류 (`#tech`, `#finance`, `#recipe` 등)
- Ollama(무료 로컬) · Claude · ChatGPT 모두 지원

### 📂 다양한 저장 포맷
| 포맷 | 용도 |
|---|---|
| **Markdown** | Obsidian, 노션, 기본 메모 |
| **TXT** | 마크다운 마커 없는 순수 텍스트 |
| **HTML** | 브라우저에서 바로 열기 |
| **PDF** | 인쇄·공유용 (Ctrl+P 저장) |
| **CSV** | Excel 분석, 타임스탬프·텍스트 2열 |
| **Wiki 포맷** | Obsidian 엔티티 링크 자동 생성 |

### 🔗 연동
- **Obsidian** — 지정한 Vault 폴더에 바로 저장
- **노션** — 지정한 페이지에 자식 페이지로 자동 전송
- **하위 폴더 선택** — 팝업에서 저장 위치 직접 선택

---

## 📦 설치 방법

### 1단계 — Chrome 확장 설치

1. [Releases](https://github.com/kkongdon-story/kkongdon-capture/releases) 페이지에서 최신 zip 다운로드
2. 압축 해제 → `extension/` 폴더가 나타납니다
3. Chrome 주소창에 `chrome://extensions` 입력 → Enter
4. 오른쪽 위 **개발자 모드** 토글 켜기
5. **압축 해제된 확장 프로그램 로드** 클릭 → `extension/` 폴더 선택
6. 주소창 옆에 아이콘이 생기면 ✅

### 2단계 — 헬퍼 설치 (AI 기능에 필요)

헬퍼는 확장과 AI 사이를 연결하는 작은 Node.js 프로그램입니다.

**Windows:**
```
installers/windows/install.bat 더블클릭
```

**macOS:**
```bash
chmod +x installers/macos/install.command
# Finder에서 install.command 더블클릭
```

> 💡 Node.js가 없으면 설치 마법사가 자동으로 안내합니다.

### 3단계 — AI 설치 (무료 추천: Ollama)

#### 🦙 Ollama (로컬 무료, 인터넷 불필요)
```bash
# 1) Ollama 설치 → https://ollama.com/download
# 2) 모델 다운로드 (~2GB, 최초 1회)
ollama pull qwen2.5:3b
```

#### 🤖 Claude / ChatGPT (구독 그대로 활용)
```bash
# Claude
npm install -g @anthropic-ai/claude-code
claude login

# ChatGPT (Codex)
npm install -g @openai/codex
codex login
```

### 4단계 — 옵션 페이지 설정

확장 아이콘 → ⚙️ → **시작하기** 탭에서 연결 상태 자동 점검 후 저장.

---

## ⚙️ Obsidian 연동 설정

1. 확장 아이콘 → ⚙️ 설정 열기
2. **Obsidian 연동** 섹션 찾기
3. **Vault 경로** 입력 (예: `C:\Users\이름\Documents\MyVault`)
4. **저장 폴더** 설정 (예: `Inbox` 또는 `YouTube`)
5. **Wiki 서식 사용** 체크 → 인물·기술·개념이 `[[entities/이름]]` 형태로 자동 링크
6. 저장 클릭

캡처하면 Vault 폴더에 바로 `.md` 파일이 생성됩니다. Obsidian을 열면 그래프 뷰에서 연결을 확인할 수 있습니다.

---

## 📝 노션(Notion) 연동 설정

### API 키 발급 (최초 1회)

1. https://www.notion.so/my-integrations 접속
2. **새 통합 만들기** 클릭
3. 이름 입력 (예: `kkongdon-capture`) → 제출
4. **Internal Integration Token** 복사 (`secret_...`로 시작)

### 저장할 페이지 연결

1. 노션에서 캡처 내용을 저장할 페이지 열기
2. 오른쪽 상단 `···` → **연결** → 방금 만든 통합 추가
3. 페이지 URL에서 ID 복사  
   예: `notion.so/페이지이름-`**`abcdef1234567890abcdef1234567890`**

### 확장 설정

1. 확장 ⚙️ → **노션 연동** 섹션
2. **API 키** 입력 (`secret_...`)
3. **페이지 ID** 입력 (32자리 문자)
4. 저장 → 다음 캡처부터 노션에 자동 전송 ✅

---

## 🎯 사용법

### 유튜브 영상 캡처
1. YouTube 영상 재생 중
2. **`Ctrl+Shift+S`** (Mac: `Cmd+Shift+S`)
3. 오른쪽 아래 알림 → 완료!

또는 **확장 아이콘 클릭** → 저장 포맷 선택 → 클릭

### 웹 페이지 캡처
1. 저장하고 싶은 웹 페이지 열기
2. **`Ctrl+Shift+A`** (Mac: `Cmd+Shift+A`)
3. 본문 + AI 요약이 함께 저장됩니다

### 저장 위치 지정
팝업 상단 **📂 저장 폴더** 드롭다운에서 하위 폴더를 선택한 뒤 캡처하세요.  
(옵션 페이지 → **하위 폴더** 섹션에서 폴더 목록을 미리 설정해 두세요)

### 단축키 변경
`chrome://extensions/shortcuts` → kkongdon capture 항목에서 변경

---

## 🗂️ 저장 파일 예시

```markdown
# AI가 소프트웨어를 작성하는 시대 (Andrej Karpathy)

type: source
channel: Andrej Karpathy
date: 2026-05-26
url: https://www.youtube.com/watch?v=...

## One-line Definition

소프트웨어 개발 패러다임이 LLM 기반 코드 생성으로 전환되는 현상을 설명한 강연.

## 핵심 포인트

- AI는 이미 단순 코드 작성에서 인간 수준을 넘어서고 있다.
- [[concepts/llm]]과 [[concepts/code-generation]]의 결합이 핵심이다.
- ...

## 대본

[00:00] 오늘은 소프트웨어 개발의 미래에 대해 이야기하겠습니다.
[01:23] [[entities/andrej-karpathy]]가 강조한 것은...
```

---

## 🛠️ 문제 해결

| 증상 | 해결 방법 |
|---|---|
| 알림이 안 뜸 | 옵션 → 지금 점검 → 헬퍼 재설치 |
| AI 요약이 없음 | Ollama 실행 확인: `ollama serve` |
| 한국어가 안 됨 | 옵션 → 목표 언어 `ko` 확인 |
| 노션 전송 실패 | 통합이 페이지에 연결됐는지 확인 |
| 자막이 없음 | STT 옵션 ON + Whisper 모델 확인 |

더 자세한 기술 정보 → 확장 ⚙️ → **기술 정보 (고급)** 탭

---

## 🏗️ 아키텍처

```
Chrome 확장
  ├─ popup.html/js      — 포맷 선택, 하위 폴더, 히스토리
  ├─ content.js         — 페이지 DOM 스크래핑
  ├─ background.js      — 캡처 조율, AI 호출
  └─ lib/
       ├─ aiBridge.js   — LLM 통합 (Ollama · Claude · Codex)
       ├─ wikiFormatter.js — Obsidian wiki 서식
       ├─ notionSync.js — 노션 API 전송
       └─ webCapture.js — 웹 본문 추출

헬퍼 (Node.js)  ←─ Native Messaging ─→  확장
  └─ AI CLI (ollama / claude / codex) 실행
```

---

## 🔒 보안

- 외부 라이브러리 **0개** (vanilla JS)
- API 키·경로는 `chrome.storage.local` — 코드에 절대 저장 안 함
- Native Messaging으로만 외부 통신, 셸 인젝션 차단
- MV3 CSP 기본값, eval/인라인 스크립트 금지

---

## 📜 라이선스

MIT License

사용된 외부 도구는 사용자가 직접 설치하며 각자의 라이선스를 따릅니다:
- [Ollama](https://ollama.com) — MIT
- [Anthropic Claude Code](https://claude.ai/code) — 사용자 라이선스
- [OpenAI Codex CLI](https://github.com/openai/codex) — Apache-2.0
