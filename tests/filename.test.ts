import { describe, expect, it } from "vitest";
import { artifactFilename, sanitizeTitle } from "../src/pipeline/filename";
import { transcript } from "./helpers";

describe("artifact filename", () => {
  it("derives YYYY-MM-DD-<meeting-title>.html from the meeting end date", () => {
    expect(artifactFilename(transcript())).toBe("2026-09-13-Weekly-Sync.html");
  });

  it("sanitizes filesystem-hostile characters from the title", () => {
    const t = transcript({ title: 'Q3: "Budget" review / planning <urgent>' });
    expect(artifactFilename(t)).toBe("2026-09-13-Q3-Budget-review-planning-urgent.html");
  });

  it("falls back to the platform name when the title is empty or all-junk", () => {
    expect(sanitizeTitle("///:::", "teams")).toBe("teams");
    expect(artifactFilename(transcript({ title: "" }))).toBe("2026-09-13-teams.html");
  });

  it("suffixes same-day collisions numerically", () => {
    const existing = new Set(["2026-09-13-Weekly-Sync.html", "2026-09-13-Weekly-Sync-2.html"]);
    expect(artifactFilename(transcript(), existing)).toBe("2026-09-13-Weekly-Sync-3.html");
  });

  it("truncates very long titles", () => {
    const t = transcript({ title: "x".repeat(300) });
    const name = artifactFilename(t);
    expect(name.length).toBeLessThan(120);
  });
});
