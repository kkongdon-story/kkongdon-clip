/**
 * kkongdon capture — 웹 하이라이터 content script
 * 텍스트 드래그 선택 → 🖊️ 저장 버튼 → chrome.storage에 보관
 * 설정: enableHighlighter (기본 true)
 *
 * 저장 구조: chrome.storage.local["kkongdon_highlights"][normalizedUrl] = [{text, context, color, timestamp}]
 */
(function () {
  if (window.__kkongdon_hl__) return;
  window.__kkongdon_hl__ = true;

  let enabled = true; // 기본값, 설정 로드 후 갱신
  let floatBtn = null;
  let pendingSel = null; // 저장 직전까지 선택 정보 보관

  // ── 설정 로드 ────────────────────────────────────────────────────────────
  try {
    chrome.storage.local.get(["enableHighlighter"], (s) => {
      if (chrome.runtime.lastError) return;
      // undefined → 기본값 true (설정 안 한 사용자도 바로 쓸 수 있게)
      enabled = s.enableHighlighter !== false;
    });
  } catch {}

  // ── 플로팅 버튼 ──────────────────────────────────────────────────────────
  function getOrCreateBtn() {
    if (floatBtn) return floatBtn;
    floatBtn = document.createElement("button");
    floatBtn.id = "__kkongdon_hl_btn__";
    floatBtn.textContent = "🖊️ 저장";
    floatBtn.style.cssText = [
      "position:fixed", "z-index:2147483647",
      "background:#1F2937", "color:#fff", "border:none",
      "border-radius:6px", "padding:5px 12px",
      "font-size:13px", "font-family:-apple-system,sans-serif",
      "cursor:pointer", "box-shadow:0 2px 10px rgba(0,0,0,.35)",
      "display:none", "line-height:1.4", "letter-spacing:0.01em",
    ].join(";");
    // mousedown에서 preventDefault → 버튼 클릭 시 텍스트 선택 해제 방지
    floatBtn.addEventListener("mousedown", (e) => e.preventDefault());
    floatBtn.addEventListener("click", onSave);
    document.body.appendChild(floatBtn);
    return floatBtn;
  }

  function showBtn(rect) {
    const b = getOrCreateBtn();
    // 뷰포트 상단 여백 부족 시 선택 아래로 이동
    const top = rect.top > 44 ? rect.top - 38 : rect.bottom + 6;
    b.style.top  = `${Math.max(4, top)}px`;
    b.style.left = `${Math.max(4, rect.left)}px`;
    b.style.display = "block";
  }

  function hideBtn() {
    if (floatBtn) floatBtn.style.display = "none";
    pendingSel = null;
  }

  // ── 이벤트 리스너 ────────────────────────────────────────────────────────
  document.addEventListener("mouseup", (e) => {
    if (!enabled) return;
    if (e.target?.id === "__kkongdon_hl_btn__") return;

    // rAF: 브라우저가 Selection을 확정한 뒤 읽기
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length < 10) { hideBtn(); return; }

      const range = sel.getRangeAt(0);
      const rect  = range.getBoundingClientRect();

      // 컨텍스트(앞뒤 40자)를 미리 캡처 — 버튼 클릭 시 selection이 사라짐
      const anchorText = sel.anchorNode?.textContent || "";
      const idx    = anchorText.indexOf(text);
      const before = idx >= 0 ? anchorText.slice(Math.max(0, idx - 40), idx).trim() : "";
      const after  = idx >= 0 ? anchorText.slice(idx + text.length, idx + text.length + 40).trim() : "";
      const context = [before, after].filter(Boolean).join("…");

      pendingSel = { text, context, range: range.cloneRange() };
      showBtn(rect);
    });
  });

  document.addEventListener("mousedown", (e) => {
    if (e.target?.id === "__kkongdon_hl_btn__") return;
    hideBtn();
  });

  // ── 저장 핸들러 ──────────────────────────────────────────────────────────
  function onSave() {
    if (!pendingSel) return;
    const { text, context, range } = pendingSel;

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
        if (resp?.ok) showToast("하이라이트 저장됨 ✓");
        else showToast("저장 실패 — 확장을 새로고침 해보세요");
      });
    } catch {}

    // 시각적 마킹 (<mark> 태그)
    try {
      const mark = document.createElement("mark");
      mark.style.cssText = "background:#FFE066;padding:0 1px;border-radius:2px;";
      mark.setAttribute("data-kkongdon", "hl");
      range.surroundContents(mark);
    } catch {
      // 선택 범위가 여러 노드에 걸친 경우 시각 마킹 생략 (저장은 정상)
    }

    hideBtn();
  }

  // ── 토스트 알림 ──────────────────────────────────────────────────────────
  function showToast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = [
      "position:fixed", "bottom:24px", "right:24px", "z-index:2147483647",
      "background:#1F2937", "color:#fff", "padding:8px 16px",
      "border-radius:8px", "font-size:13px",
      "font-family:-apple-system,sans-serif",
      "box-shadow:0 2px 12px rgba(0,0,0,.25)",
      "transition:opacity .3s", "pointer-events:none",
    ].join(";");
    document.body?.appendChild(t);
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 300);
    }, 2200);
  }
})();
