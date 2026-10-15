import assert from "node:assert/strict";
import test from "node:test";
import { Sandbox } from "microsandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetServerConfigForTests } from "../dist/config.js";
import { registerFilesystemTools } from "../dist/tools/filesystem.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=", "base64");

function setup(t, data = png, options = {}) {
  const oldLimit = process.env.MICROSANDBOX_MCP_MAX_OUTPUT_BYTES;
  process.env.MICROSANDBOX_MCP_MAX_OUTPUT_BYTES = String(options.cap ?? 1024);
  resetServerConfigForTests();
  t.after(() => {
    if (oldLimit === undefined) delete process.env.MICROSANDBOX_MCP_MAX_OUTPUT_BYTES;
    else process.env.MICROSANDBOX_MCP_MAX_OUTPUT_BYTES = oldLimit;
    resetServerConfigForTests();
  });
  const calls = [];
  const fs = {
    async stat(path) {
      calls.push(["stat", path]);
      if (options.statError) throw new Error("file not found");
      return { kind: options.kind ?? "file", size: options.statSize ?? data.length };
    },
    async readStream(path) {
      calls.push(["readStream", path]);
      return {
        async *[Symbol.asyncIterator]() {
          if (options.readError) throw new Error("read failed");
          const middle = Math.floor(data.length / 2);
          yield data.subarray(0, middle);
          yield data.subarray(middle);
        },
        async [Symbol.asyncDispose]() { calls.push(["dispose"]); },
      };
    },
  };
  t.mock.method(Sandbox, "get", async (name) => {
    calls.push(["get", name]);
    return { connect: async () => ({ fs: () => fs }) };
  });
  const tools = new Map();
  registerFilesystemTools({ registerTool(name, config, handler) { tools.set(name, { config, handler }); } });
  const tool = tools.get("sandbox_fs_read_image");
  return { calls, tool, read: (args = {}) => tool.handler({ name: "plot", path: "/tmp/chart.txt", ...args }) };
}

test("image tool returns exact PNG bytes as image content, regardless of extension", async (t) => {
  const { read, calls, tool } = setup(t);
  const result = await read();
  assert.deepEqual(result, { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] });
  assert.deepEqual(calls, [["get", "plot"], ["stat", "/tmp/chart.txt"], ["readStream", "/tmp/chart.txt"], ["dispose"]]);
  assert.equal(tool.config.annotations.readOnlyHint, true);
  assert.equal(tool.config.inputSchema.safeParse({ name: "plot", path: "relative.png" }).success, false);
});

test("detects JPEG, GIF, and WebP signatures", async (t) => {
  for (const [mimeType, bytes] of [
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/gif", Buffer.from("GIF87a")],
    ["image/webp", Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary")],
  ]) {
    await t.test(mimeType, async (t) => {
      const { read } = setup(t, bytes);
      assert.deepEqual((await read()).content, [{ type: "image", mimeType, data: bytes.toString("base64") }]);
    });
  }
});

test("rejects text, SVG, empty files, and short signatures without returning images", async (t) => {
  for (const bytes of [Buffer.from("hello"), Buffer.from("<svg></svg>"), Buffer.alloc(0), png.subarray(0, 7)]) {
    await t.test(`length ${bytes.length}`, async (t) => {
      const { read } = setup(t, bytes);
      const result = await read({ path: "/tmp/fake.png" });
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).error.code, "unsupported_image_format");
      assert.ok(result.content.every((entry) => entry.type === "text"));
    });
  }
});

test("server cap accounts for base64 and cannot be increased by caller", async (t) => {
  const { read, calls } = setup(t, png, { cap: 16 });
  const result = await read({ maxBytes: 1000000 });
  assert.equal(JSON.parse(result.content[0].text).error.code, "image_too_large");
  assert.equal(calls.some(([name]) => name === "readStream"), false);
});

test("caller can lower limit; exact-size images are accepted", async (t) => {
  const { read } = setup(t);
  assert.equal((await read({ maxBytes: png.length })).content[0].type, "image");
  assert.equal(JSON.parse((await read({ maxBytes: png.length - 1 })).content[0].text).error.code, "image_too_large");
});

test("growing files are bounded during streaming and stream is disposed", async (t) => {
  const { read, calls } = setup(t, png, { statSize: 1 });
  const result = await read({ maxBytes: png.length - 1 });
  assert.equal(JSON.parse(result.content[0].text).error.code, "image_too_large");
  assert.deepEqual(calls.at(-1), ["dispose"]);
});

test("non-files and filesystem failures return tool errors", async (t) => {
  for (const options of [{ kind: "directory" }, { statError: true }, { readError: true }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const { read, calls } = setup(t, png, options);
      assert.equal((await read()).isError, true);
      if (options.readError) assert.deepEqual(calls.at(-1), ["dispose"]);
    });
  }
});

test("actual MCP client receives an image block through the server transport", async (t) => {
  setup(t);
  const server = new McpServer({ name: "image-test", version: "1" });
  registerFilesystemTools(server);
  const client = new Client({ name: "image-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "sandbox_fs_read_image", arguments: { name: "plot", path: "/tmp/graph.png" } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
});
