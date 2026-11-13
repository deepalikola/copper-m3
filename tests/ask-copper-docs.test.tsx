// Ask Copper reading the support documents: the model calls search_documents,
// the answer cites a page, and the panel shows the page as a link.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import { createLive, finalValue } from "@/lib/ai/live";
import {
  toolCallsOf,
  type Progress,
  type Step,
} from "@/lib/copper/assistant/progress";
import { searchDocuments } from "@/lib/copper/document-search";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.doUnmock("@/lib/copper/assistant/ask");
  vi.unstubAllEnvs();
  vi.resetModules();
});

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];
const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const searches = (query: string): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName: "search_documents" },
  { type: "tool-input-delta", id: "call-1", delta: JSON.stringify({ query }) },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "search_documents",
    input: JSON.stringify({ query }),
  },
  finish("tool-calls"),
];
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];
function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

async function ask(question: string) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  return finalValue(
    (
      await askCopper({
        messages: [{ role: "user", content: question }],
        useTools: true,
      })
    ).progress,
  );
}

describe("Copper's instructions", () => {
  it("send support questions to the documents and require a page citation", () => {
    expect(COPPER_INSTRUCTIONS).toContain("search_documents");
    expect(COPPER_INSTRUCTIONS).toContain("(Copper Notes User Guide, page 8)");
    expect(COPPER_INSTRUCTIONS).toContain(
      "I couldn't find that in the support docs.",
    );
    expect(COPPER_INSTRUCTIONS).toContain("notInDocuments");
    expect(COPPER_INSTRUCTIONS).toMatch(/Do not guess/);
    // Anything that isn't about products, prices or stock searches the docs
    // first, even a "can it do that?" question like the pizza one.
    expect(COPPER_INSTRUCTIONS).toMatch(
      /search_documents before you say anything else/,
    );
    expect(COPPER_INSTRUCTIONS).toContain("can Copper Home order me a pizza?");
    expect(COPPER_INSTRUCTIONS).toMatch(
      /Never answer or decline these from memory/,
    );
  });
});

describe("Ask Copper with the documents", () => {
  it("offers search_documents to the model, with the other tools", async () => {
    model = modelStreaming(says("ok"));
    await ask("Hello");
    const names = (model.doStreamCalls[0].tools ?? []).map((t) => t.name);
    expect(names).toContain("search_documents");
    expect(names).toEqual(
      expect.arrayContaining([
        "get_products",
        "get_prices",
        "calculate_cost",
        "check_availability",
      ]),
    );
  });

  it("answers what C-31 means from page 8 of the Copper Notes guide", async () => {
    model = modelStreaming(
      searches("C-31 Copper Notes"),
      says(
        "C-31 means Copper Notes' storage is full because recordings haven't uploaded yet. Connect to Wi-Fi and open the Copper app. (Copper Notes User Guide, page 8)",
      ),
    );
    const result = await ask("What does C-31 mean on Copper Notes?");
    const [call] = toolCallsOf(result);
    expect(call.name).toBe("search_documents");
    const output = call.output as ReturnType<typeof searchDocuments>;
    expect(output.results[0]).toMatchObject({
      title: "Copper Notes User Guide",
      page: 8,
    });
    // The model was handed the page text, so it can answer from it.
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      "Storage full",
    );
    expect(result.reply).toContain("(Copper Notes User Guide, page 8)");
  });

  it("hands the model the refund rule for an annual plan", async () => {
    model = modelStreaming(
      searches("refund annual Copper Plus"),
      says("Yes, within 14 days. (Copper Plus FAQ, page 5)"),
    );
    await ask("Can I get a refund on an annual Copper Plus plan?");
    const prompt = JSON.stringify(model.doStreamCalls[1].prompt);
    // The page text wraps across two lines, so check the two halves.
    expect(prompt).toContain(
      "Annual plans get a full refund if you cancel within",
    );
    expect(prompt).toContain("14 days of purchase");
  });

  it("tells the model a pizza appears in no document", async () => {
    model = modelStreaming(
      searches("order pizza Copper Home"),
      says("I couldn't find that in the support docs."),
    );
    const result = await ask("Can Copper Home order me a pizza?");
    const [call] = toolCallsOf(result);
    expect(
      (call.output as ReturnType<typeof searchDocuments>).notInDocuments,
    ).toEqual(["pizza"]);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain("pizza");
    expect(result.reply).toBe("I couldn't find that in the support docs.");
  });
});

describe("the panel", () => {
  function answered(reply: string, steps: Step[] = []) {
    const done = createLive<Progress>();
    done.done({ steps, reply, status: "done" });
    return { progress: done.live };
  }

  async function openAndAsk(
    askCopper: ReturnType<typeof vi.fn>,
    question: string,
  ) {
    vi.doMock("@/lib/copper/assistant/ask", () => ({ askCopper }));
    vi.resetModules();
    const { AskCopper: Panel } = await import("@/components/copper/ask-copper");
    render(<Panel aiConfigured />);
    fireEvent.click(screen.getByTestId("ask-copper-launcher"));
    const panel = await screen.findByTestId("ask-copper");
    const chat = within(panel);
    fireEvent.change(chat.getByRole("textbox"), {
      target: { value: question },
    });
    fireEvent.click(chat.getByRole("button", { name: /send/i }));
    return { panel, chat };
  }

  it("links a cited page in the answer and lists it under Sources", async () => {
    const search = searchDocuments("C-31 Copper Notes");
    const askCopper = vi.fn().mockResolvedValue(
      answered(
        "C-31 means storage is full. (Copper Notes User Guide, page 8)",
        [
          {
            type: "tool",
            id: "c1",
            name: "search_documents",
            state: "done",
            input: { query: "C-31 Copper Notes" },
            output: search,
          },
        ],
      ),
    );
    const { panel, chat } = await openAndAsk(
      askCopper,
      "What does C-31 mean on Copper Notes?",
    );
    await waitFor(() =>
      expect(chat.getByText(/storage is full/)).toBeInTheDocument(),
    );

    const inline = chat.getByRole("link", {
      name: "Copper Notes User Guide, page 8",
    });
    expect(inline).toHaveAttribute(
      "href",
      "/docs/copper-notes-user-guide.pdf#page=8",
    );
    expect(inline).toHaveAttribute("target", "_blank");

    const sources = within(
      panel.querySelector('[data-testid="sources"]') as HTMLElement,
    );
    expect(
      sources.getByRole("link", { name: /Copper Notes User Guide · page 8/ }),
    ).toHaveAttribute("href", "/docs/copper-notes-user-guide.pdf#page=8");
  });

  it("shows the pages the search found on the tool card", async () => {
    const search = searchDocuments("C-31 Copper Notes");
    const askCopper = vi.fn().mockResolvedValue(
      answered("Done.", [
        {
          type: "tool",
          id: "c1",
          name: "search_documents",
          state: "done",
          input: { query: "C-31 Copper Notes" },
          output: search,
        },
      ]),
    );
    const { panel } = await openAndAsk(askCopper, "What does C-31 mean?");
    const card = await waitFor(() => {
      const element = panel.querySelector(
        '[data-testid="tool-call"][data-tool="search_documents"]',
      );
      expect(element).not.toBeNull();
      return within(element as HTMLElement);
    });
    expect(card.getByText(/what copper sent/i)).toBeVisible();
    expect(
      card.getByRole("link", { name: "Copper Notes User Guide · page 8" }),
    ).toHaveAttribute("href", "/docs/copper-notes-user-guide.pdf#page=8");
    expect(card.getByText(/C-31 Storage full/)).toBeInTheDocument();
  });

  it("says when a word is in no document, and shows no sources for 'couldn't find it'", async () => {
    const search = searchDocuments("order pizza Copper Home");
    const askCopper = vi.fn().mockResolvedValue(
      answered(
        "I couldn't find that in the support docs. You can contact the Copper Crew in the Copper app.",
        [
          {
            type: "tool",
            id: "c1",
            name: "search_documents",
            state: "done",
            input: { query: "order pizza Copper Home" },
            output: search,
          },
        ],
      ),
    );
    const { panel, chat } = await openAndAsk(
      askCopper,
      "Can Copper Home order me a pizza?",
    );
    await waitFor(() =>
      expect(
        chat.getByText(/couldn't find that in the support docs/),
      ).toBeInTheDocument(),
    );
    expect(
      chat.getByText(/Not mentioned in any document: pizza/),
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-testid="sources"]')).toBeNull();
  });
});
