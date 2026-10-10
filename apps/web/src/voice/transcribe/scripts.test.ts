// @vitest-environment node
/**
 * The scripts the timing panel shows (#29 AC6) are spike S-3's, word for word: a run's transcript is
 * checked against its script's last words. Compared with the spike's source text, whose strings are
 * split over `+` lines.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SCRIPTS } from "./scripts";

const SPIKE = new URL("../../../../../spikes/s3-transcribe-browser/src/scripts.ts", import.meta.url);

/** The spike's SCRIPTS object, with its `" " +` line joins removed and each key on its text's line. */
function spikeScripts(): string {
  const source = readFileSync(SPIKE, "utf8");
  return source.replace(/"\s*\+\s*"/g, "").replace(/":\s+"/g, '": "');
}

describe("SCRIPTS", () => {
  it.each(Object.entries(SCRIPTS))("%s matches spike S-3's script under the same clip", (clip, text) => {
    expect(spikeScripts()).toContain(`"${clip}": ${JSON.stringify(text)}`);
  });
});
