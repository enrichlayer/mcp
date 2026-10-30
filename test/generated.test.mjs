import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderParams } from "../scripts/params-source.mjs";
import { GENERATED_PATH, readSpec } from "../scripts/spec-files.mjs";

test("src/generated/v3-params.ts is generated from the current spec/v3-openapi.json", async () => {
  const committed = await readFile(GENERATED_PATH, "utf8");
  assert.equal(committed, renderParams(await readSpec()), "run `npm run gen:params` and commit the result");
});
