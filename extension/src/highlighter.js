/**
 * kkongdon capture — 웹 하이라이터 content script
 * 텍스트 선택 → 🖊️ 저장 버튼 → chrome.storage에 보관
 * 설정: enableHighlighter (기본 true)
 *
 * 저장 구조:
 *   chrome.storage.local["kkongdon_highlights"][normalizedUrl]
 *   = [{text, context, color, timestamp}]
 *
 * 차별점 vs 선택 텍스트 즉시 저장(Ctrl+Shift+A):
 *   - 하이라이터: 여러 위치 누적 저장 → 나중에 전체 페이지 캡처 시 "내 하이라이트" 섹션으로 통합
 *   - 선택 즉시 저장: 선택 부분만 별도 MD로 즉시 추출
 */
(function () {
  if (window.__kkongdon_hl__) return;
  window.__kkongdon_hl__ = true;

  let enabled = true; // 기본 true — 설정 로드 전에도 동작하도록
  let floatBtn = null;
  let pendingSel = null;
  let debounceTimer = null;

  // ── 설정 로드 ──────────────────────────────────────────────────────────────
  try {
    chrome.storage.local.get(["enableHighlighter"], (s) => {
      if (chrome.runtime.lastError) return;
      enabled = s.enableHighlighter !== false;
    });
  } catch {}

  // ── 플로팅 버튼 ────────────────────────────────────────────────────────────
  function getOrCreateBtn() {
    if (floatBtn) return floatBtn;
    const b = document.createElement("div"); // button 대신 div — 사이트 button CSS 간섭 방지
    b.id = "__kkongdon_hl_btn__";
    b.textContent = "🖊️ 저장";
    b.style.cssText = [
      "all:initial",                         // 사이트 전역 스타일 초기화
      "position:fixed",
      "z-index:2147483647",
      "background:#1F2937",
      "color:#ffffff",
      "border-radius:6px",
      "padding:5px 12px",
      "font:500 13px/-apple-system,'Segoe UI',sans-serif",
      "cursor:pointer",
      "box-shadow:0 2px 10px rgba(0,0,0,.4)",
      "display:none",
      "user-select:none",
      "white-space:nowrap",
      "pointer-events:auto",
    ].join(";");
    b.addEventListener("mousedown", (e) => e.preventDefault()); // 선택 해제 방지
    b.addEventListener("click", onSave);
    (document.body || document.documentElement).appendChild(b);
    floatBtn = b;
    return b;
  }

  function showBtn(rect) {
    const b = getOrCreateBtn();
    // position:fixed → viewport 좌표 그대로 사용
    const top = rect.top > 48 ? rect.top - 40 : rect.bottom + 8;
    b.style.top    = `${Math.max(4, top)}px`;
    b.style.left   = `${Math.max(4, Math.min(rect.left, window.innerWidth - 100))}px`;
    b.style.display = "block";
  }

  function hideBtn() {
    if (floatBtn) floatBtn.style.display = "none";
    pendingSel = null;
  }

  // ── selectionchange 기반 감지 (mouseup보다 신뢰성 높음) ──────────────────────
  // 사이트 자체 mouseup 핸들러가 selection을 건드려도 selectionchange가 최종 상태를 전달
  document.addEventListener("selectionchange", () => {
    if (!enabled) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();

      if (!text || text.length < 10) { hideBtn(); return; }

      let rect;
      try {
        const range = sel.getRangeAt(0);
        rect = range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) { hideBtn(); return; }

        // 컨텍스트 미리 캡처 (버튼 클릭 후 selection 사라짐)
        const anchor = sel.anchorNode?.textContent || "";
        const idx    = anchor.indexOf(text);
        const before = idx >= 0 ? anchor.slice(Math.max(0, idx - 40), idx).trim() : "";
        const after  = idx >= 0 ? anchor.slice(idx + text.length, idx + text.length + 40).trim() : "";
        const context = [before, after].filter(Boolean).join("…");

        pendingSel = { text, context, range: range.cloneRange() };
      } catch { hideBtn(); return; }

      showBtn(rect);
    }, 200); // 200ms debounce — 사이트 selection 핸들러가 먼저 처리되도록 여유
  });

  // 버튼 영역 외 클릭 시 숨기기
  document.addEventListener("mousedown", (e) => {
    if (e.target?.id === "__kkongdon_hl_btn__") return;
    clearTimeout(debounceTimer);
    hideBtn();
  });

  // ── 저장 핸들러 ────────────────────────────────────────────────────────────
  function onSave() {
    if (!pendingSel) return;
    const { text, context, range } = pendingSel;

    // debounce 타이머 즉시 취소 → 저장 직후 selectionchange가 버튼을 재표시하는 문제 방지
    clearTimeout(debounceTimer);
    // 선택 해제 → selectionchange 재발화 시 text === '' 이어서 hideBtn() 경로로 진입
    try { window.getSelection()?.removeAllRanges(); } catch {}

    const highlight = {
      text,
      context,
      color: "#FFE066",
      timestamp: new Date().toISOString(),
      url: location.href,
      title: document.title,
    };

    try {
      chrome.runtime.sendMessage({ type: "SAVE_HIGHLIGHT", highlight }, (resp) => {
        if (chrome.runtime.lastError) return;
        showToast(resp?.ok ? "하이라이트 저장됨 ✓" : "저장 실패");
      });
    } catch {}

    // 시각적 마킹 (<mark>)
    // surroundContents()는 범위가 여러 노드에 걸치면 HierarchyRequestError → extractContents 폴백
    try {
      const mark = document.createElement("mark");
      mark.style.cssText = "background:#FFE066 !important;padding:0 1px;border-radius:2px;";
      mark.setAttribute("data-kkongdon", "hl");
      try {
        range.surroundContents(mark);       // 단일 노드 내 선택 → 빠른 경로
      } catch {
        mark.appendChild(range.extractContents()); // 멀티 노드 선택 → extract 후 wrap
        range.insertNode(mark);
      }
    } catch {
      // DOM 접근 자체가 불가한 경우 (shadow DOM 등) 시각 마킹만 생략, 저장은 정상
    }

    hideBtn();
  }

  // ── 토스트 알림 ────────────────────────────────────────────────────────────
  function showToast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = [
      "all:initial",
      "position:fixed", "bottom:24px", "right:24px",
      "z-index:2147483647",
      "background:#1F2937", "color:#fff",
      "padding:8px 16px", "border-radius:8px",
      "font:13px/-apple-system,'Segoe UI',sans-serif",
      "box-shadow:0 2px 12px rgba(0,0,0,.3)",
      "transition:opacity .3s", "pointer-events:none",
    ].join(";");
    (document.body || document.documentElement).appendChild(t);
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 300);
    }, 2200);
  }
})();
