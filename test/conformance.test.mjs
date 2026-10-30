import { test } from "node:test";
import assert from "node:assert/strict";
import { toolDefs } from "../build/tools/definitions.js";
import { readSpec } from "../scripts/spec-files.mjs";
import { connectMcp, testClient } from "./helpers.mjs";

const spec = await readSpec();

function specParams(path) {
  const item = spec.paths[path];
  const params = [...(item.parameters ?? []), ...(item.get?.parameters ?? [])];
  for (const param of params) assert.equal(param.$ref, undefined, `${path}: $ref params are not handled by this check`);
  return params.filter((param) => param.in === "query");
}

function withoutSafeIntegerBound(value) {
  return Math.abs(value) === Number.MAX_SAFE_INTEGER ? undefined : value;
}

test("there is one tool for every path of the v3 spec, and no tool for a path it does not have", () => {
  assert.deepEqual(toolDefs.map((def) => def.path).sort(), Object.keys(spec.paths).sort());
});

test("tool input schemas, as MCP clients get them, match the v3 spec", async (t) => {
  const mcp = await connectMcp(testClient("http://127.0.0.1:1"));
  t.after(mcp.close);
  const { tools } = await mcp.client.listTools();

  for (const def of toolDefs) {
    const tool = tools.find((candidate) => candidate.name === def.name);
    const params = specParams(def.path);
    const properties = tool.inputSchema.properties;

    assert.deepEqual(Object.keys(properties).sort(), params.map((param) => param.name).sort(), `${def.name}: param names`);
    assert.deepEqual(
      [...(tool.inputSchema.required ?? [])].sort(),
      params.filter((param) => param.required).map((param) => param.name).sort(),
      `${def.name}: required params`,
    );
    for (const param of params) {
      const property = properties[param.name];
      assert.equal(property.type, param.schema.type, `${def.name}.${param.name}: type`);
      assert.deepEqual(property.enum, param.schema.enum, `${def.name}.${param.name}: allowed values`);
      assert.equal(withoutSafeIntegerBound(property.minimum), param.schema.minimum, `${def.name}.${param.name}: minimum`);
      assert.equal(withoutSafeIntegerBound(property.maximum), param.schema.maximum, `${def.name}.${param.name}: maximum`);
    }
  }
});
