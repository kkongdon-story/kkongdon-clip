// 웹 페이지 본문 추출.
// 전략: 현재 탭 DOM 직접 추출 → 본문 < 500자이면 allFrames 재시도 (iframe 대응)
//       → 여전히 < 200자이면 숨겨진 탭으로 동적 렌더링 후 재추출.
// Puppeteer 불필요 — 이미 설치된 Chrome을 렌더러로 사용.

// ── 페이지 컨텍스트 실행 함수 (executeScript 주입용) ─────────────────────────
// 반드시 외부 변수 참조 없는 완전 자립 함수여야 함 (MV3 직렬화 제약).
// async 함수 OK — executeScript가 반환 Promise를 자동 unwrap (Chrome 116+).
async function _extractPageContent() {
  // ── 인라인 헬퍼 (외부 참조 없음 — MV3 직렬화 안전) ──────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── 블록-레벨 DOM 워커: textContent 대체 — 문단 구분 보존 ───────────────────
  // textContent는 레이아웃 무감각. 이 워커는 블록 태그 경계에 \n을 삽입.
  function extractBlockText(el) {
    const BLOCK = new Set([
      'P','DIV','H1','H2','H3','H4','H5','H6',
      'LI','BLOCKQUOTE','SECTION','ARTICLE','TR','TD',
    ]);
    let out = '';
    function walk(node) {
      // 공백 전용 텍스트 노드 스킵 — 위젯/빈 span 노이즈 방지
      if (node.nodeType === 3) { if (node.textContent.trim()) out += node.textContent; return; }
      if (node.nodeType !== 1) return;
      if (node.tagName === 'BR') { out += '\n'; return; }
      if (node.tagName === 'PRE') {
        out += '\n```\n' + node.textContent + '\n```\n'; return;
      }
      const isBlock = BLOCK.has(node.tagName);
      if (isBlock && out && !out.endsWith('\n')) out += '\n';
      for (const c of node.childNodes) walk(c);
      if (isBlock && out && !out.endsWith('\n')) out += '\n';
    }
    walk(el);
    return out.replace(/\t/g, ' ').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ── 가상 스크롤 DOM 구체화 ───────────────────────────────────────────────────
  // React/Vue virtual scroll은 뷰포트 밖 노드를 제거 → 스크롤 내릴수록 위 내용 유실.
  // 시맨틱 선택자가 이미 충분한 내용을 가지면 스크롤 생략 (사이드 이펙트 방지).
  const quickCheck = document.querySelector('article, [role="main"], main');
  const quickLen = quickCheck?.textContent?.trim().length || 0;

  if (quickLen < 500) {
    // 아래로 스크롤 → lazy-load 콘텐츠 구체화. scrollHeight 안정화 시 조기 종료.
    let prevH = 0;
    for (let i = 0; i < 5; i++) {
      window.scrollBy(0, window.innerHeight);
      await sleep(400);
      const h = document.body.scrollHeight;
      if (h === prevH) break;
      prevH = h;
    }
  }

  // ── 메타데이터 ──────────────────────────────────────────────────────────────
  function getMeta(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        const val = el?.content || el?.getAttribute("datetime") || el?.textContent;
        if (val?.trim()) return val.trim();
      } catch {}
    }
    return "";
  }

  const title = getMeta([
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    "article h1", ".article-title", ".post-title", "h1",
  ]) || document.title || "";

  const date = getMeta([
    'meta[property="article:published_time"]',
    'meta[name="date"]', 'meta[name="publish_date"]',
    "time[datetime]", "time",
  ]);

  const author = getMeta([
    'meta[name="author"]',
    'meta[property="article:author"]',
    ".author", ".byline", "[rel='author']",
  ]);

  // ── 노이즈 제거 (클론 작업) ──────────────────────────────────────────────────
  const NOISE = [
    "script", "style", "noscript", "iframe", "object", "embed",
    "nav", "header", "footer", "aside",
    "[class*='ad-']", "[class*='-ad']", "[id*='ad-']", "[id*='-ad']",
    "[class*='banner']", "[class*='popup']", "[class*='cookie']",
    "[class*='newsletter']", "[class*='subscribe']",
    "[class*='comment']", "[id*='comment']",
    "[id*='sidebar']", "[class*='sidebar']",
    // 추가: 공유·추천·이전다음 노이즈
    "[class*='sns-']", "[class*='share-']", "[class*='related-']",
    "[class*='recommend-']", "[class*='prev-next']",
  ].join(",");

  let root;
  try {
    root = document.body.cloneNode(true);
    root.querySelectorAll(NOISE).forEach((el) => { try { el.remove(); } catch {} });
  } catch {
    root = document.body;
  }

  // ── 본문 컨테이너 탐색 (시맨틱 → 점수 기반) ────────────────────────────────
  const BODY_SELS = [
    // 범용 시맨틱
    "article",
    '[role="main"]', "main",
    // 일반 블로그/뉴스
    ".article-content", ".post-content", ".entry-content", ".article-body",
    ".content-body", ".story-body", ".news-content", ".main-content",
    "#article-content", "#post-content", "#main-content",
    // 네이버 블로그 (Smart Editor 3 + 구버전 + SE3 뷰어 변형)
    ".se-main-container", ".se-viewer", "#postViewArea", ".post_ct", ".post_article",
    // 네이버 뉴스
    ".article_body",
    // 다음/카카오
    ".article-view", ".news-content-area",
    // 티스토리
    "#content-inner",
    // 브런치
    ".wrap_body_area",
  ];

  let bodyEl = null;
  for (const sel of BODY_SELS) {
    try {
      const el = root.querySelector(sel);
      if (el && el.textContent.trim().length > 200) { bodyEl = el; break; }
    } catch {}
  }

  // root(클론)에서 실패 시 원본 document에서 직접 재시도
  // (클론 후 NOISE 제거 과정에서 선택자가 사라지는 경우 방어)
  if (!bodyEl) {
    for (const sel of BODY_SELS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 200) { bodyEl = el; break; }
      } catch {}
    }
  }

  // 시맨틱 선택자 실패 시 텍스트 밀도 기반 점수 탐색
  // article, section, li 우선 → div 폴백
  if (!bodyEl) {
    let best = null, bestScore = 0;
    for (const el of root.querySelectorAll("article, section, li, div")) {
      const pLen = [...el.querySelectorAll("p")].reduce((s, p) => s + p.textContent.length, 0);
      const score = pLen - el.children.length * 3;
      if (score > bestScore && score > 200) { bestScore = score; best = el; }
    }
    bodyEl = best;
  }

  // ── 본문 텍스트 추출 — DOM 워커로 문단 구분 보존 ────────────────────────────
  const bodyText = extractBlockText(bodyEl || root || document.body);

  // ── 이미지 수집 (bodyEl 기준, 추적 픽셀·data: URI 제외) ─────────────────────
  // 클론 노드는 naturalWidth=0 → URL 패턴으로 추적 픽셀 1차 필터, 크기는 2차 보조
  const TRACK_RE = /\/(?:px|beacon|track|pixel|1x1|spacer)[._/]|[?&](?:w|h|width|height)=1(?:[&#]|$)|\.gif\?/i;
  const images = [];
  (bodyEl || root).querySelectorAll("img").forEach((img) => {
    const rawSrc = img.getAttribute("src") || img.getAttribute("data-src") || img.src || "";
    if (!rawSrc || rawSrc.startsWith("data:")) return;
    let absUrl;
    try { absUrl = new URL(rawSrc, location.href).href; } catch { return; }
    if (!absUrl.startsWith("http")) return;   // http/https만 허용
    if (TRACK_RE.test(absUrl)) return;        // 추적 픽셀 URL 패턴 제외
    const nw = img.naturalWidth;
    if (nw > 0 && nw < 100) return;           // 로드된 이미지가 100px 미만이면 아이콘으로 간주
    images.push({ src: absUrl, alt: (img.alt || "").trim() });
  });

  // 본문이 짧을 때 mainFrame iframe src 힌트 반환
  // 네이버 블로그는 <iframe id="mainFrame"> 안에 본문이 있어 allFrames 주입이 차단됨
  // → 서비스 워커가 해당 URL을 직접 동적 탭으로 열어 우회
  const _iframeSrc = (bodyText.length < 100)
    ? (document.querySelector('iframe#mainFrame, iframe[name="mainFrame"]')?.src || null)
    : null;

  return { title: title.trim(), url: location.href, date, author, bodyText, images, _iframeSrc };
}

// ── 현재 탭 정적 추출 (+ allFrames iframe 폴백) ──────────────────────────────
export async function extractFromTab(tabId) {
  // 1차: main frame
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: _extractPageContent,
  });
  let data = results?.[0]?.result || null;
  // allFrames 선택 과정에서 덮어쓰여도 iframe 힌트를 잃지 않도록 보존
  const iframeSrcHint = data?._iframeSrc || null;

  // 2차: allFrames 재시도 — Naver Blog 등 iframe 기반 사이트 대응
  // manifest의 <all_urls> + scripting 권한으로 모든 프레임 커버
  if (!data?.bodyText || data.bodyText.length < 500) {
    const allResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      func: _extractPageContent,
    }).catch(() => []);
    // 위젯/팝업/CDN 프레임 제외 — 이웃커넥트 위젯 등이 본문보다 길게 잡히는 문제 방지
    const WIDGET_URL = /Widget|widget|gadget|connect\/Widget|\/popup\/|cdn\.|\.cdn\./i;
    // 품질 점수: 20자 이상 줄의 총 길이 (짧은 이름 반복보다 실제 문장 우선)
    const qualityScore = (d) =>
      (d?.bodyText || '').split('\n')
        .filter(l => l.trim().length > 20)
        .reduce((s, l) => s + l.trim().length, 0);
    const best = allResults
      .map(r => r?.result)
      .filter(r => r?.bodyText?.length > 0)
      .filter(r => !WIDGET_URL.test(r?.url || ''))
      .sort((a, b) => qualityScore(b) - qualityScore(a))[0];
    // raw length 대신 quality score로 비교 — 양질의 문장이 더 많은 프레임 우선
    if (best && qualityScore(best) > qualityScore(data)) {
      data = best;
    }
  }

  // allFrames로 본문을 못 얻은 경우에도 1차 추출의 iframe 힌트를 유지
  if (iframeSrcHint && !data?._iframeSrc && (data?.bodyText?.length || 0) < 200) {
    data = { ...(data || { title: '', url: '', date: '', author: '', bodyText: '' }), _iframeSrc: iframeSrcHint };
  }

  return data;
}

// ── 숨겨진 탭으로 동적 렌더링 후 추출 ────────────────────────────────────────
// async/await 방식 — chrome.tabs.create를 await한 후 ID를 저장하므로
// onUpdated가 일찍 발생해도 tabId 필터가 정상 동작 (race condition 방지).
// try/finally가 탭 정리를 보장; URL 허용 목록으로 file:// 등 차단.
export async function extractViaDynamicTab(url) {
  // http/https만 허용 — file://, data:, javascript: 탭 생성 차단
  if (!/^https?:\/\//.test(url)) {
    throw new Error("http/https URL만 동적 탭 추출 가능");
  }

  const tab = await chrome.tabs.create({ url, active: false })
    .catch((e) => { throw new Error(`탭 생성 실패: ${e.message}`); });
  const createdTabId = tab.id;

  try {
    // 빠른 로딩/캐시 페이지 대응: 이미 완료 상태면 즉시 추출
    // extractFromTab 재사용 → allFrames 재시도 포함 (Naver Blog 등 iframe 사이트 대응)
    const current = await chrome.tabs.get(createdTabId).catch(() => null);
    if (current?.status === "complete") {
      return await extractFromTab(createdTabId);
    }

    // 아직 로딩 중이면 onUpdated 대기 (타임아웃 25s — 무거운 SPA 대응)
    return await new Promise((resolve, reject) => {
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error("동적 탭 렌더링 타임아웃 (25s)"));
      }, 25000);

      async function onUpdated(tabId, changeInfo) {
        if (tabId !== createdTabId || changeInfo.status !== "complete") return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        try {
          // extractFromTab 재사용 → allFrames 재시도 포함
          resolve(await extractFromTab(tabId));
        } catch (e) {
          reject(new Error(`동적 추출 실패: ${e.message}`));
        }
      }

      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  } finally {
    // 탭 항상 정리 (성공·실패·타임아웃 무관)
    chrome.tabs.remove(createdTabId).catch(() => {});
  }
}

// ── 메인: 정적 → 동적 자동 전환 ──────────────────────────────────────────────
// allFrames 재시도 임계값: 500자 (extractFromTab 내부에서 처리)
// 동적 탭 폴백 임계값: 200자 (고비용, 매우 짧을 때만)
const MIN_BODY_CHARS = 200;

export async function captureWebPage(tabId, url) {
  // 1차: 현재 탭 DOM 직접 추출 (빠름, allFrames 재시도 포함)
  let data = null;
  try {
    data = await extractFromTab(tabId);
  } catch (e) {
    console.warn("[WEB] 정적 추출 실패:", e.message);
  }

  // 2차: 본문이 너무 짧으면 동적 탭 전환
  // iframe 힌트가 있으면 (네이버 블로그 등) iframe URL을 직접 열어 sandbox 우회
  if (!data?.bodyText || data.bodyText.length < MIN_BODY_CHARS) {
    const dynamicUrl = data?._iframeSrc || url;
    if (data?._iframeSrc) {
      console.log("[WEB] iframe 직접 추출:", dynamicUrl.slice(0, 80));
    } else {
      console.log("[WEB] 본문 부족 (", data?.bodyText?.length ?? 0, "자) → 동적 탭 전환");
    }
    try {
      const dynamic = await extractViaDynamicTab(dynamicUrl);
      // 동적 결과가 더 풍부하면 교체 — 원본 URL은 보존
      if ((dynamic?.bodyText?.length || 0) > (data?.bodyText?.length || 0)) {
        data = { ...(dynamic || {}), url };
      }
    } catch (e) {
      console.warn("[WEB] 동적 탭 실패:", e.message);
      if (!data) throw e;
    }
  }

  // 로그인 벽·유료 콘텐츠 경고
  if ((data?.bodyText?.length || 0) < 100) {
    data = {
      ...data,
      bodyText: "⚠️ 본문이 너무 짧습니다 (로그인 또는 유료 콘텐츠일 수 있음)\n\n" + (data?.bodyText || ""),
    };
  }

  console.log("[WEB] 최종 본문:", data?.bodyText?.length ?? 0, "자, 제목:", data?.title?.slice(0, 50));
  return data || { title: "", url, date: "", author: "", bodyText: "" };
}
