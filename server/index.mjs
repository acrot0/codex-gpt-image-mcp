import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";

const SERVER_NAME = "gpt-image";
const SERVER_VERSION = "0.1.0";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_RESPONSES_MODEL = "gpt-5.6";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MIME_TYPES = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const generateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", minLength: 1, description: "Image generation prompt." },
    model: { type: "string", description: "Optional model override. Defaults to GPT_IMAGE_MODEL or gpt-image-2." },
    responses_model: { type: "string", description: "Optional mainline model override when using the Responses API backend." },
    size: { type: "string", default: "1024x1024", description: "Canvas size such as 1024x1024, 1536x1024, 2048x2048, or auto." },
    quality: { type: "string", enum: ["auto", "low", "medium", "high"], default: "auto" },
    output_format: { type: "string", enum: ["png", "jpeg", "webp"], default: "png" },
    output_compression: { type: "integer", minimum: 0, maximum: 100 },
    background: { type: "string", enum: ["auto", "opaque", "transparent"], default: "auto" },
    moderation: { type: "string", enum: ["auto", "low"], default: "auto" },
    count: { type: "integer", minimum: 1, maximum: 10, default: 1 },
    output_dir: { type: "string", description: "Optional absolute destination directory under an allowed root." },
    output_name: { type: "string", description: "Optional filename stem; an index is appended for batches." },
    include_preview: { type: "boolean", default: true, description: "Return lightweight inline JPEG previews in addition to original file paths." },
    preview_count: { type: "integer", minimum: 0, maximum: 4, default: 1 },
  },
};

const editSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "input_paths"],
  properties: {
    prompt: { type: "string", minLength: 1, description: "Edit instruction with invariants stated explicitly." },
    input_paths: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" }, description: "Absolute local paths to reference or edit images." },
    mask_path: { type: "string", description: "Optional absolute PNG mask path." },
    model: { type: "string", description: "Optional model override." },
    responses_model: { type: "string", description: "Optional mainline model override when using the Responses API backend." },
    size: { type: "string", default: "auto" },
    quality: { type: "string", enum: ["auto", "low", "medium", "high"], default: "auto" },
    count: { type: "integer", minimum: 1, maximum: 10, default: 1 },
    output_dir: { type: "string", description: "Optional absolute destination directory under an allowed root." },
    output_name: { type: "string", description: "Optional filename stem; edit outputs are PNG." },
    include_preview: { type: "boolean", default: true },
    preview_count: { type: "integer", minimum: 0, maximum: 4, default: 1 },
  },
};

const tools = [
  {
    name: "image_service_status",
    title: "Image service status",
    description: "Check whether the API key, base URL, model, output directory, and timeout are configured. Never returns the API key.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "generate_image",
    title: "Generate image",
    description: "Generate one or more images with the configured OpenAI-compatible Images or Responses API. Saves originals locally and can return lightweight inline previews.",
    inputSchema: generateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "edit_image",
    title: "Edit image",
    description: "Edit local images with the configured OpenAI-compatible Images or Responses API. Supports multiple references and an optional mask; saves PNG originals locally.",
    inputSchema: editSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

function config() {
  const pluginData = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const fallbackOutput = pluginData
    ? path.join(pluginData, "generated-images")
    : path.join(os.homedir(), ".codex", "generated_images", "gpt-image-mcp");
  const timeoutValue = Number.parseInt(process.env.GPT_IMAGE_TIMEOUT_MS || "", 10);
  const outputDir = path.resolve(process.env.GPT_IMAGE_OUTPUT_DIR || fallbackOutput);
  const extraRoots = (process.env.GPT_IMAGE_ALLOWED_ROOTS || "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));

  return {
    apiKey: process.env.GPT_IMAGE_API_KEY || process.env.OPENAI_API_KEY || "",
    baseURL: (process.env.GPT_IMAGE_BASE_URL || process.env.OPENAI_API_BASE_URL || "").replace(/\/$/, ""),
    model: process.env.GPT_IMAGE_MODEL || DEFAULT_MODEL,
    responsesModel: process.env.GPT_IMAGE_RESPONSES_MODEL || DEFAULT_RESPONSES_MODEL,
    apiMode: oneOf(process.env.GPT_IMAGE_API_MODE, "auto", ["auto", "images", "responses"], "GPT_IMAGE_API_MODE"),
    userAgent: process.env.GPT_IMAGE_USER_AGENT || "",
    outputDir,
    timeoutMs: Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : DEFAULT_TIMEOUT_MS,
    allowedRoots: [...new Set([path.resolve(os.homedir()), outputDir, ...extraRoots])],
  };
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertAllowedPath(rawPath, roots, label) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error(`${label} must be a non-empty path.`);
  }
  const resolved = path.resolve(rawPath);
  if (!roots.some((root) => isWithin(resolved, root))) {
    throw new Error(`${label} is outside the configured allowed roots.`);
  }
  return resolved;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function integer(value, fallback, min, max, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function oneOf(value, fallback, allowed, label) {
  const selected = value ?? fallback;
  if (!allowed.includes(selected)) throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  return selected;
}

function validateSize(value, fallback = "auto") {
  const selected = value ?? fallback;
  if (selected === "auto") return selected;
  const match = /^(\d+)x(\d+)$/.exec(selected);
  if (!match) throw new Error("size must be auto or WIDTHxHEIGHT.");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0 || width > 3840 || height > 3840) {
    throw new Error("size edges must be between 1 and 3840 pixels.");
  }
  return selected;
}

function sanitizeStem(value, fallback) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const stem = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return stem || fallback;
}

function client(current) {
  if (!current.apiKey) {
    throw new Error("GPT_IMAGE_API_KEY is not configured. Run the plugin configure.ps1 script locally, then restart Codex.");
  }
  const defaultHeaders = current.userAgent
    ? { "user-agent": current.userAgent, originator: "codex_cli_rs" }
    : undefined;
  return new OpenAI({
    apiKey: current.apiKey,
    baseURL: current.baseURL || undefined,
    timeout: current.timeoutMs,
    maxRetries: 2,
    defaultHeaders,
  });
}

function requestedModel(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function shouldFallbackToResponses(error, current) {
  return current.apiMode === "auto" && [404, 405, 501].includes(error?.status);
}

function responsesImageData(response) {
  const data = (response?.output || [])
    .filter((item) => item?.type === "image_generation_call" && item.result)
    .map((item) => ({ b64_json: item.result }));
  if (data.length) return data;
  const message = response?.output_text?.trim();
  throw new Error(message || "The Responses API returned no generated image.");
}

function responsesTool(options) {
  const tool = {
    type: "image_generation",
    action: options.action,
    model: options.model,
    size: options.size,
    quality: options.quality,
    output_format: options.outputFormat,
    background: options.background,
    moderation: options.moderation,
  };
  if (options.outputCompression !== undefined) tool.output_compression = options.outputCompression;
  if (options.mask) tool.input_image_mask = { image_url: options.mask.dataURL };
  return tool;
}

async function generateWithResponses(api, current, options) {
  const responses = [];
  const data = [];
  for (let index = 0; index < options.count; index += 1) {
    const response = await api.responses.create({
      model: options.responsesModel,
      input: options.prompt,
      tools: [responsesTool({ ...options, action: "generate" })],
      store: false,
    });
    responses.push(response);
    data.push(...responsesImageData(response));
  }
  return {
    data,
    usage: responses.map((response) => response.usage || null),
    response_ids: responses.map((response) => response.id),
  };
}

async function imageBuffer(item) {
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("The image API returned neither b64_json nor a URL.");
}

async function saveResults(data, options) {
  const current = config();
  const outputDir = options.outputDir
    ? assertAllowedPath(options.outputDir, current.allowedRoots, "output_dir")
    : current.outputDir;
  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = sanitizeStem(options.outputName, `gpt-image-${timestamp}`);
  const results = [];

  for (let index = 0; index < data.length; index += 1) {
    const buffer = await imageBuffer(data[index]);
    const filename = `${stem}${data.length > 1 ? `-${index + 1}` : ""}.${options.format}`;
    const filePath = path.join(outputDir, filename);
    await fs.writeFile(filePath, buffer, { flag: "wx" }).catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
      const alternate = path.join(outputDir, `${stem}-${Date.now()}-${index + 1}.${options.format}`);
      await fs.writeFile(alternate, buffer, { flag: "wx" });
      results.push({ filePath: alternate, buffer, revisedPrompt: data[index]?.revised_prompt });
    });
    if (!results[index]) results.push({ filePath, buffer, revisedPrompt: data[index]?.revised_prompt });
  }
  return results;
}

async function previewContent(results, count) {
  const blocks = [];
  for (const result of results.slice(0, count)) {
    const preview = await sharp(result.buffer)
      .rotate()
      .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    blocks.push({ type: "image", data: preview.toString("base64"), mimeType: "image/jpeg" });
  }
  return blocks;
}

function redactError(error, current) {
  let message = error instanceof Error ? error.message : String(error);
  if (current.apiKey) message = message.split(current.apiKey).join("<redacted>");
  message = message.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer <redacted>");
  return message.slice(0, 2000);
}

function resultPayload(kind, results, response, previews) {
  const files = results.map((item) => ({
    path: item.filePath,
    uri: pathToFileURL(item.filePath).href,
    revised_prompt: item.revisedPrompt || null,
  }));
  const structuredContent = { ok: true, kind, files, usage: response?.usage || null };
  return {
    content: [
      { type: "text", text: JSON.stringify(structuredContent) },
      ...previews,
    ],
    structuredContent,
  };
}

async function handleStatus() {
  const current = config();
  const status = {
    ok: Boolean(current.apiKey),
    api_key_configured: Boolean(current.apiKey),
    base_url: current.baseURL || "OpenAI default",
    model: current.model,
    responses_model: current.responsesModel,
    api_mode: current.apiMode,
    user_agent: current.userAgent || "OpenAI SDK default",
    output_dir: current.outputDir,
    timeout_ms: current.timeoutMs,
  };
  return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status };
}

async function handleGenerate(args = {}) {
  const current = config();
  try {
    const prompt = requiredString(args.prompt, "prompt");
    const count = integer(args.count, 1, 1, 10, "count");
    const format = oneOf(args.output_format, "png", ["png", "jpeg", "webp"], "output_format");
    const quality = oneOf(args.quality, "auto", ["auto", "low", "medium", "high"], "quality");
    const background = oneOf(args.background, "auto", ["auto", "opaque", "transparent"], "background");
    const moderation = oneOf(args.moderation, "auto", ["auto", "low"], "moderation");
    const previewCount = args.include_preview === false ? 0 : integer(args.preview_count, 1, 0, 4, "preview_count");
    const outputCompression = (format === "jpeg" || format === "webp") && args.output_compression !== undefined
      ? integer(args.output_compression, 100, 0, 100, "output_compression")
      : undefined;
    const params = {
      model: requestedModel(args.model, current.model),
      prompt,
      n: count,
      size: validateSize(args.size, "1024x1024"),
      quality,
      output_format: format,
      background,
      moderation,
    };
    if (outputCompression !== undefined) params.output_compression = outputCompression;
    const api = client(current);
    let response;
    if (current.apiMode === "responses") {
      response = await generateWithResponses(api, current, {
        prompt,
        count,
        model: params.model,
        responsesModel: requestedModel(args.responses_model, current.responsesModel),
        size: params.size,
        quality,
        outputFormat: format,
        outputCompression,
        background,
        moderation,
      });
    } else {
      try {
        response = await api.images.generate(params);
      } catch (error) {
        if (!shouldFallbackToResponses(error, current)) throw error;
        response = await generateWithResponses(api, current, {
          prompt,
          count,
          model: params.model,
          responsesModel: requestedModel(args.responses_model, current.responsesModel),
          size: params.size,
          quality,
          outputFormat: format,
          outputCompression,
          background,
          moderation,
        });
      }
    }
    if (!response?.data?.length) throw new Error("The image API returned no images.");
    const results = await saveResults(response.data, {
      outputDir: args.output_dir,
      outputName: args.output_name,
      format,
    });
    const previews = await previewContent(results, previewCount);
    return resultPayload("generate", results, response, previews);
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: redactError(error, current) }] };
  }
}

async function readInputImage(rawPath, current, label) {
  const filePath = assertAllowedPath(rawPath, current.allowedRoots, label);
  const extension = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`${label} must be PNG, JPEG, WebP, or GIF.`);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`${label} is not a file.`);
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`${label} exceeds 50 MB.`);
  const buffer = await fs.readFile(filePath);
  const metadata = await sharp(buffer, { animated: true }).metadata();
  const mimeType = MIME_TYPES[metadata.format];
  if (!mimeType) throw new Error(`${label} is not a supported image format.`);
  return {
    file: await toFile(buffer, path.basename(filePath), { type: mimeType }),
    dataURL: `data:${mimeType};base64,${buffer.toString("base64")}`,
  };
}

async function editWithResponses(api, current, options) {
  const content = [
    { type: "input_text", text: options.prompt },
    ...options.images.map((image) => ({ type: "input_image", image_url: image.dataURL, detail: "high" })),
  ];
  const responses = [];
  const data = [];
  for (let index = 0; index < options.count; index += 1) {
    const response = await api.responses.create({
      model: options.responsesModel,
      input: [{ role: "user", content }],
      tools: [responsesTool({
        action: "edit",
        model: options.model,
        size: options.size,
        quality: options.quality,
        outputFormat: "png",
        background: "auto",
        moderation: "auto",
        mask: options.mask,
      })],
      store: false,
    });
    responses.push(response);
    data.push(...responsesImageData(response));
  }
  return {
    data,
    usage: responses.map((response) => response.usage || null),
    response_ids: responses.map((response) => response.id),
  };
}

async function handleEdit(args = {}) {
  const current = config();
  try {
    const prompt = requiredString(args.prompt, "prompt");
    if (!Array.isArray(args.input_paths) || args.input_paths.length < 1 || args.input_paths.length > 16) {
      throw new Error("input_paths must contain 1 to 16 image paths.");
    }
    const imageInputs = await Promise.all(
      args.input_paths.map((filePath, index) => readInputImage(filePath, current, `input_paths[${index}]`)),
    );
    const count = integer(args.count, 1, 1, 10, "count");
    const quality = oneOf(args.quality, "auto", ["auto", "low", "medium", "high"], "quality");
    const previewCount = args.include_preview === false ? 0 : integer(args.preview_count, 1, 0, 4, "preview_count");
    const params = {
      model: requestedModel(args.model, current.model),
      prompt,
      image: imageInputs.map((image) => image.file),
      n: count,
      size: validateSize(args.size, "auto") === "auto" ? undefined : args.size,
      quality: quality === "auto" ? undefined : quality,
    };
    const mask = args.mask_path ? await readInputImage(args.mask_path, current, "mask_path") : undefined;
    if (mask) params.mask = mask.file;
    const api = client(current);
    const responseOptions = {
      prompt,
      images: imageInputs,
      mask,
      count,
      model: params.model,
      responsesModel: requestedModel(args.responses_model, current.responsesModel),
      size: args.size ?? "auto",
      quality,
    };
    let response;
    if (current.apiMode === "responses") {
      response = await editWithResponses(api, current, responseOptions);
    } else {
      try {
        response = await api.images.edit(params);
      } catch (error) {
        if (!shouldFallbackToResponses(error, current)) throw error;
        response = await editWithResponses(api, current, responseOptions);
      }
    }
    if (!response?.data?.length) throw new Error("The image API returned no edited images.");
    const results = await saveResults(response.data, {
      outputDir: args.output_dir,
      outputName: args.output_name,
      format: "png",
    });
    const previews = await previewContent(results, previewCount);
    return resultPayload("edit", results, response, previews);
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: redactError(error, current) }] };
  }
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions: "Generate and edit images with the user's configured OpenAI-compatible Images or Responses API. Save originals locally. Use inline previews for interactive work and disable previews for large automated batches. Never request or expose the API key in prompts or tool arguments.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "image_service_status") return handleStatus();
  if (name === "generate_image") return handleGenerate(args);
  if (name === "edit_image") return handleEdit(args);
  return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
