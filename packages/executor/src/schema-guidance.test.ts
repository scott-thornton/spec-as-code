import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executorResultSchema } from "./result.js";

/** The exact conversion the harness request surface performs. */
function requestSchema(): Record<string, unknown> {
  return z.toJSONSchema(executorResultSchema as unknown as z.ZodType<unknown>, {
    io: "output",
  }) as Record<string, unknown>;
}

function opVariants(json: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const changes = (json.properties as Record<string, Record<string, unknown>>).changes as {
    items?: Record<string, unknown>;
  };
  const items = changes.items ?? {};
  const variants = (items.anyOf as Record<string, unknown>[] | undefined) ?? [items as Record<string, unknown>];
  const byOp = new Map<string, Record<string, unknown>>();
  for (const v of variants) {
    const op = v.properties as Record<string, { const?: string; enum?: string[] }> | undefined;
    const literal = op?.op?.const ?? op?.op?.enum?.[0];
    if (literal) byOp.set(literal, v);
  }
  return Object.fromEntries(byOp);
}

describe("change protocol schema carries its own guidance", () => {
  it("describes every change op arm - no bare variants in the schema agents see", () => {
    const variants = opVariants(requestSchema());
    expect(Object.keys(variants).sort()).toEqual(["create", "delete", "patch", "update"]);
    for (const [op, variant] of Object.entries(variants)) {
      expect(typeof variant.description, `op ${op} must carry a description`).toBe("string");
      expect((variant.description as string).length).toBeGreaterThan(10);
    }
  });

  it("patch arm says what it is and where the digest comes from", () => {
    const desc = opVariants(requestSchema()).patch!.description as string;
    expect(desc).toContain("anchored edit");
    expect(desc.toLowerCase()).toContain("excerpt");
    expect(desc).toContain("baseDigest");
  });

  it("update arm redirects edits to the patch op", () => {
    const desc = opVariants(requestSchema()).update!.description as string;
    expect(desc).toContain("wholesale rewrite");
    expect(desc).toContain("prefer the patch");
  });

  it("create and delete arms state their scope", () => {
    const v = opVariants(requestSchema());
    expect(v.create!.description as string).toContain("new file");
    expect(v.delete!.description as string).toContain("emove the file");
  });

  it("commands items carry the touch-set contract", () => {
    const json = requestSchema();
    const commands = (json.properties as Record<string, Record<string, unknown>>).commands as {
      items?: Record<string, unknown>;
    };
    const desc = commands.items?.description as string | undefined;
    expect(typeof desc).toBe("string");
    expect(desc!).toContain("touchSet");
    expect(desc!.toLowerCase()).toContain("fail");
  });
});
