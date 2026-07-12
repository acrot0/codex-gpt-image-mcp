import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "index.mjs");
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image-mcp-test-"));
const inputPath = path.join(outputDir, "input.png");
const image = await sharp({
  create: { width: 8, height: 8, channels: 4, background: "#4a90e2" },
}).png().toBuffer();
await fs.writeFile(inputPath, image);

const requests = [];
const mockApi = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, url: request.url, body });
    if (request.url.startsWith("/fallback/v1/images/")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "route not found" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url.endsWith("/v1/responses")) {
      response.end(JSON.stringify({
        id: `resp_${requests.length}`,
        object: "response",
        status: "completed",
        output: [{
          type: "image_generation_call",
          id: `ig_${requests.length}`,
          status: "completed",
          result: image.toString("base64"),
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    response.end(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }));
  });
});

await new Promise((resolve, reject) => {
  mockApi.once("error", reject);
  mockApi.listen(0, "127.0.0.1", resolve);
});

const address = mockApi.address();
const baseURL = `http://127.0.0.1:${address.port}/v1`;
const fallbackBaseURL = `http://127.0.0.1:${address.port}/fallback/v1`;

async function runMode(mode, apiBaseURL = baseURL) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      GPT_IMAGE_API_KEY: "test-key",
      GPT_IMAGE_BASE_URL: apiBaseURL,
      GPT_IMAGE_MODEL: "gpt-image-2-test",
      GPT_IMAGE_RESPONSES_MODEL: "gpt-5.6-test",
      GPT_IMAGE_API_MODE: mode,
      GPT_IMAGE_OUTPUT_DIR: outputDir,
    },
  });
  const client = new Client({ name: `gpt-image-mcp-${mode}-test`, version: "0.1.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const expected = ["image_service_status", "generate_image", "edit_image"];
    const actual = listed.tools.map((tool) => tool.name);
    if (!expected.every((name) => actual.includes(name))) {
      throw new Error(`Missing tools: ${expected.filter((name) => !actual.includes(name)).join(", ")}`);
    }

    const status = await client.callTool({ name: "image_service_status", arguments: {} });
    if (status.isError || status.structuredContent?.api_mode !== mode) {
      throw new Error(`Status tool did not report ${mode} mode.`);
    }

    const generated = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "test image", output_name: `${mode}-generated`, include_preview: true },
    });
    const edited = await client.callTool({
      name: "edit_image",
      arguments: { prompt: "make it blue", input_paths: [inputPath], output_name: `${mode}-edited`, include_preview: true },
    });
    if (generated.isError || edited.isError) {
      const messages = [generated, edited].map((result) => result.content?.[0]?.text).join(" | ");
      throw new Error(`${mode} mode failed: ${messages}`);
    }
    if (!generated.content?.some((item) => item.type === "image") || !edited.content?.some((item) => item.type === "image")) {
      throw new Error(`${mode} mode did not return inline previews.`);
    }

    const generatedPath = generated.structuredContent?.files?.[0]?.path;
    const editedPath = edited.structuredContent?.files?.[0]?.path;
    await Promise.all([fs.access(generatedPath), fs.access(editedPath)]);
    return actual;
  } finally {
    await client.close().catch(() => {});
  }
}

try {
  const tools = await runMode("images");
  await runMode("responses");
  await runMode("auto", fallbackBaseURL);

  const calledPaths = requests.map((request) => request.url);
  for (const expectedPath of [
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/responses",
    "/fallback/v1/images/generations",
    "/fallback/v1/images/edits",
    "/fallback/v1/responses",
  ]) {
    if (!calledPaths.includes(expectedPath)) throw new Error(`API route was not called: ${expectedPath}`);
  }
  const responseBodies = requests
    .filter((request) => request.url.endsWith("/v1/responses"))
    .map((request) => JSON.parse(request.body.toString("utf8")));
  if (!responseBodies.some((body) => body.tools?.[0]?.action === "generate")) {
    throw new Error("Responses generation request was not sent.");
  }
  if (!responseBodies.some((body) => body.tools?.[0]?.action === "edit" && body.input?.[0]?.content?.some((item) => item.type === "input_image"))) {
    throw new Error("Responses edit request did not include the input image.");
  }
  if (!responseBodies.some((body) => body.input?.[0]?.content?.some((item) => item.type === "input_image" && item.image_url.startsWith("data:image/png;base64,")))) {
    throw new Error("Responses edit request did not preserve the PNG MIME type.");
  }
  if (!requests.some((request) => request.url.endsWith("/v1/images/edits") && request.body.includes(Buffer.from("Content-Type: image/png")))) {
    throw new Error("Images edit request did not preserve the PNG MIME type.");
  }

  process.stdout.write(`${JSON.stringify({ ok: true, tools, routes: calledPaths })}\n`);
} finally {
  await new Promise((resolve) => mockApi.close(resolve));
  await fs.rm(outputDir, { recursive: true, force: true });
}
