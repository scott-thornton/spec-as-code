import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeProvider } from "./fake.js";
import { parseFakeScript } from "./script.js";

const scriptYaml = `
planner:
  value:
    greeting: hello
executor:
  T001:
    status: completed
  T002:
    status: completed
  "T002@1":
    status: failed
    failure:
      code: TEST
      message: first attempt fails
replanner:
  T002:
    reason: moved
verifier:
  "AUTH-001:AUTH-001-A":
    outcome: supports
`;

const schema = z.strictObject({ greeting: z.string() });

describe("fake provider", () => {
  it("returns scripted planner values validated against the schema", async () => {
    const p = new FakeProvider(parseFakeScript(scriptYaml));
    const r = await p.generateStructured({
      role: "planner",
      requestId: "r1",
      system: "s",
      prompt: "p",
      schema,
      schemaName: "test",
    });
    expect(r.value.greeting).toBe("hello");
    expect(r.usage.model).toBe("fake-scripted");
  });

  it("routes executor keys with attempt fallback", async () => {
    const p = new FakeProvider(parseFakeScript(scriptYaml));
    const resultSchema = z.strictObject({ status: z.string(), failure: z.unknown().optional() });
    const first = await p.generateStructured({
      role: "executor",
      key: "T002@1",
      requestId: "r",
      system: "s",
      prompt: "p",
      schema: resultSchema,
      schemaName: "x",
    });
    expect(first.value.status).toBe("failed");
    const second = await p.generateStructured({
      role: "executor",
      key: "T002@2",
      requestId: "r",
      system: "s",
      prompt: "p",
      schema: resultSchema,
      schemaName: "x",
    });
    expect(second.value.status).toBe("completed");
  });

  it("throws typed errors for missing script entries", async () => {
    const p = new FakeProvider(parseFakeScript(scriptYaml));
    await expect(
      p.generateStructured({
        role: "executor",
        key: "T999",
        requestId: "r",
        system: "s",
        prompt: "p",
        schema: z.unknown(),
        schemaName: "x",
      }),
    ).rejects.toThrow(/no scripted response/);
  });

  it("rejects scripts whose values drift from the request schema", async () => {
    const p = new FakeProvider(parseFakeScript(scriptYaml));
    const differentSchema = z.strictObject({ totally: z.number() });
    await expect(
      p.generateStructured({
        role: "planner",
        requestId: "r",
        system: "s",
        prompt: "p",
        schema: differentSchema,
        schemaName: "x",
      }),
    ).rejects.toThrow(/failed schema validation/);
  });

  it("rejects invalid script YAML and structure", () => {
    expect(() => parseFakeScript("key: [unclosed")).toThrow();
    expect(() => parseFakeScript("planner: 42")).toThrow();
  });
});
