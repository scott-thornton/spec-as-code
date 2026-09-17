import { describe, expect, it } from "vitest";
import { error, formatDiagnostic } from "./diagnostics.js";

describe("diagnostics rendering", () => {
  it("renders code, severity, location, message and source excerpt", () => {
    const source = "requirements:\n  - id: AUTH-004\n    dependsOn:\n      - AUTH-009\n";
    const d = error(
      "SPC1002",
      "Property AUTH-004 references unknown dependency AUTH-009.",
      { file: "specs/auth.yaml", line: 4, column: 11 },
    );
    const text = formatDiagnostic(d, new Map([["specs/auth.yaml", source]]));
    expect(text).toContain("error SPC1002 specs/auth.yaml:4:11");
    expect(text).toContain("references unknown dependency AUTH-009");
    expect(text).toContain("4 |       - AUTH-009");
    expect(text).toContain("^");
  });

  it("renders without location or source", () => {
    const text = formatDiagnostic(error("SPC2001", "duplicate task id T001."));
    expect(text).toBe("error SPC2001\n\nduplicate task id T001.");
  });

  it("renders related ids", () => {
    const text = formatDiagnostic(error("SPC2002", "unknown task dependency.", undefined, ["T001", "T002"]));
    expect(text).toContain("Related:");
    expect(text).toContain("T001");
  });
});
