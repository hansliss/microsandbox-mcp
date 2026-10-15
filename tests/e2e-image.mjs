import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Run against an already running server on a KVM-enabled host.
const url = new URL(process.env.MICROSANDBOX_MCP_E2E_URL ?? "http://127.0.0.1:3000/mcp");
const client = new Client({ name: "image-probe", version: "1" });
const name = `mcp-image-probe-${Date.now()}-${process.pid}`;
const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=";
let created = false;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result;
}
try {
  await client.connect(new StreamableHTTPClientTransport(url));
  const runtimeResult = await call("runtime_check", {});
  const runtime = JSON.parse(runtimeResult.content.find((entry) => entry.type === "text").text).data;
  const image = process.env.MICROSANDBOX_MCP_E2E_IMAGE
    || runtime.defaultImage || runtime.allowedImages?.[0] || "alpine:3.19";
  if (Array.isArray(runtime.allowedImages) && !runtime.allowedImages.includes(image)) {
    throw new Error(`Image ${JSON.stringify(image)} is not allowed by the server. Configure an allowed image or set MICROSANDBOX_MCP_E2E_IMAGE to one.`);
  }
  console.log(`Testing with image: ${image}`);
  await call("sandbox_create", {
    name,
    image,
    network: { disabled: true },
  });
  created = true;
  await call("sandbox_fs_write", { name, path: "/tmp/image-probe.png", encoding: "base64", content: data });
  const result = await call("sandbox_fs_read_image", { name, path: "/tmp/image-probe.png" });
  assert.deepEqual(result.content, [{ type: "image", mimeType: "image/png", data }]);
  console.log("PASS: HTTP MCP returned exact PNG bytes as native image content.");
} finally {
  try {
    if (created) {
      await call("sandbox_stop", { name, force: true });
      await call("sandbox_remove", { name, force: true });
    }
  } finally {
    await client.close();
  }
}
