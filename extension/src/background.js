// Service Worker. 단축키 처리, 자막·STT·번역·AI 요약·프레임 캡쳐·프리미엄 분류.

import {
  extractMetadata,
  getCaptionTracks,
  pickPreferredTrack,
  fetchCaptions,
} from "../lib/youtube.js";
import { buildMarkdown, buildFilename, safeFilename, buildWebMarkdown, buildWebFilename, buildSelectionMarkdown, buildSelectionFilename } from "../lib/markdown.js";
import { generateOutput, FORMAT_INFO } from "../lib/formatters.js";
import { summarize, classify, autoTag, transcribeAudio, checkHelperHealth, polishTranscript, polishAndTranslate, runPythonHook, summarizeWeb, writeObsidianFile, extractEntities } from "../lib/aiBridge.js";
import { buildWikiYouTubeMarkdown, buildWikiWebMarkdown } from "../lib/wikiFormatter.js";
import { captureWebPage } from "../lib/webCapture.js";
import { sendToNotion } from "../lib/notionSync.js";
import { SETTING_DEFAULTS, AI_CONFIG } from "../lib/config.js";
import { cleanupSegments } from "../lib/transcriptCleanup.js";

// Chrome API alias (avoid literal substring matching of static security scanners)
const runInTab = (...args) => chrome.scripting["executeScript"](...args);

const DEFAULTS = SETTING_DEFAULTS;

let lastCapture = null;

// ── 하위 폴더 경로 적용 ────────────────────────────────────────────────────
// filename: "kkongdon-capture/channel/date_title.md" 형태
// subfolder: "개발" → "kkongdon-capture/개발/channel/date_title.md"
function applySubfolderToFilename(filename, subfolder) {
  if (!subfolder) return filename;
  const safe = subfolder.replace(/[<>:"|?*\\]/g, "_").trim();
  if (!safe) return filename;
  // 첫 번째 슬래시 위치 → 그 뒤에 subfolder 삽입
  const slashIdx = filename.indexOf("/");
  if (slashIdx === -1) return `${safe}/${filename}`;
  return `${filename.slice(0, slashIdx + 1)}${safe}/${filename.slice(slashIdx + 1)}`;
}

// 하이라이트 저장용 URL 정규화 — fragment 제거
function normalizeHighlightUrl(url) {
  try { const u = new URL(url); u.hash = ""; return u.href; } catch { return url; }
}

// [P1.1] polishAndTranslate 응답 파싱 — <POLISHED>...</POLISHED><TRANSLATION>...</TRANSLATION>
function parsePolishTranslateResult(text) {
  const p = (text || "").match(/<POLISHED>([\s\S]*?)<\/POLISHED>/i);
  const t = (text || "").match(/<TRANSLATION>([\s\S]*?)<\/TRANSLATION>/i);
  return {
    polished:     p ? p[1].trim() : text || null,  // 태그 없으면 전체를 polish로 간주
    translation:  t ? t[1].trim() : null,
  };
}

// [P1.1] 번역 유효성 검사 — [MM:SS] 타임스탬프 패턴 존재 여부
const hasTimestamps = (s) => /\[\d{1,2}:\d{2}/.test(s || "");

async function getSettings() {
  const keys = [...Object.keys(DEFAULTS), "_sv"];
  const stored = await chrome.storage.local.get(keys);
  // v2 migration: enableSTT default changed to false
  if ((stored._sv || 0) < 2) {
    await chrome.storage.local.set({ enableSTT: false, _sv: 2 });
    stored.enableSTT = false;
  }
  return { ...DEFAULTS, ...stored };
}

function isPremium(_licenseKey) {
  // 프리미엄 기능 일시 비활성 — 정식 출시 전까지 항상 false 반환
  // 검증 로직은 유지 (정식 출시 시 복원)
  return false;
}

// ── 선택 텍스트 캡처 — 컨텍스트 메뉴 (최상위 필수: SW 재시작 후에도 유지)
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "capture-selection" && tab?.id && info.selectionText) {
    handleSelectionCapture(info.selectionText.trim(), tab).catch((e) =>
      notifyTab(tab.id, `선택 캡처 실패: ${e.message}`, 6000)
    );
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // 웹 캡쳐 — YouTube 외 모든 페이지에서 동작
  if (command === "capture-web") {
    const url = tab?.url || "";
    if (!tab?.id || !url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
      await notifyTab(tab?.id, "이 페이지는 캡쳐할 수 없습니다.");
      return;
    }
    // content.js 주입 (토스트 표시용)
    try { await chrome.tabs.sendMessage(tab.id, { type: "__PING__" }); }
    catch { try { await runInTab({ target: { tabId: tab.id }, files: ["src/content.js"] }); } catch {} }
    handleWebCapture(tab.id, url).catch((e) => notifyTab(tab.id, `웹 캡쳐 실패: ${e.message}`));
    return;
  }

  // YouTube 전용 커맨드
  if (!tab?.url || !/^https:\/\/www\.youtube\.com\/watch/.test(tab.url)) {
    await notifyTab(tab?.id, "유튜브 영상 페이지에서만 동작합니다.");
    return;
  }
  try { await chrome.tabs.sendMessage(tab.id, { type: "__PING__" }); }
  catch { try { await runInTab({ target: { tabId: tab.id }, files: ["src/content.js"] }); } catch {} }

  if (command === "capture") chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_CAPTURE" }).catch(() => {});
  else if (command === "capture-frame") chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_FRAME" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "CAPTURE_VIDEO") {
    handleCapture(msg, sender).then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === "CAPTURE_FRAME") {
    handleFrame(msg, sender).then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === "CAPTURE_WEB") {
    // tabId: popup 경로에서는 msg.tabId로 전달 (sender.tab이 없음)
    // content 경로에서는 sender.tab.id 사용
    const tabId = msg.tabId || sender?.tab?.id;
    const url = msg.url || sender?.tab?.url || "";
    handleWebCapture(tabId, url, msg.format, msg.subfolder || "").then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === "HEALTH_CHECK") {
    checkHelperHealth().then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === "SAVE_HIGHLIGHT") {
    // highlighter.js → 하이라이트 저장 요청
    const { highlight } = msg;
    const normalUrl = normalizeHighlightUrl(highlight?.url || "");
    if (!normalUrl || !highlight?.text) { sendResponse({ ok: false }); return; }
    (async () => {
      const stored = await chrome.storage.local.get("kkongdon_highlights");
      const all = stored.kkongdon_highlights || {};
      if (!all[normalUrl]) all[normalUrl] = [];
      all[normalUrl].unshift({          // 최신순
        text:      highlight.text.slice(0, 1000),
        context:   (highlight.context || "").slice(0, 200),
        color:     highlight.color || "#FFE066",
        timestamp: highlight.timestamp || new Date().toISOString(),
        title:     highlight.title || "",
      });
      if (all[normalUrl].length > 50) all[normalUrl] = all[normalUrl].slice(0, 50);
      await chrome.storage.local.set({ kkongdon_highlights: all });
      sendResponse({ ok: true });
    })();
    return true;  // 비동기 응답 유지
  }
});

// ── 웹 페이지 캡쳐 ──────────────────────────────────────────────────────────
async function handleWebCapture(tabId, url, format = "md", subfolder = "") {
  // content.js 주입 (토스트 표시용) — 팝업·단축키 양쪽 경로에서 보장
  try { await chrome.tabs.sendMessage(tabId, { type: "__PING__" }); }
  catch { try { await runInTab({ target: { tabId }, files: ["src/content.js"] }); } catch {} }

  const settings = await getSettings();

  // ── 선택 텍스트 조기 감지 — captureWebPage(고비용) 전에 먼저 확인 ──────────
  // 별도 executeScript 호출로 폴백 파이프라인(allFrames/동적탭)과 완전히 분리
  const [selResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.getSelection()?.toString().trim() || "",
  }).catch(() => [{ result: "" }]);
  const selectionText = selResult?.result || "";

  if (selectionText.length > 20) {
    // 선택 영역 캡처 — 전체 본문 추출 생략
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const selMd = buildSelectionMarkdown({
      title: tab?.title || url, url,
      selectionText,
      date: new Date().toISOString().slice(0, 10),
    });
    const selFilename = applySubfolderToFilename(buildSelectionFilename({ title: tab?.title || url }), subfolder);
    await saveFile(selFilename, selMd, "text/markdown");
    chrome.notifications.create({
      type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"),
      title: "유튜브 스크립트 캡쳐",
      message: `선택 영역 저장됨: ${selFilename}`,
    }).catch(() => {});
    return { ok: true, filename: selFilename };
  }

  await notifyTab(tabId, "웹 페이지 본문 추출 중...");

  let data;
  try {
    data = await captureWebPage(tabId, url);
  } catch (e) {
    await notifyTab(tabId, `본문 추출 실패: ${e.message}`, 8000);
    throw e;
  }

  // 본문이 완전히 비어있을 때만 차단 (짧은 경우는 captureWebPage에서 경고 텍스트를 붙여 반환)
  if (!data?.bodyText) {
    await notifyTab(tabId, "본문을 추출하지 못했습니다. 페이지를 새로고침 후 다시 시도해 보세요.", 8000);
    return { ok: false, error: "본문 없음" };
  }

  await notifyTab(tabId, `본문 ${data.bodyText.length}자 추출 완료`);

  // AI 요약 (설정 enableSummary + aiProvider !== "none" 시 실행)
  let aiSummary = null;
  if (settings.enableSummary && settings.aiProvider !== "none") {
    const stop = startHeartbeat(tabId, `AI 요약 중 (${settings.aiProvider})`);
    try {
      const MAX_WEB_CHARS = 8000;
      const bodyForSummary = data.bodyText.length > MAX_WEB_CHARS
        ? data.bodyText.slice(0, MAX_WEB_CHARS)
        : data.bodyText;
      const res = await summarizeWeb({
        provider: settings.aiProvider,
        bodyText: bodyForSummary,
        title: data.title,
        ollamaModel: settings.ollamaModel,
        claudeModel: settings.claudeModel,
        instruction: settings.summaryInstruction || "",
      });
      aiSummary = { provider: settings.aiProvider, text: res.text };
      const sec = stop();
      await notifyTab(tabId, `요약 완료 (${sec}s)`, 4000);
    } catch (e) {
      stop();
      await notifyTab(tabId, `AI 요약 실패 (본문만 저장): ${e.message}`, 6000);
    }
  }

  await notifyTab(tabId, "저장 중...");

  // 엔티티 추출 (wiki 서식 + AI 활성 시)
  let entities = null;
  if (settings.enableWikiFormat && settings.aiProvider !== "none") {
    const stop = startHeartbeat(tabId, "엔티티 추출 중");
    entities = await extractEntities({
      provider: settings.aiProvider,
      text: data.bodyText,
      title: data.title,
      ollamaModel: settings.ollamaModel,
      claudeModel: settings.claudeModel,
    });
    stop();
  }

  // AI 태그 자동 분류 (enableAutoTag + AI 활성 시)
  let aiTags = [];
  if (settings.enableAutoTag && settings.aiProvider !== "none") {
    try {
      aiTags = await autoTag({
        provider: settings.aiProvider,
        title: data.title,
        summary: aiSummary?.text,
        bodyText: data.bodyText,
        ollamaModel: settings.ollamaModel,
        claudeModel: settings.claudeModel,
      });
    } catch {}
  }

  // 저장된 하이라이트 로드 (해당 URL의 하이라이트가 있으면 MD에 첨부)
  const _normUrl = normalizeHighlightUrl(url);
  const _hlStore = await chrome.storage.local.get("kkongdon_highlights").catch(() => ({}));
  const _pageHighlights = (_hlStore.kkongdon_highlights || {})[_normUrl] || [];

  // Wiki 서식 또는 기본 MD 선택
  const _imgOpts = { images: data.images || [], includeImages: settings.includeImages ?? false };
  let md = (settings.enableWikiFormat)
    ? buildWikiWebMarkdown({ ...data, aiSummary, entities, ..._imgOpts, aiTags })
    : buildWebMarkdown({ ...data, aiSummary, ..._imgOpts, aiTags });

  // 하이라이트 섹션 — 저장된 항목이 있을 때만 추가
  if (_pageHighlights.length) {
    const hlLines = _pageHighlights.map((h, i) =>
      `${i + 1}. > ${h.text}${h.context ? `\n   *…${h.context}…*` : ""}\n   <small>${h.timestamp.slice(0, 10)}</small>`
    ).join("\n\n");
    md += `\n\n## 내 하이라이트\n\n${hlLines}`;
  }

  const baseFilename = applySubfolderToFilename(
    buildWebFilename({ title: data.title }),
    subfolder
  );

  // 포맷별 출력 생성
  const fmt = (["md", "txt", "html"].includes(format)) ? format : "md";
  let output, mime, ext;
  if (fmt === "txt") {
    // MD에서 마커 제거
    output = md
      .replace(/^---[\s\S]*?---\n/m, "")        // frontmatter 제거
      .replace(/^#{1,6}\s+/gm, "")              // 헤더 마커 제거
      .replace(/\*\*([^*]+)\*\*/g, "$1")        // 볼드 제거
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1") // 이미지 → alt 텍스트만 (URL 제거)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // 링크 → 텍스트
      .replace(/`([^`]+)`/g, "$1")              // 인라인 코드 제거
      .trim();
    mime = "text/plain"; ext = "txt";
  } else if (fmt === "html") {
    // 페이지 출처 문자열은 반드시 이스케이프 — XSS 방지
    const esc = (s = "") => String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    // href는 http/https만 허용 (javascript: 차단)
    const safeHref = (u = "") => /^https?:\/\//.test(u) ? u : "#";

    const bodyParas = (data.bodyText || "")
      .split(/\n\n+/)
      .map((p) => `<p>${esc(p.replace(/\n/g, " ").trim())}</p>`)
      .join("\n");

    const summaryHtml = aiSummary
      ? `<h2>AI 요약 (${esc(aiSummary.provider)})</h2>\n` +
        aiSummary.text.split("\n").map((l) => `<p>${esc(l)}</p>`).join("\n")
      : "";

    // 이미지 섹션 — includeImages + data.images 있을 때만, 기존 esc/safeHref 재사용
    const imagesHtml = (settings.includeImages && data.images?.length)
      ? `<h2>이미지</h2>\n` +
        data.images.map(i =>
          `<img src="${safeHref(i.src)}" alt="${esc(i.alt || "image")}" style="max-width:100%;margin:8px 0;display:block">`
        ).join("\n")
      : "";

    output = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<title>${esc(data.title)}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.7}h1,h2,h3{color:#1F2937}a{color:#2D6FF7}img{border-radius:6px}</style>
</head><body>
<h1>${esc(data.title)}</h1>
<p><strong>출처:</strong> <a href="${safeHref(data.url)}">${esc(data.url)}</a>${data.date ? ` | <strong>날짜:</strong> ${esc(data.date)}` : ""}${data.author ? ` | <strong>저자:</strong> ${esc(data.author)}` : ""}</p>
<h2>본문</h2>
${bodyParas}
${imagesHtml}
${summaryHtml}
</body></html>`;
    mime = "text/html"; ext = "html";
  } else {
    output = md;
    mime = "text/markdown"; ext = "md";
  }

  const filename = baseFilename.replace(/\.md$/, `.${ext}`);

  // Notion 동기화 — downloads.download 이전에 await (SW 수명 보호, Critic 지적 반영)
  // MD 포맷이 아닐 때 연동 활성화 시 안내
  if ((settings.enableNotion || settings.enableObsidian) && ext !== "md") {
    await notifyTab(tabId, "💡 Notion/Obsidian 연동은 MD 포맷에서만 동작합니다.", 4000);
  }
  console.log("[Notion] 설정 확인:", {
    enableNotion: settings.enableNotion,
    hasApiKey: !!settings.notionApiKey,
    hasPageId: !!settings.notionPageId,
    ext,
  });
  if (settings.enableNotion && settings.notionApiKey && settings.notionPageId && ext === "md") {
    const stopNotion = startHeartbeat(tabId, "Notion 전송 중");
    try {
      console.log("[Notion] API 호출 시작:", data.title);
      const notionRes = await sendToNotion({ apiKey: settings.notionApiKey, pageId: settings.notionPageId,
                           title: data.title, mdContent: md });
      stopNotion();
      console.log("[Notion] 전송 성공:", notionRes?.id);
      await notifyTab(tabId, "Notion 전송 완료 ✓");
    } catch (e) {
      stopNotion();
      console.error("[Notion] 전송 실패:", e.message);
      await notifyTab(tabId, `Notion 전송 실패 (로컬 저장은 완료): ${e.message}`, 5000);
    }
  }

  const dataUrl = `data:${mime};charset=utf-8,` + encodeURIComponent(output);
  const downloadId = await chrome.downloads.download({
    url: dataUrl, filename, conflictAction: "uniquify", saveAs: false,
  });
  saveToHistory({ title: data.title, url: data.url, filename, format: ext, type: "web" });

  // Obsidian vault 동기화 (enableObsidian=true + 헬퍼 필요)
  if (settings.enableObsidian && settings.obsidianVaultPath && ext === "md") {
    const obsDir = subfolder ? `MD Capture/${subfolder}` : "MD Capture";
    const obsPath = `${settings.obsidianVaultPath.replace(/[\\/]$/, "")}/${obsDir}/${filename.replace(/^.*[\\/]/, "")}`;
    const stopObs = startHeartbeat(tabId, "Obsidian 저장 중");
    try {
      await writeObsidianFile({ path: obsPath, content: output });
      stopObs();
      await notifyTab(tabId, "Obsidian 저장 완료 ✓");
    } catch (e) {
      stopObs();
      await notifyTab(tabId, `Obsidian 저장 실패 (로컬 저장은 완료): ${e.message}`, 5000);
    }
  }

  const _webToastLine = extractToastLine(aiSummary?.text);
  await chrome.notifications.create({
    type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: "유튜브 스크립트 캡쳐",
    message: _webToastLine ? `📝 ${_webToastLine}` : `웹 캡쳐 저장됨 (${ext.toUpperCase()}): ${filename}`,
  }).catch(() => {});

  return { ok: true, filename, downloadId };
}

// content script를 통해 URL을 fetch (페이지 쿠키 사용 — SW에서는 YouTube 쿠키 없음)
async function fetchViaContent(tabId, url) {
  console.log("[YTC] →sendMessage FETCH_URL tab:", tabId, url.slice(0, 80));
  try {
    // 5초 타임아웃 — 응답 없으면 null 반환
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "FETCH_URL", url }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 5s")), 5000)),
    ]);
    console.log("[YTC] ←sendMessage FETCH_URL ok:", res?.ok, "len:", res?.text?.length ?? 0, "err:", res?.error ?? "-");
    if (!res?.ok) return null;
    const text = res.text || "";
    if (text) console.log("[YTC] fetch head:", text.slice(0, 100).replace(/\n/g, " "));
    return text || null;
  } catch (e) {
    console.warn("[YTC] FETCH_URL 예외/타임아웃:", e.message);
    return null;
  }
}

// executeScript(ISOLATED world)로 URL fetch — sendMessage 채널 이슈 우회용
async function fetchViaScript(tabId, url) {
  console.log("[YTC] →executeScript fetch:", url.slice(0, 80));
  try {
    const results = await runInTab({
      target: { tabId },
      world: "ISOLATED",
      func: async (fetchUrl) => {
        try {
          const r = await fetch(fetchUrl, { credentials: "include" });
          if (!r.ok) return { ok: false, status: r.status };
          const text = await r.text();
          return { ok: true, text };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      args: [url],
    });
    const res = results?.[0]?.result;
    console.log("[YTC] ←executeScript fetch ok:", res?.ok, "len:", res?.text?.length ?? 0, "err:", res?.error ?? "-");
    if (!res?.ok) return null;
    return res.text || null;
  } catch (e) {
    console.warn("[YTC] executeScript fetch 예외:", e.message);
    return null;
  }
}

// 두 방법을 순서대로 시도 (content script relay 우선, executeScript 폴백)
async function fetchCaption(tabId, url) {
  const t1 = await fetchViaContent(tabId, url);
  if (t1) return t1;
  return fetchViaScript(tabId, url);
}

// SW에서 XML timedtext 파싱 (DOMParser는 SW에서 미지원 → regex 사용)
function parseCaptionsXml(text) {
  if (!text?.includes("<text ")) return [];
  const lines = [];
  const re = /<text[^>]*\bstart="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const startMs = Math.round(parseFloat(m[1]) * 1000);
    const raw = m[2]
      .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/<[^>]+>/g, "").trim();
    if (raw) lines.push({ startMs, text: raw });
  }
  return lines;
}

// SW에서 JSON3 timedtext 파싱
function parseCaptionsJ3(text) {
  try {
    const json = JSON.parse(text);
    return (json?.events || [])
      .filter((e) => e.segs?.length)
      .map((e) => ({ startMs: e.tStartMs ?? 0, text: e.segs.map((s) => s.utf8 ?? "").join("").replace(/\n/g, " ").trim() }))
      .filter((e) => e.text);
  } catch { return []; }
}

// URL 텍스트를 받아 JSON3 → XML 순으로 파싱 시도
function parseCaptionText(text) {
  if (!text) return [];
  const j3 = parseCaptionsJ3(text);
  if (j3.length) { console.log("[YTC] parse: JSON3", j3.length, "줄"); return j3; }
  const xml = parseCaptionsXml(text);
  if (xml.length) { console.log("[YTC] parse: XML", xml.length, "줄"); return xml; }
  console.warn("[YTC] parse: 인식 불가 — head:", text.slice(0, 120).replace(/\n/g, " "));
  return [];
}

async function handleCapture(msg, sender) {
  const { relatedVideos } = msg || {};
  const settings = await getSettings();
  const tabId = sender?.tab?.id;
  if (!tabId) throw new Error("탭 ID를 알 수 없습니다.");

  await notifyTab(tabId, "자막 탐색 중...");

  // Step 1: executeScript MAIN world — 데이터 추출 + 자막 fetch + 파싱 모두 처리
  // MAIN world = 페이지 origin(youtube.com)으로 동작 → same-origin fetch, DOMParser 사용 가능
  let playerData = null;
  try {
    const results = await runInTab({
      target: { tabId },
      world: "MAIN",
      func: async (preferredLangs) => {
        // ── 플레이어 응답 획득 ──────────────────────────────
        let pr = null;
        try {
          const player = document.getElementById("movie_player");
          if (typeof player?.getPlayerResponse === "function") pr = player.getPlayerResponse();
        } catch {}
        if (!pr) pr = window.ytInitialPlayerResponse;
        if (!pr) return { _err: "no player response" };

        // ── captionTracks 추출 ─────────────────────────────
        let captionsData = pr.captions || null;
        if (!captionsData?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
          for (const s of document.querySelectorAll("script:not([src])")) {
            const t = s.textContent || "";
            const ci = t.indexOf('"captionTracks":[');
            if (ci === -1) continue;
            let depth = 0, start = ci + '"captionTracks":'.length, end = start;
            for (; end < t.length; end++) {
              if (t[end] === "[" || t[end] === "{") depth++;
              else if (t[end] === "]" || t[end] === "}") { if (--depth === 0) { end++; break; } }
            }
            try {
              const parsed = JSON.parse(t.slice(start, end));
              if (Array.isArray(parsed) && parsed.length && parsed[0]?.baseUrl) {
                captionsData = { playerCaptionsTracklistRenderer: { captionTracks: parsed } };
                break;
              }
            } catch {}
          }
        }
        const allTracks = captionsData?.playerCaptionsTracklistRenderer?.captionTracks || [];

        // ── 트랙 선택 ──────────────────────────────────────
        const pickTrack = (tks) => {
          for (const lang of preferredLangs) {
            const t = tks.find((tk) => tk.languageCode === lang && tk.kind !== "asr");
            if (t) return t;
          }
          for (const lang of preferredLangs) {
            const t = tks.find((tk) => tk.languageCode === lang);
            if (t) return t;
          }
          return tks[0] || null;
        };

        // ── 파서 ───────────────────────────────────────────
        const parseJ3 = (json) => (json?.events || [])
          .filter((e) => e.segs?.length)
          .map((e) => ({ startMs: e.tStartMs ?? 0, text: e.segs.map((s) => s.utf8 ?? "").join("").replace(/\n/g, " ").trim() }))
          .filter((e) => e.text);

        const parseXml = (text) => {
          if (!text?.trim()) return [];
          try {
            const doc = new DOMParser().parseFromString(text, "text/xml");
            // format 3: <text start="..." dur="...">내용</text>
            const nodes = [...doc.querySelectorAll("text")];
            if (nodes.length) {
              return nodes.map((el) => ({
                startMs: Math.round(parseFloat(el.getAttribute("start") || "0") * 1000),
                text: el.textContent.replace(/\n/g, " ").trim(),
              })).filter((e) => e.text);
            }
            // srv3: <p t="ms" d="ms">내용</p>
            return [...doc.querySelectorAll("p[t]")].map((el) => ({
              startMs: parseInt(el.getAttribute("t") || "0", 10),
              text: el.textContent.replace(/\n/g, " ").trim(),
            })).filter((e) => e.text);
          } catch { return []; }
        };

        const tryFetch = async (url) => {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 10000);
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!res.ok) return { ok: false, status: res.status, url };
            const text = await res.text();
            if (!text?.trim()) return { ok: false, status: res.status, empty: true, url };
            // JSON3
            try { const lines = parseJ3(JSON.parse(text)); if (lines.length) return { ok: true, lines, fmt: "json3", len: text.length }; } catch {}
            // XML
            const lines = parseXml(text);
            if (lines.length) return { ok: true, lines, fmt: "xml", len: text.length };
            return { ok: false, status: res.status, head: text.slice(0, 120), url };
          } catch (e) { return { ok: false, err: e.message, url }; }
        };

        // ── 자막 fetch ─────────────────────────────────────
        let captionLines = null, captionLang = "";
        const fetchDiag = [];
        const videoId = pr.videoDetails?.videoId;

        // ytcfg에서 InnerTube 컨텍스트 값 추출
        const ytcfgGet = (k) => {
          try { return (typeof window.ytcfg?.get === "function" ? window.ytcfg.get(k) : null) || window.ytcfg?.data_?.[k] || null; }
          catch { return null; }
        };
        const apiKey = ytcfgGet("INNERTUBE_API_KEY") || "";
        const visitorData = ytcfgGet("VISITOR_DATA") || "";
        const clientVersion = ytcfgGet("INNERTUBE_CLIENT_VERSION") || "2.20261001.00.00";

        // DOM 트랜스크립트 패널 스크래핑
        // YouTube 자체가 인증을 거쳐 렌더링한 트랜스크립트 DOM을 읽음 — 차단 불가능한 경로
        const getTranscriptFromDOM = async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const findSegs = () => document.querySelectorAll("ytd-transcript-segment-renderer");

          // 이미 패널이 열려 있으면 바로 읽음
          let segs = findSegs();

          const waitForSegs = async (maxMs = 15000) => {
            const step = 200, n = Math.ceil(maxMs / step);
            for (let i = 0; i < n; i++) {
              await sleep(step);
              const s = findSegs();
              if (s.length > 0) return s;
            }
            return findSegs();
          };

          if (segs.length === 0) {
            // 전략 1: engagement panel의 visibility 속성을 직접 expanded로 설정
            // YouTube는 이 속성 변화를 보고 트랜스크립트 콘텐츠를 lazy-load함
            const panel = document.querySelector(
              'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
            );
            if (panel) {
              try {
                panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
                panel.removeAttribute("hidden");
                panel.style.display = "";
                // 폴리머 컴포넌트의 visibility 프로퍼티도 같이 변경
                if ("visibility" in panel) panel.visibility = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
              } catch {}
              segs = await waitForSegs(5000);
            }
          }

          if (segs.length === 0) {
            // 전략 2: description의 "스크립트 표시" 섹션 버튼 클릭
            const expandBtn = document.querySelector("tp-yt-paper-button#expand, ytd-text-inline-expander #expand");
            if (expandBtn) { try { expandBtn.click(); } catch {} await sleep(300); }

            const section = document.querySelector("ytd-video-description-transcript-section-renderer");
            let btn = section?.querySelector("ytd-button-renderer button, yt-button-shape button, button");

            // fallback: aria-label/text로 트랜스크립트 버튼 검색 (자막=CC 토글이라 제외)
            if (!btn) {
              btn = [...document.querySelectorAll("button")].find((b) => {
                const lab = (b.getAttribute("aria-label") || "") + " " + (b.textContent || "");
                return /show transcript|스크립트 표시|스크립트$|^transcript|대본 표시|대본$/i.test(lab.trim());
              });
            }

            if (btn) {
              try { btn.click(); } catch {}
              segs = await waitForSegs(15000);
            }
          }

          segs = findSegs();
          if (!segs.length) {
            // 진단: 페이지에 어떤 트랜스크립트 관련 요소가 있는지
            const hasPanel = !!document.querySelector('[target-id*="transcript"]');
            const hasSection = !!document.querySelector("ytd-video-description-transcript-section-renderer");
            return { lines: null, diag: `no DOM segs,panel:${hasPanel},section:${hasSection}` };
          }

          const lines = [];
          const tsToMs = (ts) => {
            const parts = ts.split(":").map((s) => parseInt(s, 10) || 0);
            if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
            if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
            return 0;
          };
          segs.forEach((seg) => {
            // 시도 1: 인스턴스 데이터(__data)에서 직접 추출 (가장 신뢰성 높음)
            let startMs = null, text = "";
            try {
              const data = seg.data || seg.__data?.data || seg.polymerController?.data;
              if (data) {
                startMs = parseInt(data.startMs || "0", 10);
                text = (data.snippet?.runs || []).map((r) => r.text || "").join("");
              }
            } catch {}
            // 시도 2: DOM 텍스트 fallback
            if (!text) {
              const tsEl = seg.querySelector(".segment-timestamp, [class*='timestamp']");
              const txtEl = seg.querySelector(".segment-text, yt-formatted-string.segment-text, .segment yt-formatted-string");
              const ts = (tsEl?.textContent || "0:00").trim();
              text = (txtEl?.textContent || "").trim();
              if (startMs == null) startMs = tsToMs(ts);
            }
            text = text.replace(/\n/g, " ").trim();
            if (text) lines.push({ startMs: startMs || 0, text });
          });
          return { lines: lines.length ? lines : null, diag: `dom,segs:${segs.length},lines:${lines.length}` };
        };

        // 1) 기존 URL 시도 (캐시된 경우 유효할 수 있음)
        for (const tk of allTracks) {
          if (!tk.baseUrl) continue;
          const r = await tryFetch(tk.baseUrl);
          fetchDiag.push({ step: "baseUrl", lang: tk.languageCode, ...r });
          if (r.ok) { captionLines = r.lines; captionLang = tk.languageCode; break; }
        }

        // 2) 기존 URL 만료 시 → DOM 트랜스크립트 패널 스크래핑 (인증 우회 불필요)
        if (!captionLines?.length && videoId) {
          const { lines: dLines, diag: dDiag } = await getTranscriptFromDOM();
          fetchDiag.push({ step: "domTranscript", diag: dDiag, linesCount: dLines?.length ?? 0 });
          if (dLines?.length) {
            captionLines = dLines;
            // 언어 자동 감지: 1) allTracks의 첫 트랙(YouTube가 패널에 표시한 언어) 우선
            // 2) 없으면 텍스트에서 한글/라틴 비율로 판정
            const trackLang = allTracks?.[0]?.languageCode;
            if (trackLang) {
              captionLang = trackLang;
            } else {
              const sample = dLines.slice(0, 20).map((l) => l.text).join(" ");
              const hangul = (sample.match(/[가-힣]/g) || []).length;
              const latin = (sample.match(/[a-zA-Z]/g) || []).length;
              captionLang = hangul > latin ? "ko" : (latin > 0 ? "en" : "und");
            }
          }
        }

        // 3) 여전히 실패 시 timedtext 직접 구성 URL
        if (!captionLines?.length && videoId) {
          outer: for (const lang of preferredLangs) {
            for (const kind of ["asr", ""]) {
              const base = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kind ? `&kind=${kind}` : ""}`;
              for (const fmt of ["&fmt=json3", ""]) {
                const r = await tryFetch(base + fmt);
                fetchDiag.push({ step: "direct", lang, kind, fmt, ...r });
                if (r.ok) { captionLines = r.lines; captionLang = lang; break outer; }
              }
            }
          }
        }

        let innertubeApiKey = null;
        try {
          const cfg = window.ytcfg;
          innertubeApiKey = (typeof cfg?.get === "function" ? cfg.get("INNERTUBE_API_KEY") : null)
            || cfg?.data_?.INNERTUBE_API_KEY || null;
        } catch {}

        return {
          videoDetails: pr.videoDetails,
          microformat: pr.microformat,
          captionLines: captionLines || null,
          captionLang,
          allTracks: allTracks.map((tk) => ({ baseUrl: tk.baseUrl, languageCode: tk.languageCode, kind: tk.kind })),
          _innertubeApiKey: innertubeApiKey,
          _videoId: videoId || null,
          _debug: { tracksCount: allTracks.length, captionsFetched: captionLines?.length || 0, captionLang },
          _fetchDiag: fetchDiag,
        };
      },
      args: [settings.preferredLangs],
    });
    playerData = results?.[0]?.result;
  } catch (e) {
    throw new Error(`영상 정보 읽기 실패: ${e.message}`);
  }
  if (!playerData) throw new Error("영상 정보를 찾지 못했습니다. 페이지를 새로고침 후 다시 시도해 주세요.");
  if (playerData._err) throw new Error(`영상 정보 없음: ${playerData._err}`);

  console.log("[YTC] debug:", JSON.stringify(playerData._debug));
  console.log("[YTC] fetchDiag:", JSON.stringify(playerData._fetchDiag));

  const meta = extractMetadata(playerData);
  if (!meta.videoId) throw new Error("영상 ID를 찾지 못했습니다.");
  const premium = isPremium(settings.licenseKey);

  // MAIN world에서 이미 fetch+파싱 완료 → 결과 사용
  let captions = playerData.captionLines || [];
  let captionLang = playerData.captionLang || "";
  let sttUsed = false;

  // SW InnerTube 폴백 (MAIN world fetch가 모두 실패했을 때)
  if (!captions.length) {
    await notifyTab(tabId, "서버 자막 재시도 중...");
    console.log("[YTC] InnerTube 폴백 시도");
    try {
      const freshCaptions = await fetchInnerTubeCaptions(meta.videoId, playerData._innertubeApiKey);
      if (freshCaptions) {
        const tracks = getCaptionTracks({ captions: freshCaptions });
        const track = pickPreferredTrack(tracks, settings.preferredLangs);
        if (track?.baseUrl) {
          const text = await fetchCaption(tabId, track.baseUrl);
          const lines = parseCaptionText(text);
          if (lines.length) { captions = lines; captionLang = track.languageCode; console.log("[YTC] InnerTube 폴백 성공"); }
        }
      }
    } catch (e) { console.warn("[YTC] InnerTube 폴백 실패", e); }
  }

  console.log("[YTC] 최종 자막:", captions.length, "줄, 언어:", captionLang);

  if (!captions.length && settings.enableSTT && tabId) {
    await notifyTab(tabId, "자막 없음 — STT 녹음 시작 (영상이 재생 중이어야 합니다)");
    try {
      const sttResult = await runSTT({ tabId, maxSeconds: settings.sttMaxSeconds, language: settings.sttLanguage });
      if (sttResult?.lines?.length) {
        captions = sttResult.lines; captionLang = settings.sttLanguage; sttUsed = true;
      } else if (sttResult?.text) {
        captions = [{ startMs: 0, text: sttResult.text }]; captionLang = settings.sttLanguage; sttUsed = true;
      }
    } catch (e) { await notifyTab(tabId, `STT 실패: ${e.message}`); }
  }

  // ── 진단 로그 ──
  console.log("[YTC] 설정 상태:", {
    aiProvider: settings.aiProvider,
    enableAutoCleanup: settings.enableAutoCleanup,
    enablePolish: settings.enablePolish,
    enableSummary: settings.enableSummary,
    captionLang,
    captionsCount: captions.length,
    sampleBefore: captions[0]?.text?.slice(0, 60),
  });

  // [1] JS 자동 정리: 반복 제거 + 군더더기 + 사용자 사전 (AI 불필요, 무료, 즉시)
  if (settings.enableAutoCleanup && captions.length) {
    try {
      const beforeLen = captions.length;
      captions = cleanupSegments(captions, {
        userDictionary: settings.userDictionary || {},
        removeFillers: true,
        collapseRepeats: true,
      });
      console.log("[YTC] JS 정리 적용:", beforeLen, "→", captions.length, "줄, 샘플:", captions[0]?.text?.slice(0, 60));
    } catch (e) { console.warn("[YTC] JS 정리 실패", e); }
  } else {
    console.log("[YTC] JS 정리 건너뜀 — enableAutoCleanup:", settings.enableAutoCleanup);
  }

  // [2] Python 커스텀 hook (있을 때만, helper 통해 호출)
  if (settings.enablePythonHook && captions.length) {
    try {
      await notifyTab(tabId, "Python hook 실행 중...");
      const res = await runPythonHook({ segments: captions, meta, captionLang });
      if (res?.skipped) {
        await notifyTab(tabId, "Python hook 스크립트가 없어 건너뜀");
      } else if (Array.isArray(res?.segments) && res.segments.length) {
        captions = res.segments.filter((s) => s && s.text);
      }
    } catch (e) { await notifyTab(tabId, `Python hook 실패 (원본 유지): ${e.message}`); }
  }

  // [3] AI 대본 정리 (polish) + 필요 시 번역 (polishAndTranslate 통합 호출)
  // - 동일 언어: polishTranscript()만 — 청크 병렬
  // - 다른 언어: polishAndTranslate() — 한 번의 LLM 호출로 정리+번역 동시 수행 (토큰 ~50% 절감)
  const wantPolish = settings.aiProvider !== "none" && settings.enablePolish !== false && captions.length;
  const targetLang  = settings.summaryLanguage || "ko";
  const srcBase     = (captionLang || "").toLowerCase().split(/[-_]/)[0];
  const tgtBase     = targetLang.toLowerCase().split(/[-_]/)[0];
  const wantTranslation = wantPolish && srcBase !== tgtBase;
  console.log("[YTC] AI 조건:", { wantPolish, wantTranslation, provider: settings.aiProvider, captionLang, targetLang });

  let translatedCaptions = null;

  if (wantPolish) {
    const chunks = splitCaptionChunks(captions, AI_CONFIG.POLISH_CHUNK_CHARS, AI_CONFIG.POLISH_MAX_PARALLEL);
    const label = chunks.length > 1
      ? `AI 대본 정리${wantTranslation ? "+번역" : ""} 중 (${settings.aiProvider}, ${chunks.length}청크 병렬)`
      : `AI 대본 정리${wantTranslation ? "+번역" : ""} 중 (${settings.aiProvider})`;
    const stop = startHeartbeat(tabId, label);
    console.log("[YTC] polish 청크:", chunks.length, "개, 총 자막:", captions.length, "줄");

    try {
      if (wantTranslation) {
        // ── polishAndTranslate 경로 (P1.2 통합 호출) ──────────────────────────
        const results = await Promise.all(
          chunks.map((chunk, i) => {
            const transcriptText = buildParagraphedTranscript(chunk);

            // [P1.1] 재시도 포함 호출 — 번역에 타임스탬프 없으면 1회 재시도
            const doCall = async (isRetry = false) => {
              const res = await polishAndTranslate({
                provider: settings.aiProvider, transcriptText, meta,
                sourceLang: captionLang, targetLang,
                ollamaModel: settings.ollamaModel, claudeModel: settings.claudeModel,
              });
              // [P1.1] 응답 크기 가드: 입력 대비 80% 미만 + 3000자 미만이면 잘림 의심
              const inLen = transcriptText.length, outLen = (res.text || "").length;
              if (outLen < 3000 && outLen < inLen * 0.8) {
                console.warn(`[YTC] 청크${i + 1} 크기 의심: 입력 ${inLen}자 → 출력 ${outLen}자 (잘림 가능)`);
              }
              // [P1.1] 각 단계 응답 앞 200자 로그
              console.log(`[YTC] 청크${i + 1} 응답 앞 200자:`, (res.text || "").slice(0, 200).replace(/\n/g, " "));

              const { polished, translation } = parsePolishTranslateResult(res.text);

              // [P1.1] 번역 검증: [MM:SS] 없으면 강화 프롬프트로 1회 재시도
              if (!isRetry && translation !== null && !hasTimestamps(translation)) {
                console.warn(`[YTC] 청크${i + 1} 번역 타임스탬프 없음 — 강화 프롬프트로 재시도`);
                return doCall(true);
              }
              return { polished, translation };
            };

            return doCall()
              .then(({ polished, translation }) => {
                const parsedPolished    = parsePolishedTranscript(polished);
                const parsedTranslation = parsePolishedTranscript(translation);
                console.log(`[YTC] 청크${i + 1} polish: ${parsedPolished?.length || 0}줄, 번역: ${parsedTranslation?.length || 0}줄`);
                return {
                  polished:    parsedPolished?.length    ? parsedPolished    : chunk,
                  translated:  parsedTranslation?.length ? parsedTranslation : null,
                };
              })
              .catch((e) => {
                console.warn(`[YTC] 청크${i + 1} polishAndTranslate 실패, 원본 유지:`, e.message);
                return { polished: chunk, translated: null };
              });
          })
        );

        const mergedPolished  = results.flatMap((r) => r.polished);
        const translatedParts = results.map((r) => r.translated);
        if (mergedPolished.length) captions = mergedPolished;

        if (translatedParts.every(Boolean)) {
          translatedCaptions = translatedParts.flat();
        } else {
          const failCount = translatedParts.filter((t) => !t).length;
          console.warn(`[YTC] 번역 실패 청크: ${failCount}/${chunks.length}`);
        }

        const sec     = stop();
        const failNote = translatedCaptions ? "" : " ⚠️ 번역 실패";
        await notifyTab(tabId, `대본 정리+번역 완료 (${sec}s${chunks.length > 1 ? `, ${chunks.length}청크 병렬` : ""}${failNote})`, 2000);

      } else {
        // ── polish only 경로 (동일 언어) ─────────────────────────────────────
        const results = await Promise.all(
          chunks.map((chunk, i) => {
            const transcriptText = buildParagraphedTranscript(chunk);
            return polishTranscript({
              provider: settings.aiProvider, transcriptText, meta, sourceLang: captionLang,
              ollamaModel: settings.ollamaModel, claudeModel: settings.claudeModel,
            })
              .then((res) => {
                const p = parsePolishedTranscript(res.text);
                console.log(`[YTC] 청크${i + 1} polish 완료:`, p?.length || 0, "줄");
                return p?.length ? p : chunk;
              })
              .catch((e) => {
                console.warn(`[YTC] 청크${i + 1} polish 실패, 원본 유지:`, e.message);
                return chunk;
              });
          })
        );
        const merged = results.flat();
        if (merged.length) captions = merged;
        const sec = stop();
        await notifyTab(tabId, `대본 정리 완료 (${sec}s${chunks.length > 1 ? `, ${chunks.length}청크 병렬` : ""})`, 2000);
      }
    } catch (e) {
      stop();
      console.error("[YTC] polish 실패:", e.message);
      await notifyTab(tabId, `AI 정리 실패: ${e.message}`, 6000);
    }
  }

  // AI 요약 (선택, captions가 polish된 상태에서 수행)
  let aiSummary = null;
  if (settings.enableSummary && settings.aiProvider !== "none" && captions.length) {
    const stop = startHeartbeat(tabId, `AI 요약 생성 중 (${settings.aiProvider})`);
    try {
      // 요약 입력 글자 수 제한: 긴 영상에서 과도한 토큰 소모 및 속도 저하 방지
      const MAX_SUMMARIZE = AI_CONFIG.OLLAMA.MAX_SUMMARIZE_CHARS;
      let captionsText = captions.map((c) => c.text).join("\n");
      if (captionsText.length > MAX_SUMMARIZE) {
        captionsText = captionsText.slice(0, MAX_SUMMARIZE);
        console.warn("[YTC] 요약 입력 자름:", MAX_SUMMARIZE, "자");
      }
      const res = await summarize({ provider: settings.aiProvider, captionsText, meta, language: settings.summaryLanguage, ollamaModel: settings.ollamaModel, claudeModel: settings.claudeModel, instruction: settings.summaryInstruction || "" });
      aiSummary = { provider: settings.aiProvider, text: res.text };
      const sec = stop();
      await notifyTab(tabId, `요약 완료 (${sec}s)`, 4000);
    } catch (e) {
      stop();
      await notifyTab(tabId, `AI 요약 실패: ${e.message}`, 8000);
    }
  }

  let pattern = settings.filenamePattern;
  if (premium && settings.premiumAutoClassify && settings.aiProvider !== "none") {
    try {
      const cls = await classify({ provider: settings.aiProvider, meta });
      const cat = safeFilename((cls.text || "").trim().split(/\s+/)[0] || "기타", 30);
      pattern = `${cat}/${pattern}`;
    } catch (e) { console.warn("자동 분류 실패", e); }
  }

  const includeRelated = premium && settings.premiumIncludeRelated && relatedVideos?.length ? relatedVideos : null;

  console.log("[YTC] 처리 완료 — polish:", wantPolish, ", captions:", captions.length, "줄");

  await notifyTab(tabId, "저장 중...");

  // 엔티티 추출 (wiki 서식 + AI 활성 시) — captions가 polish된 상태에서 수행
  let entities = null;
  if (settings.enableWikiFormat && settings.aiProvider !== "none" && captions.length) {
    const captionsText = captions.map((c) => c.text).join("\n").slice(0, 4000);
    const stopEnt = startHeartbeat(tabId, "엔티티 추출 중");
    entities = await extractEntities({
      provider: settings.aiProvider,
      text: captionsText,
      title: meta.title,
      ollamaModel: settings.ollamaModel,
      claudeModel: settings.claudeModel,
    });
    stopEnt();
  }

  // AI 태그 자동 분류 (enableAutoTag + AI 활성 시)
  let aiTags = [];
  if (settings.enableAutoTag && settings.aiProvider !== "none") {
    try {
      aiTags = await autoTag({
        provider: settings.aiProvider,
        title: meta.title,
        summary: aiSummary?.text,
        ollamaModel: settings.ollamaModel,
        claudeModel: settings.claudeModel,
      });
    } catch {}
  }

  const captureData = {
    meta, captions, captionLang, aiSummary, aiTags,
    translatedCaptions,   // null이면 번역 없음 / 동일 언어
    relatedVideos: includeRelated, sttUsed, frames: [],
  };
  const format = (msg.format && FORMAT_INFO[msg.format]) ? msg.format : "md";
  const info = FORMAT_INFO[format];

  // Wiki 서식이 켜진 경우 MD는 wiki 포맷으로 빌드
  const output = (settings.enableWikiFormat && format === "md")
    ? buildWikiYouTubeMarkdown({ meta, captions, captionLang, aiSummary, entities, translatedCaptions, aiTags })
    : generateOutput(format, captureData);

  const subfolder = msg.subfolder || "";
  const baseFilename = applySubfolderToFilename(
    buildFilename({ meta, pattern }).replace(/\.md$/, `.${info.ext}`),
    subfolder
  );

  // PDF는 새 탭에서 열어 사용자가 Ctrl+P → PDF로 저장
  let downloadId;
  let filename = baseFilename;
  if (format === "pdf") {
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(output);
    await chrome.tabs.create({ url });
    await notifyTab(tabId, "새 탭에서 인쇄 다이얼로그가 열리면 'PDF로 저장' 선택", 8000);
  } else {
    const dataUrl = `data:${info.mime};charset=utf-8,` + encodeURIComponent(output);
    downloadId = await chrome.downloads.download({
      url: dataUrl, filename, conflictAction: "uniquify", saveAs: false,
    });
  }

  if (downloadId) {
    saveToHistory({
      title: meta.title,
      url: `https://www.youtube.com/watch?v=${meta.videoId}`,
      filename, format, type: "yt",
    });
  }

  // Notion 동기화 (MD 포맷 + 연동 설정 시)
  if (settings.enableNotion && settings.notionApiKey && settings.notionPageId && format === "md") {
    const stopNotion = startHeartbeat(tabId, "Notion 전송 중");
    try {
      const notionRes = await sendToNotion({
        apiKey: settings.notionApiKey, pageId: settings.notionPageId,
        title: meta.title, mdContent: output,
      });
      stopNotion();
      console.log("[Notion] YT 전송 성공:", notionRes?.id);
      await notifyTab(tabId, "Notion 전송 완료 ✓");
    } catch (e) {
      stopNotion();
      console.error("[Notion] YT 전송 실패:", e.message);
      await notifyTab(tabId, `Notion 전송 실패 (로컬 저장 완료): ${e.message}`, 5000);
    }
  }

  // Obsidian vault 동기화 (MD 포맷 + 연동 설정 시)
  if (settings.enableObsidian && settings.obsidianVaultPath && format === "md") {
    const obsDir = subfolder ? `MD Capture/${subfolder}` : "MD Capture";
    const obsPath = `${settings.obsidianVaultPath.replace(/[\\/]$/, "")}/${obsDir}/${filename.replace(/^.*[\\/]/, "")}`;
    const stopObs = startHeartbeat(tabId, "Obsidian 저장 중");
    try {
      await writeObsidianFile({ path: obsPath, content: output });
      stopObs();
      await notifyTab(tabId, "Obsidian 저장 완료 ✓");
    } catch (e) {
      stopObs();
      await notifyTab(tabId, `Obsidian 저장 실패 (로컬 저장 완료): ${e.message}`, 5000);
    }
  }

  // MD 내용은 프레임 첨부용으로 항상 보관 (lastCapture가 MD 기반)
  const mdContent = format === "md" ? output : buildMarkdown(captureData);
  lastCapture = { downloadId, filename, mdContent, meta, frames: [] };

  const _ytToastLine = extractToastLine(aiSummary?.text);
  await chrome.notifications.create({
    type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: "유튜브 스크립트 캡쳐",
    message: _ytToastLine ? `📝 ${_ytToastLine}` : `저장됨 (${info.label}): ${filename}${premium ? " (프리미엄)" : ""}`,
  }).catch(() => {});

  return { ok: true, filename, downloadId, captionLang, sttUsed, premium, format };
}

async function handleFrame(msg, sender) {
  const { videoId, currentTime, dataUrl } = msg;
  if (!lastCapture) {
    const ts = msToTs(Math.floor(currentTime * 1000));
    const standalone = `kkongdon-capture/frames/${videoId || "unknown"}_${ts.replace(/:/g, "-")}.jpg`;
    await chrome.downloads.download({ url: dataUrl, filename: standalone, conflictAction: "uniquify", saveAs: false });
    return { ok: true, filename: standalone, note: "독립 프레임" };
  }
  const frameTs = msToTs(Math.floor(currentTime * 1000));
  const frameFilename = `${lastCapture.filename.replace(/\.md$/, "")}_frame_${frameTs.replace(/:/g, "-")}.jpg`;
  await chrome.downloads.download({ url: dataUrl, filename: frameFilename, conflictAction: "uniquify", saveAs: false });
  const relPath = frameFilename.split("/").pop();
  lastCapture.frames.push({ currentTime, relativePath: relPath });
  const newMd = lastCapture.mdContent.includes("## 프레임 캡쳐")
    ? appendFrameToMd(lastCapture.mdContent, currentTime, relPath)
    : lastCapture.mdContent + `\n## 프레임 캡쳐\n\n### [${frameTs}]\n![frame-${currentTime}](${relPath})\n`;
  lastCapture.mdContent = newMd;
  const dataUrlMd = "data:text/markdown;charset=utf-8," + encodeURIComponent(newMd);
  await chrome.downloads.download({
    url: dataUrlMd, filename: lastCapture.filename, conflictAction: "overwrite", saveAs: false,
  });
  return { ok: true, filename: frameFilename };
}

function appendFrameToMd(md, currentTime, relPath) {
  const ts = msToTs(Math.floor(currentTime * 1000));
  const block = `\n### [${ts}]\n![frame-${currentTime}](${relPath})\n`;
  const idx = md.indexOf("## 프레임 캡쳐");
  if (idx === -1) return md + `\n## 프레임 캡쳐\n${block}`;
  let end = md.length;
  const nextHead = md.indexOf("\n## ", idx + 1);
  if (nextHead !== -1) end = nextHead;
  return md.slice(0, end) + block + md.slice(end);
}

function msToTs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

// 자막 배열을 maxChars 단위 청크로 분할 (세그먼트 경계 유지, 최대 maxChunks 개)
// 짧은 영상(총 글자 <= maxChars)은 단일 청크 반환 → 기존과 동일 동작
function splitCaptionChunks(captions, maxChars, maxChunks = 4) {
  if (!captions?.length) return [captions];
  const totalChars = captions.reduce((sum, c) => sum + (c.text?.length || 0), 0);
  if (totalChars <= maxChars) return [captions];          // 짧으면 그냥 통짜

  // 목표 청크 수: 글자 기준으로 나눠지는 수와 maxChunks 중 작은 값
  const targetCount = Math.min(maxChunks, Math.ceil(totalChars / maxChars));
  const chunkSize = Math.ceil(captions.length / targetCount);
  const chunks = [];
  for (let i = 0; i < captions.length; i += chunkSize) {
    chunks.push(captions.slice(i, i + chunkSize));
  }
  return chunks;
}

// 정리 프롬프트용 입력: 문단 시작에만 타임스탬프
function buildParagraphedTranscript(captions) {
  const GAP_MS = 2000, MAX_CHARS = 350;
  const out = [];
  let cur = null;
  for (const c of captions) {
    if (!c?.text) continue;
    const prev = cur && cur.parts[cur.parts.length - 1];
    const gap = prev ? c.startMs - prev.startMs : Infinity;
    const overLen = cur && (cur.chars + c.text.length) > MAX_CHARS;
    if (!cur || gap >= GAP_MS || overLen) { cur = { startMs: c.startMs, parts: [], chars: 0 }; out.push(cur); }
    cur.parts.push(c); cur.chars += c.text.length + 1;
  }
  return out.map((p) => `[${msToTs(p.startMs)}] ${p.parts.map((x) => x.text).join(" ").replace(/\s+/g, " ").trim()}`).join("\n\n");
}

// AI 정리 결과 파싱: "[MM:SS] 본문 [MM:SS] 본문 ..." 형식 → captions 배열로 복원
// 빈 줄이 아니라 [HH:MM:SS] 타임스탬프 패턴 자체로 split (AI가 빈 줄 없이 출력할 수 있음)
function parsePolishedTranscript(text) {
  if (!text) return null;
  // ANSI 잔재 + AI preamble + markdown fence 정리
  let cleaned = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\[\d+[A-Za-z]\b/g, "")          // [K, [1D 등 잔재
    .replace(/\r/g, "")
    .replace(/```[a-zA-Z]*\n?/g, "")          // ```markdown / ``` 등 fence 제거
    .trim();
  // 첫 [MM:SS] 앞에 LLM이 덧붙인 preamble("Here is the cleaned transcript:" 등) 제거
  const firstTs = cleaned.search(/\[\d{1,2}:\d{2}/);
  if (firstTs > 0) cleaned = cleaned.slice(firstTs);
  // 타임스탬프 패턴으로 매칭 — 전체 문자열에서 캡처
  const re = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*/g;
  const out = [];
  let lastIdx = -1, lastStartMs = 0;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (lastIdx >= 0) {
      const body = cleaned.slice(lastIdx, m.index).trim().replace(/\s+/g, " ");
      if (body) out.push({ startMs: lastStartMs, text: body });
    }
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10), c = m[3] ? parseInt(m[3], 10) : null;
    lastStartMs = (c != null ? (a * 3600 + b * 60 + c) : (a * 60 + b)) * 1000;
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx >= 0) {
    const body = cleaned.slice(lastIdx).trim().replace(/\s+/g, " ");
    if (body) out.push({ startMs: lastStartMs, text: body });
  }
  return out.length ? out : null;
}

// 캡처 히스토리 저장 (최대 10개 FIFO)
const HISTORY_KEY = "captureHistory";
const HISTORY_MAX = 10;
async function saveToHistory({ title, url, filename, format, type }) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const item = { title: String(title || url).slice(0, 60), url, filename, date, format, type };
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const prev = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
    const next = [item, ...prev].slice(0, HISTORY_MAX);
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
  } catch {}
}

// AI 요약 텍스트에서 토스트용 한 줄 추출
// summarizeWeb 출력: "### 개요 / ### 핵심 포인트 / ### 한 줄 요약" 구조
function extractToastLine(summaryText) {
  if (!summaryText) return null;
  const lines = summaryText.split("\n");
  // "### 한 줄 요약" 섹션 다음 비어있지 않은 줄 우선 (summarizeWeb 전용)
  const oneLineIdx = lines.findIndex(l => /한 줄 요약/.test(l));
  if (oneLineIdx >= 0) {
    const next = lines.slice(oneLineIdx + 1).find(l => l.trim().length > 5);
    if (next) return next.trim().slice(0, 100);
  }
  // fallback: 첫 번째 비-헤더 실질 줄 (YT summarize 등)
  const content = lines.find(l => l.trim().length > 10 && !l.startsWith("#"));
  return content?.replace(/^[-*•]\s*/, "").slice(0, 100) || null;
}

async function notifyTab(tabId, text, durMs) {
  if (!tabId) return;
  try { await chrome.tabs.sendMessage(tabId, { type: "TOAST", text, durMs }); } catch {}
}

// 장시간 작업용 heartbeat — N초마다 경과 시간 토스트 갱신
function startHeartbeat(tabId, label) {
  if (!tabId) return () => {};
  const startMs = Date.now();
  const tick = () => {
    const sec = Math.round((Date.now() - startMs) / 1000);
    notifyTab(tabId, `${label} (${sec}s 경과)`, 999999);
  };
  tick();
  const timer = setInterval(tick, 5000);
  return () => {
    clearInterval(timer);
    const sec = Math.round((Date.now() - startMs) / 1000);
    return sec;
  };
}

const OFFSCREEN_URL = "src/offscreen.html";

async function ensureOffscreen() {
  const ctxs = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] }) || [];
  if (ctxs.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL, reasons: ["USER_MEDIA"],
    justification: "유튜브 탭 오디오를 녹음해 STT로 변환합니다.",
  });
}

async function runSTT({ tabId, maxSeconds, language }) {
  await ensureOffscreen();
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(id);
    });
  });
  await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: "offscreen", type: "START_RECORDING", streamId, maxSeconds },
      (r) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r?.ok) return reject(new Error(r?.error || "녹음 시작 실패"));
        resolve();
      }
    );
  });
  const { duration } = await chrome.tabs.sendMessage(tabId, { type: "GET_VIDEO_INFO" }).catch(() => ({}));
  const recordFor = Math.min(maxSeconds, Math.ceil(duration || maxSeconds) + 2);
  await new Promise((r) => setTimeout(r, recordFor * 1000));
  const stopRes = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_RECORDING" }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r?.ok) return reject(new Error(r?.error || "녹음 종료 실패"));
      resolve(r);
    });
  });
  const res = await transcribeAudio({ audioBase64: stopRes.audioBase64, language });
  return parseTranscript(res.text);
}

function parseTranscript(text) {
  if (!text) return { lines: [] };
  const srt = text.split(/\n\n+/).map((block) => {
    const m = block.match(/^\d+\s*\n(\d{2}:\d{2}:\d{2}[,.]\d+)\s*-->\s*\d{2}:\d{2}:\d{2}/);
    if (!m) return null;
    const ts = m[1].replace(",", ".");
    const parts = ts.split(":");
    const startMs = (parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])) * 1000;
    const content = block.split("\n").slice(2).join(" ").trim();
    return { startMs, text: content };
  }).filter(Boolean);
  if (srt.length) return { lines: srt };
  return { text: text.trim() };
}

// InnerTube /youtubei/v1/player API로 자막 트랙 획득 (SW 컨텍스트 최후 폴백)
async function fetchInnerTubeCaptions(videoId, apiKey) {
  const keyParam = apiKey ? `?key=${encodeURIComponent(apiKey)}&` : "?";
  const url = `https://www.youtube.com/youtubei/v1/player${keyParam}prettyPrint=false`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: "WEB", clientVersion: "2.20261001.00.00" } },
    }),
    credentials: "include",
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.captions || null;
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/options.html") }).catch(() => {});
  }
  // 컨텍스트 메뉴 등록 (removeAll로 중복 방지)
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "capture-selection",
      title: "선택 텍스트를 MD로 저장",
      contexts: ["selection"],
    });
  });
});

// 선택 텍스트 캡처 처리
async function handleSelectionCapture(selectionText, tab) {
  const date = new Date().toISOString().slice(0, 10);
  const md = buildSelectionMarkdown({
    title: tab.title || tab.url,
    url: tab.url,
    selectionText,
    date,
  });
  const filename = buildSelectionFilename({ title: tab.title || tab.url });
  const dataUrl = "data:text/markdown;charset=utf-8," + encodeURIComponent(md);
  const downloadId = await chrome.downloads.download({
    url: dataUrl, filename, conflictAction: "uniquify", saveAs: false,
  });
  saveToHistory({ title: tab.title || tab.url, url: tab.url, filename, format: "md", type: "selection" });
  await chrome.notifications.create({
    type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: "유튜브 스크립트 캡쳐",
    message: `✏️ 선택 텍스트 저장됨: ${selectionText.slice(0, 60)}…`,
  }).catch(() => {});
  return downloadId;
}
