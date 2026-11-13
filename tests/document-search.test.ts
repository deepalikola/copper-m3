// Ask Copper answers support questions from Copper's PDFs, one page at a time,
// and says which page. These check the page text, the search, the
// search_documents tool and the citation links, with no AI key and no cost.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import data from "@/lib/copper/data/document-pages.json";
import { sourcesIn, splitCitations } from "@/lib/copper/citations";
import { searchDocuments, stem, tokenize } from "@/lib/copper/document-search";
import { DOCUMENTS } from "@/lib/copper/documents";
import {
  copperTools,
  findInDocuments,
  searchDocumentsInput,
} from "@/lib/copper/assistant/tools";

const hit = (query: string, title: string, page: number) =>
  searchDocuments(query).results.findIndex(
    (r) => r.title === title && r.page === page,
  );

describe("the document pages", () => {
  it("covers all four PDFs, page by page", () => {
    expect(data.documents.map((d) => d.id).sort()).toEqual(
      DOCUMENTS.map((d) => d.id).sort(),
    );
    const counts = Object.fromEntries(
      data.documents.map((d) => [d.id, d.pageCount]),
    );
    expect(counts).toEqual({
      "copper-home-user-guide": 10,
      "copper-notes-user-guide": 9,
      "copper-terms-and-conditions": 7,
      "copper-plus-faq": 6,
    });
    for (const document of data.documents) {
      expect(document.pages.map((p) => p.page)).toEqual(
        Array.from({ length: document.pageCount }, (_, i) => i + 1),
      );
      for (const page of document.pages) {
        expect(
          page.text.length,
          `${document.id} p${page.page}`,
        ).toBeGreaterThan(100);
        // The footer ("Page 5 of 6", the copyright line) is left out.
        expect(page.text).not.toMatch(/^©/m);
        expect(page.text).not.toMatch(/^CSL-/m);
      }
    }
  });

  it("has each PDF where its page links point", () => {
    for (const document of DOCUMENTS) {
      expect(existsSync(join("public", document.file)), document.file).toBe(
        true,
      );
    }
  });
});

describe("the search words", () => {
  it("keeps a code like C-31 whole, and treats Wi-Fi and wifi alike", () => {
    expect(tokenize("What does C-31 mean?")).toContain("c-31");
    expect(tokenize("Wi-Fi")).toContain("wifi");
    expect(tokenize("wifi")).toContain("wifi");
  });

  it("treats plurals and endings as the same word", () => {
    expect(stem("refunds")).toBe(stem("refunded"));
    expect(stem("recordings")).toBe(stem("recording"));
    expect(stem("policies")).toBe("policy");
  });
});

describe("search_documents on the three questions", () => {
  it("finds what C-31 means on Copper Notes: the troubleshooting table, page 8", () => {
    const search = searchDocuments("What does C-31 mean on Copper Notes?");
    expect(search.results[0]).toMatchObject({
      title: "Copper Notes User Guide",
      page: 8,
      url: "/docs/copper-notes-user-guide.pdf#page=8",
    });
    expect(search.results[0].text).toMatch(/C-31\s+Storage full/);
    expect(search.results[0].snippet).toContain("C-31");
    expect(search.notInDocuments).toEqual([]);
  });

  it("finds the annual Copper Plus refund rule in the FAQ and the Terms", () => {
    const top = searchDocuments(
      "Can I get a refund on an annual Copper Plus plan?",
    )
      .results.slice(0, 2)
      .map((r) => `${r.title} p${r.page}`)
      .sort();
    expect(top).toEqual([
      "Copper Plus FAQ p5",
      "Copper State Labs Terms and Conditions p4",
    ]);
  });

  it("says a pizza is in no document, so Copper can say it couldn't find it", () => {
    const search = searchDocuments("Can Copper Home order me a pizza?");
    expect(search.notInDocuments).toEqual(["pizza"]);
    for (const result of search.results) {
      expect(result.text.toLowerCase()).not.toContain("pizza");
    }
  });
});

describe("search_documents on other support questions", () => {
  it("finds the warranty, the free trial and the red-ring error codes", () => {
    expect(
      hit(
        "What's the warranty on Copper Notes?",
        "Copper State Labs Terms and Conditions",
        3,
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(
      hit(
        "How long is the free trial?",
        "Copper State Labs Terms and Conditions",
        4,
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(
      hit("my Copper Home ring flashes red", "Copper Home User Guide", 9),
    ).toBeGreaterThanOrEqual(0);
  });

  it("gives back at most four pages, best first", () => {
    const { results } = searchDocuments(
      "copper plus subscription cancel refund trial",
    );
    expect(results.length).toBeLessThanOrEqual(4);
    const scores = results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("the search_documents tool", () => {
  it("is one of Copper's tools, and tells the model what it is for", () => {
    expect(Object.keys(copperTools)).toContain("search_documents");
    const tool = copperTools.search_documents;
    expect(tool.description).toMatch(/user guides/i);
    expect(tool.description).toMatch(/page/i);
    expect(typeof tool.execute).toBe("function");
  });

  it("only accepts a question", () => {
    expect(searchDocumentsInput.safeParse({ query: "C-31" }).success).toBe(
      true,
    );
    for (const bad of [
      {},
      { query: "" },
      { query: "x" },
      { query: "a".repeat(201) },
      { query: 5 },
    ]) {
      expect(
        searchDocumentsInput.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("returns pages with their document and a link to the page", () => {
    const result = findInDocuments({ query: "C-31" });
    expect(result.results[0]).toMatchObject({
      documentId: "copper-notes-user-guide",
      page: 8,
      pageCount: 9,
    });
  });
});

describe("citations in Copper's answers", () => {
  it("turns (Document title, page N) into a link to that page of the PDF", () => {
    const parts = splitCitations(
      "C-31 means storage is full. (Copper Notes User Guide, page 8)",
    );
    expect(parts[0]).toBe("C-31 means storage is full. ");
    expect(parts[1]).toBe("(");
    expect(parts[2]).toMatchObject({
      text: "Copper Notes User Guide, page 8",
      documentId: "copper-notes-user-guide",
      page: 8,
      href: "/docs/copper-notes-user-guide.pdf#page=8",
    });
    expect(parts[3]).toBe(")");
  });

  it("understands a shorter name and several pages", () => {
    const parts = splitCitations("(Terms and Conditions, pages 4 and 5)");
    const links = parts.filter((p) => typeof p !== "string");
    expect(links.map((l) => l.href)).toEqual([
      "/docs/copper-terms-and-conditions.pdf#page=4",
      "/docs/copper-terms-and-conditions.pdf#page=5",
    ]);
  });

  it("leaves a bracket alone when it doesn't name one of the documents", () => {
    const text = "Done (Some Other Book, page 3).";
    expect(splitCitations(text)).toEqual([text]);
    expect(sourcesIn(text)).toEqual([]);
  });

  it("lists each cited page once, in order", () => {
    const sources = sourcesIn(
      "A (Copper Plus FAQ, page 5). B (Copper State Labs Terms and Conditions, page 4). C (Copper Plus FAQ, page 5).",
    );
    expect(sources.map((s) => `${s.title} p${s.page}`)).toEqual([
      "Copper Plus FAQ p5",
      "Copper State Labs Terms and Conditions p4",
    ]);
  });

  it("changes nothing in a plain answer", () => {
    expect(splitCitations("That comes to $307.")).toEqual([
      "That comes to $307.",
    ]);
    expect(sourcesIn("That comes to $307.")).toEqual([]);
  });
});
