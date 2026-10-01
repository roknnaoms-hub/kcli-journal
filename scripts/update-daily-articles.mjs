import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const indexPath = join(root, "index.html");
const dataPath = join(root, "data", "daily-articles.json");
const urlListPaths = [join(root, "data", "article-urls.md"), join(root, "data", "article-urls.txt")];
const articleLimit = positiveInteger(process.env.ARTICLE_LIMIT, 12);
// Paid model APIs are disabled by the account owner (2026-10-01).
// Article cards use public page metadata only; API keys are never read.

const START = "<!-- daily-articles:start -->";
const END = "<!-- daily-articles:end -->";

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const displayDate = today.replaceAll("-", ".");
const urls = await readArticleUrls();
const articleSources = await fetchArticleSources(urls.slice(0, articleLimit));
const daily = {
  editionDate: today,
  articles: summarizeFromMetadata(articleSources),
};

if (!daily.articles.length) {
  throw new Error("No articles could be generated from the URL list.");
}

const html = await readFile(indexPath, "utf8");
if (!html.includes(START) || !html.includes(END)) {
  throw new Error("Could not find daily article markers in index.html.");
}

const articleHtml = renderArticles(daily.articles);
const nextHtml = html.replace(
  new RegExp(`${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`),
  `${START}\n${articleHtml}\n      ${END}`,
);

await mkdir(dirname(dataPath), { recursive: true });
await writeFile(dataPath, `${JSON.stringify(daily, null, 2)}\n`, "utf8");
await writeFile(indexPath, nextHtml, "utf8");

console.log(`Updated ${daily.articles.length} articles from URL list for ${today}.`);

async function readArticleUrls() {
  const contents = [];

  for (const filePath of urlListPaths) {
    if (await exists(filePath)) {
      contents.push(await readFile(filePath, "utf8"));
    }
  }

  if (!contents.length) {
    throw new Error("Create data/article-urls.md or data/article-urls.txt with one article URL per line.");
  }

  const seen = new Set();
  const urls = [];
  const urlPattern = /https?:\/\/[^\s<>)\]"']+/gi;

  for (const content of contents) {
    for (const match of content.matchAll(urlPattern)) {
      const url = normalizeUrl(match[0]);
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }

  if (!urls.length) {
    throw new Error("No http(s) URLs were found in data/article-urls.md or data/article-urls.txt.");
  }

  return urls;
}

async function fetchArticleSources(urlsToFetch) {
  const results = await Promise.allSettled(urlsToFetch.map(fetchArticleSource));
  const sources = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      sources.push(result.value);
    } else {
      console.warn(`Skipping ${urlsToFetch[index]}: ${result.reason.message}`);
    }
  });

  if (!sources.length) {
    throw new Error("Every article URL failed to fetch.");
  }

  return sources;
}

async function fetchArticleSource(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "KCLI-Journal-Article-Updater/1.0 (+https://www.kcli.ai.kr)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const html = await response.text();
  const head = html.slice(0, 400000);

  return {
    url,
    contentType,
    title: pickFirst(
      metaContent(head, "property", "og:title"),
      metaContent(head, "name", "twitter:title"),
      tagText(head, "title"),
      url,
    ),
    description: pickFirst(
      metaContent(head, "property", "og:description"),
      metaContent(head, "name", "description"),
      metaContent(head, "name", "twitter:description"),
      "",
    ),
    sourceName: pickFirst(metaContent(head, "property", "og:site_name"), hostname(url)),
    text: htmlToText(html).slice(0, 12000),
  };
}

function summarizeFromMetadata(sources) {
  console.log("Paid AI APIs are disabled. Using article metadata only.");
  return sources.map((source, index) => ({
    category: inferCategory(`${source.title} ${source.description} ${source.text}`),
    title: clip(source.title || hostname(source.url), 45),
    summary: clip(source.description || firstSentence(source.text) || "URL 목록에 등록된 기사입니다.", 110),
    sourceName: source.sourceName || hostname(source.url),
    sourceUrl: source.url,
    order: index,
  }));
}

function renderArticles(articles) {
  return articles
    .map((article, index) => {
      const thumb = thumbFor(article.category, index);
      return `      <article class="article-card"><a class="article-source" href="${escapeAttr(article.sourceUrl)}" target="_blank" rel="noopener noreferrer"><div class="thumb ${thumb.className}"><span class="pill ${thumb.pill}">${escapeHtml(article.category)}</span><strong>${escapeHtml(thumb.label)}</strong></div><div class="article-body"><h3>${escapeHtml(article.title)}</h3><p>${escapeHtml(article.summary)}</p><time>▣ ${displayDate} · ${escapeHtml(article.sourceName)}</time></div></a></article>`;
    })
    .join("\n");
}

function thumbFor(category, index) {
  const map = {
    AI: { className: "ai", pill: "blue", label: "AI" },
    교육: { className: "edu", pill: "green", label: "CLASS" },
    사이버안전: { className: "sec", pill: "purple", label: "SECURITY" },
    "디지털 시민성": { className: "edu", pill: "green", label: "CITIZEN" },
    정책: { className: "ai", pill: "blue", label: "POLICY" },
    연구동향: { className: "sec", pill: "purple", label: "RESEARCH" },
  };
  return map[category] || [map.AI, map.교육, map.사이버안전][index % 3];
}

function metaContent(html, attr, name) {
  const pattern = new RegExp(`<meta\\s+[^>]*${attr}=["']${escapeRegExp(name)}["'][^>]*>`, "i");
  const tag = html.match(pattern)?.[0] || "";
  return decodeEntities(tag.match(/\scontent=["']([^"']*)["']/i)?.[1] || "");
}

function tagText(html, tagName) {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  return decodeEntities(html.match(pattern)?.[1] || "").trim();
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeEntities(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");
}

function inferCategory(text) {
  const value = text.toLowerCase();
  if (/(ai|인공지능|생성형|챗gpt|llm)/i.test(value)) return "AI";
  if (/(교육|학교|교사|학생|리터러시)/i.test(value)) return "교육";
  if (/(보안|해킹|피싱|랜섬웨어|개인정보|침해|사이버안전)/i.test(value)) return "사이버안전";
  if (/(시민|윤리|허위정보|디지털 시민성)/i.test(value)) return "디지털 시민성";
  if (/(정책|정부|규제|법|가이드라인)/i.test(value)) return "정책";
  return "연구동향";
}

function normalizeUrl(value) {
  return value.replace(/[.,;:!?"']+$/g, "");
}

function hostname(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

function pickFirst(...values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function firstSentence(value) {
  return String(value || "").split(/(?<=[.!?。！？]|다\.)\s+/u)[0] || "";
}

function clip(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
