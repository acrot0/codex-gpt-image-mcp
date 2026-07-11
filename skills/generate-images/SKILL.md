---
name: generate-images
description: Generate or edit raster images through the GPT Image MCP server and the user's configured OpenAI-compatible Images or Responses API. Use for image creation, reference-guided edits, masks, sprites, visual assets, and API-backed image batches when Codex's built-in image generation is unavailable or the user wants their own API billing.
---

# Generate Images

Use the `gpt-image` MCP tools. Do not ask for or pass an API key in a prompt or tool argument.

1. Call `image_service_status` when configuration is uncertain. If the key is missing, tell the user to run the plugin's `scripts/configure.ps1` locally and restart Codex. The default `auto` API mode uses the Images API first and falls back to the Responses image-generation tool when the provider does not expose `/images/*` routes.
2. Call `generate_image` for new images. Keep `include_preview: true` for interactive single-image work. Set it to `false` for automated rows or large batches, then inspect selected output paths with the image viewer.
3. Call `edit_image` for local reference images. Pass absolute paths and state invariants explicitly in the prompt.
4. Treat returned absolute paths as authoritative originals. Move or copy project-bound assets into the project before finishing.
5. Keep `output_dir` under the user's home directory unless `GPT_IMAGE_ALLOWED_ROOTS` explicitly permits another root.

Do not silently fall back to another image provider. If the MCP server is unavailable, report that the plugin must be enabled and Codex restarted.
