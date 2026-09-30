import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("package manifest", () => {
  it.each(["@sinclair/typebox", "typebox"])(
    "uses the host-provided %s runtime",
    (name) => {
      expect(manifest.dependencies).not.toHaveProperty(name);
      expect(manifest.peerDependencies[name]).toBe("*");
      expect(manifest.devDependencies[name]).toBeDefined();
    },
  );
});
