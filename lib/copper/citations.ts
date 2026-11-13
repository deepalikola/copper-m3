// Turns the citations in Copper's answers into links. Copper writes them as
// "(Copper Notes User Guide, page 8)"; this finds those, works out which
// document they mean, and links to that page of the PDF.
import { DOCUMENTS, type CopperDocument } from "./documents";

export type Citation = {
  /** What to show for this link, such as "Copper Notes User Guide, page 8". */
  text: string;
  documentId: string;
  page: number;
  href: string;
};

export type CitationPart = string | Citation;

// Ways a document is likely to be named, besides its full title.
const ALIASES: Record<string, string[]> = {
  "copper-home-user-guide": ["home user guide", "copper home guide"],
  "copper-notes-user-guide": ["notes user guide", "copper notes guide"],
  "copper-terms-and-conditions": ["terms and conditions", "terms & conditions"],
  "copper-plus-faq": ["plus faq", "copper plus help"],
};

function documentNamedIn(text: string): CopperDocument | undefined {
  const lower = text.toLowerCase();
  let best: { document: CopperDocument; length: number } | undefined;
  for (const document of DOCUMENTS) {
    const names = [
      document.title.toLowerCase(),
      document.id.replaceAll("-", " "),
      ...(ALIASES[document.id] ?? []),
    ];
    for (const name of names) {
      if (lower.includes(name) && (!best || name.length > best.length)) {
        best = { document, length: name.length };
      }
    }
  }
  return best?.document;
}

const pageUrl = (document: CopperDocument, page: number) =>
  `${document.file}#page=${page}`;

// "(<something naming a document>, page 8)" or "(..., pages 4 and 8)"
const CITATION =
  /\(([^()\n]*?)[,;:]?\s*\bpages?\s+(\d+(?:\s*(?:,|and|&)\s*\d+)*)\s*\)/gi;

/** The text split into plain pieces and linked citations, in order. */
export function splitCitations(text: string): CitationPart[] {
  const parts: CitationPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    const document = documentNamedIn(match[1]);
    if (!document) continue;
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    const pages = match[2].match(/\d+/g)!.map(Number);
    const label = match[1].trim();
    parts.push("(");
    pages.forEach((page, index) => {
      if (index > 0) parts.push(", ");
      parts.push({
        text: index === 0 ? `${label}, page ${page}` : `page ${page}`,
        documentId: document.id,
        page,
        href: pageUrl(document, page),
      });
    });
    parts.push(")");
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

export type Source = { title: string; page: number; href: string };

/** Every document page an answer cites, once each, in the order it cites them. */
export function sourcesIn(text: string): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const part of splitCitations(text)) {
    if (typeof part === "string") continue;
    const key = `${part.documentId}#${part.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const document = DOCUMENTS.find((d) => d.id === part.documentId)!;
    sources.push({ title: document.title, page: part.page, href: part.href });
  }
  return sources;
}
