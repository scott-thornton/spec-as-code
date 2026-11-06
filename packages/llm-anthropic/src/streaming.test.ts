import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicCompatProvider } from "./anthropic.js";
import { LLM_EMPTY_COMPLETION, LLM_PROVIDER_FAILURE, LLM_TIMEOUT, LLM_TRUNCATED_OUTPUT } from "@spc/llm";

/** The stream-death code this spec introduces (imported post-implementation; a literal now so the red legs fail per-test, not at module load). */
const LLM_STREAM_ABORTED = "LLM_STREAM_ABORTED";

// Oracle for specs/adapter-streaming.yaml (ST-001..ST-004, red,
// committed pre-run): streaming transport for the anthropic-compatible
// adapter - SSE reassembly into the same structured contract, stall
// (not total-wall) timeout, mid-stream death discards named. Today the
// adapter has no streaming path: the stream option is ignored, the SSE
// body fails json() parsing, and every leg below fails.
const schema = z.strictObject({ answer: z.string() });

interface SSEEvent {
  event: string;
  data: unknown;
}

/** Encode events as an SSE body stream (chunk per event). */
function sseBody(events: SSEEvent[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= events.length) {
        controller.close();
        return;
      }
      const e = events[i++]!;
      controller.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
    },
  });
}

function sseResponse(events: SSEEvent[]): Response {
  return new Response(sseBody(events), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const TEXT = JSON.stringify({ answer: "streamed" });

function happyEvents(): SSEEvent[] {
  return [
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 100 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TEXT.slice(0, 12) } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TEXT.slice(12) } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function capture(responses: Response[]): { impl: (u: string, i: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    impl: (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Promise.resolve(responses[calls.length - 1]!);
    },
  };
}

function streamProvider(responses: Response[], timeoutMs = 60_000): { p: AnthropicCompatProvider; calls: Captured[] } {
  const c = capture(responses);
  const p = new AnthropicCompatProvider({ model: "glm-5.3", apiKey: "k", stream: true, timeoutMs, fetchImpl: c.impl });
  return { p, calls: c.calls };
}

const req = () => ({ role: "executor" as const, requestId: "r", system: "s", prompt: "p", schema, schemaName: "A" });

async function errOf(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message };
  }
  return { code: "NO_THROW", message: "" };
}

describe("ST-001: streaming mode reassembles the same contract, opt-in only", () => {
  it("SSE events reassemble to the same value and usage as the equivalent JSON response; stream:true rides the body only under the opt-in", async () => {
    const nonStreamJson = {
      content: [{ type: "text", text: TEXT }],
      usage: { input_tokens: 100, output_tokens: 42 },
      stop_reason: "end_turn",
    };
    const plain = capture([jsonResponse(nonStreamJson)]);
    const plainP = new AnthropicCompatProvider({ model: "m", apiKey: "k", fetchImpl: plain.impl });
    const plainRes = await plainP.generateStructured(req());

    const { p, calls } = streamProvider([sseResponse(happyEvents())]);
    const res = await p.generateStructured(req());

    expect(res.value).toEqual(plainRes.value);
    expect(res.usage.inputTokens).toBe(100);
    expect(res.usage.outputTokens).toBe(42);
    expect(res.usage.model).toBe("glm-5.3");
    // Opt-in shape: stream:true present when configured, absent otherwise.
    expect(calls[0]!.body["stream"]).toBe(true);
    expect(plain.calls[0]!.body["stream"]).toBeUndefined();
  });
});

describe("ST-002: stall timeout, not total wall", () => {
  it("a stream that delivers one event then never resolves aborts with a stall-named LLM_TIMEOUT within the bound", { timeout: 10_000 }, async () => {
    // One event, then the stream never enqueues again and never closes.
    const enc = new TextEncoder();
    let pulled = false;
    const stalled = new ReadableStream({
      pull(controller) {
        if (pulled) return; // stall: no further chunks, no close
        pulled = true;
        controller.enqueue(enc.encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`));
      },
    });
    const t0 = Date.now();
    const { p } = streamProvider([new Response(stalled, { status: 200, headers: { "content-type": "text/event-stream" } })], 300);
    const e = await errOf(() => p.generateStructured(req()));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(e.code).toBe(LLM_TIMEOUT);
    expect(e.message).toMatch(/stall|last chunk/i);
  });
});

describe("ST-003: mid-stream death discards, never parses", () => {
  it("transport death after several deltas throws LLM_STREAM_ABORTED with diagnostics and no value", { timeout: 10_000 }, async () => {
    const enc = new TextEncoder();
    const dying = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`));
        controller.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"answer":"par' } })}\n\n`));
        controller.error(new Error("connection reset"));
      },
    });
    const { p } = streamProvider([new Response(dying, { status: 200, headers: { "content-type": "text/event-stream" } })], 60_000);
    const e = await errOf(() => p.generateStructured(req()));
    expect(e.code).toBe(LLM_STREAM_ABORTED);
    expect(e.message).toMatch(/chunk/i);
  });

  it("an in-stream error event surfaces as LLM_PROVIDER_FAILURE with the payload", async () => {
    const events = [
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } },
      { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
    ];
    const { p } = streamProvider([sseResponse(events)]);
    const e = await errOf(() => p.generateStructured(req()));
    expect(e.code).toBe(LLM_PROVIDER_FAILURE);
    expect(e.message).toMatch(/Overloaded/);
  });
});

describe("ST-004: failure parity across the transport", () => {
  it("stop_reason max_tokens maps to LLM_TRUNCATED_OUTPUT with the same remediation shape", async () => {
    const events = [
      ...happyEvents().slice(0, 5),
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 42 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ];
    const { p } = streamProvider([sseResponse(events)]);
    const e = await errOf(() => p.generateStructured(req()));
    expect(e.code).toBe(LLM_TRUNCATED_OUTPUT);
    expect(e.message).toMatch(/max_tokens/);
  });

  it("a thinking-only stream maps to LLM_EMPTY_COMPLETION with the same diagnostics", async () => {
    const events = [
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ];
    const { p } = streamProvider([sseResponse(events)]);
    const e = await errOf(() => p.generateStructured(req()));
    expect(e.code).toBe(LLM_EMPTY_COMPLETION);
    expect(e.message).toMatch(/stop_reason: end_turn/);
  });
});
