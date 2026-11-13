// npm run docs:extract: reads every PDF in public/docs/ one page at a time and
// writes the text of each page to lib/copper/data/document-pages.json. Ask
// Copper's search_documents tool searches that file, so every answer can point
// to a document and a page. Run it again whenever a PDF changes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The same ids as lib/copper/documents.ts (a PDF is public/docs/<id>.pdf).
const ids = [
  "copper-home-user-guide",
  "copper-notes-user-guide",
  "copper-terms-and-conditions",
  "copper-plus-faq",
];

// The footer repeated on every page ("CSL-KB-0310 ... Page 5 of 6" and the
// copyright line) says nothing about the page, so it is left out.
const FOOTER = /^(CSL-[A-Z]+-\d+\b.*|©.*)$/;

const documents = [];
for (const id of ids) {
  const bytes = new Uint8Array(readFileSync(join(root, "public/docs", `${id}.pdf`)));
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((pageText, index) => ({
    page: index + 1,
    text: pageText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !FOOTER.test(line))
      .join("\n"),
  }));
  documents.push({ id, pageCount: totalPages, pages });
  console.log(`${id}: ${totalPages} pages`);
}

const out = join(root, "lib/copper/data/document-pages.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ documents }, null, 2) + "\n");
console.log(`Wrote ${out}`);
