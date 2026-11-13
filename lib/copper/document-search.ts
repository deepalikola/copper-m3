// Searches Copper's customer documents, one page at a time, so Ask Copper can
// answer from them and say exactly where the answer came from.
//
// The pages come from lib/copper/data/document-pages.json (made from the PDFs
// by `npm run docs:extract`). A page is scored with BM25, a standard way to rank
// text by how well it matches the words in a question: rare words (like "C-31"
// or "refund") count for a lot, and words on nearly every page (like "copper")
// count for almost nothing.
import data from "./data/document-pages.json";
import { DOCUMENTS } from "./documents";

export type DocumentHit = {
  documentId: string;
  title: string;
  kind: string;
  page: number;
  pageCount: number;
  /** Opens the PDF at this page. */
  url: string;
  /** The whole page, as text. */
  text: string;
  /** The line of the page that best matches the question. */
  snippet: string;
  score: number;
};

export type DocumentSearch = {
  query: string;
  /** Best match first. Empty when no page shares a useful word with the query. */
  results: DocumentHit[];
  /** Words in the query that appear nowhere in any document. */
  notInDocuments: string[];
};

const STOPWORDS = new Set(
  `a about after all am an and any are as at be been but by can could did do does
  for from get give had has have how i if in into is it its just me my no not of
  on or our please so some than that the their them then there these they this
  to up us was we were what when where which who why will with would you your`
    .split(/\s+/)
    .filter(Boolean),
);

/** "Recordings", "recorded" and "recording" all become "record". */
export function stem(word: string): string {
  let result = word;
  // Plurals first, so "recordings" and "recording" end up the same.
  if (result.length > 4 && result.endsWith("ies")) {
    result = `${result.slice(0, -3)}y`;
  } else if (
    result.length > 3 &&
    result.endsWith("s") &&
    !result.endsWith("ss")
  ) {
    result = result.slice(0, -1);
  }
  for (const suffix of ["ing", "ed"]) {
    if (result.endsWith(suffix) && result.length - suffix.length >= 4) {
      return result.slice(0, -suffix.length);
    }
  }
  return result;
}

/**
 * The searchable words in some text. "C-31" stays whole (so it matches that
 * exact code) and "Wi-Fi" also counts as "wifi", so either spelling finds it.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ??
    []) {
    if (raw.includes("-")) {
      tokens.push(raw, raw.replaceAll("-", ""));
      for (const part of raw.split("-")) {
        if (part.length >= 3 && !STOPWORDS.has(part)) tokens.push(stem(part));
      }
    } else if (!STOPWORDS.has(raw)) {
      tokens.push(stem(raw));
    }
  }
  return tokens;
}

type IndexedPage = {
  documentId: string;
  page: number;
  pageCount: number;
  text: string;
  length: number;
  counts: Map<string, number>;
  /** The first word of every line: where tables and definitions put their term. */
  lineStarts: Set<string>;
};

const pages: IndexedPage[] = data.documents.flatMap((document) =>
  document.pages.map((page) => {
    const tokens = tokenize(page.text);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const lineStarts = new Set(
      page.text
        .split("\n")
        .map((line) => tokenize(line)[0])
        .filter((token): token is string => Boolean(token)),
    );
    return {
      documentId: document.id,
      page: page.page,
      pageCount: document.pageCount,
      text: page.text,
      length: tokens.length,
      counts,
      lineStarts,
    };
  }),
);

const averageLength =
  pages.reduce((total, page) => total + page.length, 0) / pages.length;

const pagesWith = new Map<string, number>();
for (const page of pages) {
  for (const token of page.counts.keys()) {
    pagesWith.set(token, (pagesWith.get(token) ?? 0) + 1);
  }
}

const K1 = 1.2;
const B = 0.75;
/** A word on only a few pages counts as rare. */
const RARE = 2;
/** How much more it counts when a line starts with it. */
const DEFINES = 1.5;

function idf(token: string): number {
  const n = pagesWith.get(token) ?? 0;
  return Math.log(1 + (pages.length - n + 0.5) / (n + 0.5));
}

function bestLine(text: string, queryTokens: Set<string>): string {
  let best = "";
  let bestScore = -1;
  for (const line of text.split("\n")) {
    // Rare words count most, so "C-31 Storage full" beats a page heading.
    const score = tokenize(line)
      .filter((token) => queryTokens.has(token))
      .reduce((total, token) => total + idf(token), 0);
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return best.length > 180 ? `${best.slice(0, 177)}...` : best;
}

/** The best-matching pages for a question, and any words the documents never use. */
export function searchDocuments(query: string, limit = 4): DocumentSearch {
  const queryTokens = [...new Set(tokenize(query))];
  const wanted = new Set(queryTokens);

  const scored = pages
    .map((page) => {
      let score = 0;
      for (const token of queryTokens) {
        const count = page.counts.get(token) ?? 0;
        if (count === 0) continue;
        score +=
          (idf(token) * (count * (K1 + 1))) /
          (count + K1 * (1 - B + B * (page.length / averageLength)));
        // A page that starts a line with a rare word is usually where it is
        // defined (a table row like "C-31 Storage full"), not just mentioned.
        if (idf(token) >= RARE && page.lineStarts.has(token)) {
          score += DEFINES * idf(token);
        }
      }
      return { page, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.page.page - b.page.page)
    .slice(0, limit);

  const results = scored.map(({ page, score }): DocumentHit => {
    const document = DOCUMENTS.find(
      (candidate) => candidate.id === page.documentId,
    )!;
    return {
      documentId: document.id,
      title: document.title,
      kind: document.kind,
      page: page.page,
      pageCount: page.pageCount,
      url: `${document.file}#page=${page.page}`,
      text: page.text,
      snippet: bestLine(page.text, wanted),
      score: Math.round(score * 100) / 100,
    };
  });

  // Words someone asked about that no document ever mentions, like "pizza".
  const notInDocuments = [
    ...new Set(
      (query.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter(
        (word) =>
          word.length >= 3 &&
          !STOPWORDS.has(word) &&
          !pagesWith.has(stem(word)) &&
          !pagesWith.has(word),
      ),
    ),
  ];

  return { query, results, notInDocuments };
}
