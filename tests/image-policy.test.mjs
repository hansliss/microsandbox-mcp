import assert from "node:assert/strict";
import test from "node:test";
import { Sandbox } from "microsandbox";
import { getServerConfig, resetServerConfigForTests } from "../dist/config.js";
import { registerSandboxTools } from "../dist/tools/sandbox.js";

function setup(t, allowed, defaultImage) {
  for (const [key, value] of Object.entries({
    MICROSANDBOX_MCP_ALLOWED_IMAGES: allowed,
    MICROSANDBOX_MCP_DEFAULT_IMAGE: defaultImage,
  })) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      resetServerConfigForTests();
    });
  }
  resetServerConfigForTests();
  const calls = [];
  const image = { oci(reference) { calls.push(["oci", reference]); return image; } };
  const builder = new Proxy({}, { get: (_, method) => (...args) => {
    if (method === "imageWith") args[0](image);
    if (method === "image") calls.push(["image", args[0]]);
    if (method === "create") {
      calls.push(["create"]);
      throw new Error("test reached native creation boundary");
    }
    return builder;
  } });
  t.mock.method(Sandbox, "builder", () => builder);
  const handlers = new Map();
  registerSandboxTools({ registerTool(name, _, handler) { handlers.set(name, handler); } });
  return { calls, async invoke(tool, args) {
    return JSON.parse((await handlers.get(tool)({ name: "test", command: "true", ...args })).content[0].text);
  } };
}

test("image allowlist trims entries and requires exact references on both creation tools", async (t) => {
  const { calls, invoke } = setup(t, " alpine:3.19, python:3.12 ,alpine:3.19 ");
  assert.deepEqual(getServerConfig().allowedImages, ["alpine:3.19", "python:3.12"]);
  for (const tool of ["sandbox_create", "sandbox_run"]) {
    for (const args of [
      { image: "alpine" }, { image: "alpine:latest" }, { image: "evil/alpine:3.19" },
      { rootfs: { kind: "oci", reference: "evil/image" } },
      { rootfs: { kind: "bind", path: "/tmp" } },
      { rootfs: { kind: "disk", path: "/tmp/disk" } },
      { image: "alpine:3.19", rootfs: { kind: "bind", path: "/tmp" } },
    ]) {
      calls.length = 0;
      assert.equal((await invoke(tool, args)).error.code, "image_denied");
      assert.deepEqual(calls, []);
    }
    for (const args of [{ image: "alpine:3.19" }, { rootfs: { kind: "oci", reference: "python:3.12" } }]) {
      calls.length = 0;
      await invoke(tool, args);
      assert.equal(calls[0][0], "oci");
      assert.deepEqual(calls.at(-1), ["create"]);
    }
  }
});

test("default applies only when image and rootfs are omitted", async (t) => {
  const { calls, invoke } = setup(t, "alpine:3.19,python:3.12", " alpine:3.19 ");
  for (const tool of ["sandbox_create", "sandbox_run"]) {
    for (const [args, expected] of [
      [{}, "alpine:3.19"], [{ image: "python:3.12" }, "python:3.12"],
      [{ rootfs: { kind: "oci", reference: "python:3.12" } }, "python:3.12"],
    ]) {
      calls.length = 0;
      await invoke(tool, args);
      assert.deepEqual(calls[0], ["oci", expected]);
      assert.deepEqual(calls.at(-1), ["create"]);
    }
  }
});

test("unset allowlist preserves explicit image behavior and still requires an image without a default", async (t) => {
  const { calls, invoke } = setup(t);
  await invoke("sandbox_create", { image: "any/image:tag" });
  assert.deepEqual(calls[0], ["image", "any/image:tag"]);
  calls.length = 0;
  assert.match((await invoke("sandbox_run", {})).error.message, /requires rootfs or image/);
  assert.deepEqual(calls, []);
});

test("default alone uses OCI without restricting explicit choices", async (t) => {
  const { calls, invoke } = setup(t, undefined, "alpine:3.19");
  await invoke("sandbox_run", {});
  assert.deepEqual(calls[0], ["oci", "alpine:3.19"]);
  calls.length = 0;
  await invoke("sandbox_run", { image: "other/image" });
  assert.deepEqual(calls[0], ["image", "other/image"]);
});

test("an explicitly empty allowlist denies every image", async (t) => {
  const { calls, invoke } = setup(t, " , ");
  assert.equal((await invoke("sandbox_run", { image: "alpine:3.19" })).error.code, "image_denied");
  assert.deepEqual(calls, []);
});

test("configuration rejects a default outside the allowlist", (t) => {
  setup(t, "alpine:3.19", "python:3.12");
  assert.throws(getServerConfig, /DEFAULT_IMAGE must be in/);
});
