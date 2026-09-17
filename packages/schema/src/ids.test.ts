import { describe, expect, it } from "vitest";
import {
  digestSchema,
  propertyIdSchema,
  SPEC_ID_PATTERN,
  PROPERTY_ID_PATTERN,
  TASK_ID_PATTERN,
  specIdSchema,
  taskIdSchema,
} from "./ids.js";

describe("identifier patterns", () => {
  it("accepts valid spec ids", () => {
    for (const id of ["auth", "oauth-login", "billing-v2", "a", "a1-b2"]) {
      expect(specIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("rejects invalid spec ids", () => {
    for (const id of ["Auth", "-auth", "auth-", "auth_login", "1auth", ""]) {
      expect(specIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it("accepts valid property ids", () => {
    for (const id of ["AUTH-001", "AUTH-C01", "SECURITY-TOKEN-01", "X-9"]) {
      expect(propertyIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("rejects invalid property ids", () => {
    for (const id of ["AUTH", "AUTH-", "-AUTH-1", "auth-001", "AUTH_1", ""]) {
      expect(propertyIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it("accepts valid task ids", () => {
    for (const id of ["T001", "T999", "T1003", "T000123"]) {
      expect(taskIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("rejects invalid task ids", () => {
    for (const id of ["T01", "t001", "T1", "T00a", "T-01", ""]) {
      expect(taskIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it("validates digest shape", () => {
    const good = `sha256:${"a".repeat(64)}`;
    expect(digestSchema.safeParse(good).success).toBe(true);
    expect(digestSchema.safeParse("a".repeat(64)).success).toBe(false);
    expect(digestSchema.safeParse(`sha256:${"A".repeat(64)}`).success).toBe(false);
    expect(digestSchema.safeParse(`sha256:${"a".repeat(63)}`).success).toBe(false);
  });

  it("raw patterns match documented examples", () => {
    expect(SPEC_ID_PATTERN.test("billing-v2")).toBe(true);
    expect(PROPERTY_ID_PATTERN.test("SECURITY-TOKEN-01")).toBe(true);
    expect(TASK_ID_PATTERN.test("T1003")).toBe(true);
  });
});
