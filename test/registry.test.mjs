import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));

test("server.json for the MCP registry matches package.json", () => {
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].registryType, "npm");
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(server.repository.url, pkg.repository.url.replace(/\.git$/, ""));
});

test("server.json stays within the registry schema limits", () => {
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(server.description.length <= 100, `description is ${server.description.length} characters`);
  assert.ok(server.title.length <= 100, `title is ${server.title.length} characters`);
  assert.deepEqual(
    server.packages[0].environmentVariables.map((variable) => variable.name),
    ["ENRICHLAYER_API_KEY"],
  );
});

test("npx starts the stdio server by the package name", () => {
  const command = pkg.name.replace(/^@[^/]+\//, "");
  assert.ok(pkg.bin[command], `package.json has no "${command}" bin for npx -y ${pkg.name}`);
  assert.equal(pkg.bin[command], pkg.bin["enrichlayer-mcp-v3"]);
});
