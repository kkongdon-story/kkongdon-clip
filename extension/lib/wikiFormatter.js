/**
 * LLM-wiki 서식 변환기 (wiki-llm 규칙 준수)
 * ──────────────────────────────────────────────
 * wiki-llm 프로젝트 (docs/llm-wiki-rules.ko.md, schema/wiki-rules.md,
 * schema/page-template.md) 의 Source page 형식으로 변환합니다.
 *
 * 형식 특징:
 * - YAML frontmatter 없음 → 평문 key: value 메타데이터
 * - 섹션: One-line Definition / Summary / Source Links /
 *          Extracted Claims / Related Pages / Open Questions / (원문)
 * - 링크: [[concepts/slug]], [[entities/slug]], [[workflows/slug]]
 *   (Obsidian 스타일, 폴더 prefix 포함)
 * - 엔티티는 타입별 폴더 분리: 인물·조직 → entities/, 기술·개념 → concepts/
 *
 * 사용:
 *   import { buildWikiYouTubeMarkdown, buildWikiWebMarkdown } from "./wikiFormatter.js";
 */

// ── 슬러그 변환 ─────────────────────────────────────────────────────────────
// 위키 링크용: "Claude Code" → "claude-code", "한국어" → "한국어"
function toSlug(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w가-힣\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

// ── 엔티티 타입별 폴더 결정 ─────────────────────────────────────────────────
// wiki-llm: 인물·조직 → entities/, 기술·개념 → concepts/
function entityFolder(type) {
  if (type === "people" || type === "companies") return "entities";
  return "concepts"; // technologies, concepts
}

function entityTypeLabel(type) {
  const map = {
    people:       "인물",
    companies:    "조직",
    technologies: "기술",
    concepts:     "개념",
  };
  return map[type] || type;
}

// ── [[folder/slug]] 링크 생성 ───────────────────────────────────────────────
function wikiLink(name, type) {
  const folder = entityFolder(type);
  const slug   = toSlug(name);
  return `[[${folder}/${slug}]]`;
}

// ── 날짜 ────────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── AI 요약에서 섹션 추출 ───────────────────────────────────────────────────
// summarize() 출력 구조:
//   ### 개요 / ### 등장 요소 / ### 층위 분석 / ### 핵심 포인트
function extractSection(summaryText, sectionName) {
  if (!summaryText) return null;
  const lines = summaryText.split("\n");
  const startIdx = lines.findIndex((l) => l.trim().startsWith("###") && l.includes(sectionName));
  if (startIdx === -1) return null;
  const end = lines.findIndex((l, i) => i > startIdx && l.trim().startsWith("###"));
  const slice = end === -1 ? lines.slice(startIdx + 1) : lines.slice(startIdx + 1, end);
  return slice.join("\n").trim() || null;
}

// "### 핵심 포인트"에서 bullet 항목 추출 → Extracted Claims
// AI가 bullet을 여러 줄에 걸쳐 쓸 경우 이어붙임 (줄바꿈 중간 절단 방지)
function extractClaims(summaryText) {
  const section = extractSection(summaryText, "핵심 포인트");
  if (!section) return [];
  const bullets = [];
  for (const line of section.split("\n")) {
    const t = line.trim();
    if (t.startsWith("-") && t.length > 1) {
      bullets.push(t);
    } else if (t && bullets.length > 0 && !t.startsWith("#")) {
      // 이전 bullet의 연속 줄 — 공백 하나로 이어붙임
      bullets[bullets.length - 1] += " " + t;
    }
  }
  return bullets;
}

// "### 개요" → 첫 번째 완전한 문장 (마침표 기준)
// split("\n")[0] 패턴은 AI가 줄바꿈을 문장 중간에 넣으면 잘리므로, 마침표 기준으로 변경
function extractOneLiner(summaryText) {
  if (!summaryText) return null;
  const overview = extractSection(summaryText, "개요");
  if (!overview) return null;
  // 줄바꿈을 공백으로 펼친 뒤 첫 완전한 문장 추출
  const flat = overview.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  const m = flat.match(/^.+?[.!?。！？]/);
  if (m) return m[0].trim();
  // 마침표 없으면 앞 200자
  return flat.slice(0, 200).trim() || null;
}

// ── Related Pages 빌드 ──────────────────────────────────────────────────────
function buildRelatedPages(entities, extraLinks = []) {
  const lines = [...extraLinks];
  if (!entities) return lines;

  const order = ["people", "companies", "technologies", "concepts"];
  for (const type of order) {
    const items = entities[type];
    if (!items?.length) continue;
    const label = entityTypeLabel(type);
    for (const name of items) {
      lines.push(`- ${wikiLink(name, type)} (${label}: ${name})`);
    }
  }
  return lines;
}

// ── 본문에 [[wikilinks]] 주입 ──────────────────────────────────────────────
// 엔티티 이름 → [[folder/slug]] 첫 등장만 교체
function injectWikiLinks(text, entities) {
  if (!entities || !text) return text;

  // 모든 엔티티를 (name, type) 쌍으로 수집, 긴 이름 우선
  const all = [];
  for (const type of ["people", "companies", "technologies", "concepts"]) {
    for (const name of entities[type] || []) {
      all.push({ name, type });
    }
  }
  all.sort((a, b) => b.name.length - a.name.length);

  let result = text;
  const used = new Set();

  for (const { name, type } of all) {
    if (used.has(name) || name.length < 2) continue;
    const link = wikiLink(name, type);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 이미 [[...]] 안에 있지 않은 첫 등장만 교체
    const re = new RegExp(`(?<!\\[\\[)(?<![\\w가-힣])${escaped}(?![\\w가-힣])(?!\\]\\])`, "");
    const replaced = result.replace(re, link);
    if (replaced !== result) {
      result = replaced;
      used.add(name);
    }
  }
  return result;
}

// ── ms → 타임스탬프 ─────────────────────────────────────────────────────────
function msToTs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

// ── 자막 세그먼트 → 문단 그루핑 (타임스탬프 없음) ──────────────────────────
// markdown.js 의 groupCaptionsToParagraphs와 동일한 로직 (의존성 분리 유지)
function groupIntoParagraphs(captions) {
  const MAJOR_GAP = 1500;   // 문장 종결 후 1.5초 → 새 문단
  const HARD_GAP  = 5000;   // 5초 이상 → 무조건 새 문단
  const MAX_CHARS = 400;    // 한 문단 최대 약 400자
  const SENT_END  = /[.!?…。？！]\s*$/;
  const paragraphs = [];
  let cur = null;

  for (const c of captions) {
    if (!c?.text) continue;
    const prev = cur?.parts[cur.parts.length - 1];
    const gap  = prev ? c.startMs - prev.startMs : Infinity;
    const prevEnds = prev ? SENT_END.test(prev.text) : false;
    const tooLong  = cur && cur.charCount >= MAX_CHARS && prevEnds;
    const majorBreak = prevEnds && gap >= MAJOR_GAP;
    const hardBreak  = gap >= HARD_GAP;

    if (!cur || majorBreak || tooLong || hardBreak) {
      cur = { parts: [], charCount: 0 };
      paragraphs.push(cur);
    }
    cur.parts.push(c);
    cur.charCount += c.text.length + 1;
  }

  return paragraphs.map((p) => ({
    text: p.parts.map((x) => x.text).join(" ").replace(/\s+/g, " ").trim(),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// ── YouTube 캡처 → wiki Source page ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param {object} params
 * @param {object} params.meta         - { title, channel, videoId, ... }
 * @param {Array}  params.captions     - [{ startMs, text }]
 * @param {string} params.captionLang  - "ko" | "en" | ...
 * @param {object} params.aiSummary    - { provider, text } | null
 * @param {object} params.entities          - { people, companies, technologies, concepts } | null
 * @param {Array}  params.translatedCaptions - [{ startMs, text }] | null — polishAndTranslate 결과
 */
export function buildWikiYouTubeMarkdown({ meta, captions, captionLang, aiSummary, entities, translatedCaptions, aiTags }) {
  const date     = todayStr();
  const videoUrl = `https://www.youtube.com/watch?v=${meta.videoId}`;
  const title    = meta.title || "(제목 없음)";
  const channel  = meta.channel || "";
  const sourceId = `yt_${meta.videoId}`;
  const channelSlug = toSlug(channel);

  // ── 메타데이터 (평문 key: value) ──────────────────────────────────────
  const metadata = [
    `type: source`,
    `source_id: ${sourceId}`,
    `channel: ${channel}`,
    `date: ${date}`,
    `lang: ${captionLang || "und"}`,
    `url: ${videoUrl}`,
    aiTags?.length ? `tags: ${aiTags.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  // ── One-line Definition ────────────────────────────────────────────────
  const oneLiner = extractOneLiner(aiSummary?.text)
    || `${channel} 채널의 YouTube 영상.`;

  // ── Summary ────────────────────────────────────────────────────────────
  const overview = extractSection(aiSummary?.text, "개요")
    || extractSection(aiSummary?.text, "Summary")
    || "(AI 요약 없음)";
  const layerAnalysis = extractSection(aiSummary?.text, "층위 분석") || null;

  const summaryParts = [overview];
  if (layerAnalysis) summaryParts.push("\n**층위 분석:**\n" + layerAnalysis);

  // ── Source Links ──────────────────────────────────────────────────────
  const sourceLinks = [
    `- 원본 영상: [${title}](${videoUrl})`,
    `- 채널: [[entities/${channelSlug}]]`,
  ];

  // ── Extracted Claims (핵심 포인트 → bullet) ──────────────────────────
  const claims = extractClaims(aiSummary?.text);

  // ── Related Pages (entities → [[folder/slug]]) ───────────────────────
  const extraLinks = [
    `- [[entities/${channelSlug}]] (채널)`,
  ];
  const relatedLines = buildRelatedPages(entities, extraLinks);

  // ── 대본 (문단 그루핑 + [[wikilinks]], 타임스탬프 없음) ─────────────────
  const _paragraphs   = groupIntoParagraphs(captions);
  const transcriptLines = _paragraphs.map((p) => injectWikiLinks(p.text, entities));

  // ── 조립 ──────────────────────────────────────────────────────────────
  const parts = [
    `# ${title}`,
    "",
    metadata,
    "",
    "## One-line Definition",
    "",
    oneLiner,
    "",
    "## Summary",
    "",
    summaryParts.join("\n"),
    "",
    "## Source Links",
    "",
    sourceLinks.join("\n"),
    "",
    claims.length ? "## Extracted Claims\n\n" + claims.join("\n") : null,
    claims.length ? "" : null,
    "## Related Pages",
    "",
    relatedLines.length ? relatedLines.join("\n") : "- TBD",
    "",
    "## Open Questions",
    "",
    "- TBD",
    "",
    "## 대본",
    "",
    transcriptLines.join("\n\n"),
    // 번역 섹션 — polishAndTranslate 결과가 있을 때만 포함
    translatedCaptions?.length ? "" : null,
    translatedCaptions?.length ? `## 번역 (${captionLang} → ko)` : null,
    translatedCaptions?.length ? "" : null,
    translatedCaptions?.length
      ? translatedCaptions.map((c) => `[${msToTs(c.startMs)}] ${c.text}`).join("\n\n")
      : null,
  ].filter((p) => p !== null);

  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 웹 캡처 → wiki Source page ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param {object} params
 * @param {string} params.title     - 페이지 제목
 * @param {string} params.url       - 원문 URL
 * @param {string} params.date      - "YYYY-MM-DD"
 * @param {string} params.author    - 저자 (있을 때만)
 * @param {string} params.bodyText  - 본문
 * @param {object} params.aiSummary - { provider, text } | null
 * @param {object} params.entities  - { people, companies, technologies, concepts } | null
 */
export function buildWikiWebMarkdown({ title, url, date, author, bodyText, aiSummary, entities, images, includeImages, aiTags }) {
  const effectiveDate = date || todayStr();
  const domainMatch   = (url || "").match(/^https?:\/\/([^/]+)/);
  const domain        = domainMatch ? domainMatch[1] : "web";
  const sourceId      = `web_${toSlug(title || domain)}_${effectiveDate.replace(/-/g, "")}`;

  // ── 메타데이터 ─────────────────────────────────────────────────────────
  const metaLines = [
    `type: source`,
    `source_id: ${sourceId}`,
    author ? `author: ${author}` : null,
    `date: ${effectiveDate}`,
    `url: ${url || ""}`,
    aiTags?.length ? `tags: ${aiTags.join(", ")}` : null,
  ].filter(Boolean);

  // ── One-line Definition ────────────────────────────────────────────────
  const oneLiner = extractOneLiner(aiSummary?.text)
    || `${title || domain}에 관한 웹 문서.`;

  // ── Summary ────────────────────────────────────────────────────────────
  const overview = extractSection(aiSummary?.text, "개요")
    || extractSection(aiSummary?.text, "Summary")
    || (bodyText || "").slice(0, 300);

  // ── Source Links ──────────────────────────────────────────────────────
  const sourceLinks = [`- 원문: [${title || url}](${url})`];
  if (author) {
    sourceLinks.push(`- 저자: [[entities/${toSlug(author)}]]`);
  }

  // ── Extracted Claims ──────────────────────────────────────────────────
  const claims = extractClaims(aiSummary?.text);

  // ── Related Pages ─────────────────────────────────────────────────────
  const relatedLines = buildRelatedPages(entities, []);

  // ── 본문 (첫 3000자, [[wikilinks]] 주입) ─────────────────────────────
  const bodyWithLinks = injectWikiLinks((bodyText || "").slice(0, 3000), entities);

  // ── 이미지 섹션 (includeImages: true일 때만) ──────────────────────────
  const imgSection = (includeImages && images?.length)
    ? "## 이미지\n\n" + images.map(i => `![${i.alt || "image"}](${i.src})`).join("\n")
    : null;

  // ── 조립 ──────────────────────────────────────────────────────────────
  const parts = [
    `# ${title || "(제목 없음)"}`,
    "",
    metaLines.join("\n"),
    "",
    "## One-line Definition",
    "",
    oneLiner,
    "",
    "## Summary",
    "",
    overview,
    "",
    "## Source Links",
    "",
    sourceLinks.join("\n"),
    "",
    claims.length ? "## Extracted Claims\n\n" + claims.join("\n") : null,
    claims.length ? "" : null,
    "## Related Pages",
    "",
    relatedLines.length ? relatedLines.join("\n") : "- TBD",
    "",
    "## Open Questions",
    "",
    "- TBD",
    "",
    "## 본문",
    "",
    bodyWithLinks,
    imgSection ? "" : null,
    imgSection,
  ].filter((p) => p !== null);

  return parts.join("\n");
}
