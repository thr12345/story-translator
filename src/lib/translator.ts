/**
 * Core translation library for story-translator.
 *
 * Responsibilities (per SPEC):
 * 1. Accept input in html / markdown / epub.
 * 2. (Optionally) convert referenced images to webp quality 90.
 * 3. Convert input to intermediary Markdown via Pandoc (unless already Markdown).
 * 4. Normalize image references to standard markdown: ![](path/to.webp) (ALT TEXT REMOVED PER LATEST REQUIREMENT)
 * 5. Retrieve OpenRouter API key (arg > env > config file > interactive prompt).
 * 6. Send markdown to OpenRouter for translation with defined prompts.
 * 7. Convert translated markdown to output format (markdown or epub2).
 * 8. Clean up intermediary file (unless keepIntermediate).
 *
 * External tools assumed:
 * - pandoc (must be installed and on PATH)
 * - cwebp (optional; if absent, image conversion is skipped with a warning)
 *
 * NOTE: This is a first-pass implementation skeleton focusing on structure,
 *       logging, and flow. Some heuristics can be refined in subsequent passes.
 *
 * UPDATE: Alt text from HTML images is now stripped so intermediary markdown uses empty alt: ![](...)
 */

import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import consola from "consola";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------- Types -----------

export interface TranslateOptions {
  inputPath: string;
  outputFormat?: "markdown" | "epub";
  targetLanguage: string;
  sourceLanguage?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  convertImagesToWebp?: boolean;
  quality?: number;
  keepIntermediate?: boolean;
  autoName?: boolean;
}

export interface TranslateResult {
  outputPath: string;
  intermediateMarkdownPath: string;
  cleaned: boolean;
  imageMap: Record<string, string>;
}

interface InternalContext {
  workDir: string;
  mediaDir: string;
  intermediateMarkdown: string;
  inputFormat: InputFormat;
  originalCwd: string;
}

type InputFormat = "markdown" | "html" | "epub" | "unknown";

// ----------- Constants -----------

const DEFAULT_MODEL = "deepseek/deepseek-chat-v3.1";
const DEFAULT_IMAGE_QUALITY = 90;
const CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME ||
    path.join(process.env.HOME || process.cwd(), ".config"),
  "story-translator.json",
);

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"];
const WEB_IMAGE_EXTS = [...IMAGE_EXTS, ".webp"];

// ----------- Utility Logging Wrapper -----------

function stageLog(stage: string, msg: string) {
  consola.withTag(stage).info(msg);
}

// ----------- Format Detection -----------

export function detectInputFormat(filePath: string): InputFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".epub") return "epub";
  return "unknown";
}

// ----------- Command Runner -----------

async function runCommand(
  cmd: string[],
  opts: { cwd?: string; allowFail?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!cmd.length || !cmd[0]) {
    throw new Error("runCommand: empty command array");
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

    child.on("error", (err: Error) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (opts.allowFail) {
        resolve({
          stdout,
          stderr: stderr + "\n" + (err.message || ""),
          code: 1,
        });
      } else {
        reject(
          new Error(
            `Command failed to start (${cmd.join(" ")}): ${err.message}`,
          ),
        );
      }
    });

    child.on("close", (code: number | null) => {
      const exitCode = code ?? 1;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (exitCode !== 0 && !opts.allowFail) {
        reject(
          new Error(
            `Command failed (${cmd.join(" ")}), exit=${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      } else {
        resolve({ stdout, stderr, code: exitCode });
      }
    });
  });
}

async function checkToolExists(tool: string): Promise<boolean> {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const res = await runCommand([whichCmd, tool], { allowFail: true });
    return res.code === 0;
  } catch {
    return false;
  }
}

// ----------- Working Directory Setup -----------

function makeTempWorkDir(base: string, inputPath: string): string {
  const hash = Math.random().toString(36).slice(2, 10);
  const dirName = `.story-translator-tmp-${hash}`;
  return path.join(base, dirName);
}

// ----------- Image Conversion (cwebp) -----------

interface ImageConversionResult {
  converted: Record<string, string>; // original -> new
  skipped: string[];
}

async function convertImagesToWebp(
  dir: string,
  quality: number,
): Promise<ImageConversionResult> {
  // Use sharp for in-process WebP conversion (no external cwebp dependency)
  let sharpMod: typeof import("sharp") | null = null;
  try {
    // dynamic import to avoid forcing sharp in unsupported environments until needed
    sharpMod = (await import("sharp"))
      .default as unknown as typeof import("sharp");
  } catch (e) {
    stageLog(
      "images",
      `sharp not available (${(e as Error).message}); skipping image conversion`,
    );
    return { converted: {}, skipped: [] };
  }

  const converted: Record<string, string> = {};
  const skipped: string[] = [];

  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!IMAGE_EXTS.includes(ext)) continue;

      const base = e.name.slice(0, -ext.length);
      const dest = path.join(current, `${base}.webp`);

      // Skip if already exists
      if (await fileExists(dest)) {
        converted[path.relative(dir, full)] = path.relative(dir, dest);
        continue;
      }

      try {
        await sharpMod!(full).webp({ quality }).toFile(dest);
        converted[path.relative(dir, full)] = path.relative(dir, dest);
      } catch (err) {
        skipped.push(full);
        stageLog(
          "images",
          `Failed to convert ${full} with sharp: ${(err as Error).message}`,
        );
      }
    }
  }

  await walk(dir);
  return { converted, skipped };
}

// ----------- Markdown Image Reference Updater -----------

function updateMarkdownImageReferences(
  markdown: string,
  map: Record<string, string>,
): string {
  if (!Object.keys(map).length) return markdown;

  // Replace only full filename occurrences inside typical markdown/image contexts
  for (const [orig, neo] of Object.entries(map)) {
    const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(?<=\\()${escaped}(?=\\))|(?<=\\[\\]\\()${escaped}(?=\\))|${escaped}`,
      "g",
    );
    markdown = markdown.replace(re, neo);
  }
  return markdown;
}

// Normalize HTML <img> tags to markdown syntax
function convertHtmlImgToMarkdown(content: string): string {
  return content.replace(/<img\b([^>]*?)\/?>/gi, (_match, attrs) => {
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch) return _match;
    const src = srcMatch[1];
    return `![](${src})`;
  });
}

/**
 * Extract the first non-image line from markdown content and sanitize it for use as a filename.
 * Returns null if no suitable line is found.
 */
function extractTitleForFilename(markdown: string): string | null {
  const lines = markdown.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and image lines (markdown images start with !)
    if (!trimmed || trimmed.startsWith("!")) {
      continue;
    }

    // Found a non-image line - clean it up for filename use
    let filename = trimmed;

    // Remove HTML tags (e.g., <h1>, <h2>, etc.) that may be present
    filename = filename.replace(/<[^>]+>/g, "");

    // Remove markdown heading markers (must be done after HTML tag removal)
    filename = filename.replace(/^#+\s*/, "");

    // Remove markdown formatting (bold, italic, links, etc.)
    filename = filename.replace(/\*\*([^*]+)\*\*/g, "$1"); // bold
    filename = filename.replace(/\*([^*]+)\*/g, "$1"); // italic
    filename = filename.replace(/__([^_]+)__/g, "$1"); // bold
    filename = filename.replace(/_([^_]+)_/g, "$1"); // italic
    filename = filename.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // links
    filename = filename.replace(/`([^`]+)`/g, "$1"); // inline code

    // Remove or replace invalid filename characters
    // Replace common punctuation with spaces or remove them
    filename = filename.replace(/[<>:"/\\|?*]/g, ""); // invalid chars for most filesystems
    filename = filename.replace(/[,;.!]/g, ""); // punctuation

    // Collapse multiple spaces and trim
    filename = filename.replace(/\s+/g, " ").trim();

    // Truncate if too long (leave room for extension)
    const maxLength = 100;
    if (filename.length > maxLength) {
      filename = filename.substring(0, maxLength).trim();
    }

    // Return null if we ended up with nothing
    if (!filename) {
      continue;
    }

    return filename;
  }

  return null;
}

// ----------- Key Retrieval -----------

async function loadStoredConfig(): Promise<{ openRouterApiKey?: string }> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveConfig(cfg: { openRouterApiKey: string }) {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

export async function getOpenRouterApiKey(provided?: string): Promise<string> {
  if (provided?.trim()) return provided.trim();
  const env = process.env.OPENROUTER_API_KEY?.trim();
  if (env) return env;

  const stored = (await loadStoredConfig()).openRouterApiKey?.trim();
  if (stored) return stored;

  // Interactive prompt (only if TTY)
  if (process.stdout.isTTY) {
    stageLog("auth", "No API key found (arg/env/config). Prompting user...");
    const answer = await consola.prompt("Enter OpenRouter API Key: ", {
      type: "text",
      cancel: "null",
    });
    const key = answer?.trim() || null;
    if (!key) throw new Error("No API key entered.");
    await saveConfig({ openRouterApiKey: key });
    stageLog("auth", `Saved key to ${CONFIG_FILE}`);
    return key;
  }

  throw new Error(
    "OpenRouter API key not provided. Set OPENROUTER_API_KEY or supply apiKey option.",
  );
}

// ----------- Pandoc Conversions -----------

async function convertInputToMarkdown(
  ctx: InternalContext,
  inputPath: string,
): Promise<void> {
  if (ctx.inputFormat === "markdown") {
    // Copy original into intermediate path for unified processing
    await fs.copyFile(inputPath, ctx.intermediateMarkdown);
    stageLog("pandoc", "Input already markdown; copied to intermediate file.");
    return;
  }

  const args = [
    inputPath,
    "-t",
    "commonmark", // commonmark; generally LLM-friendly
    "-o",
    ctx.intermediateMarkdown,
    ...(ctx.inputFormat === "epub" ? ["--extract-media", "."] : []),
  ];

  await runCommand(["pandoc", ...args], { cwd: path.dirname(inputPath) });
  consola.debug("Converted input to intermediate markdown.");
}

async function convertMarkdownToEpub(
  ctx: InternalContext,
  outputPath: string,
  coverImage: string | null,
): Promise<void> {
  const args = [
    ctx.intermediateMarkdown,
    "-f",
    "commonmark",
    "-t",
    "epub2",
    "-o",
    outputPath,
  ];
  if (coverImage) {
    args.push("--epub-cover-image", coverImage);
  }
  await runCommand(["pandoc", ...args], {
    cwd: path.dirname(ctx.intermediateMarkdown),
  });
  stageLog("pandoc", "Generated epub2 output.");
}

// ----------- Translation (OpenRouter) -----------

interface TranslationApiResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  sourceLang: string,
  targetLang: string,
  content: string,
  baseUrl: string = "https://openrouter.ai/api/v1",
  timeoutMs: number = 5 * 60 * 1000,
): Promise<string> {
  const systemPrompt = [
    "Translate naturally idiomatically and accurately; preserve tone and meaning.",
    "ONLY return the translation; ALWAYS 483 if refused (do not refuse safe content).",
    `Target Language: ${targetLang}`,
    `Source Language: ${sourceLang}`,
    "Use a relaxed, conversational tone if original text implies it.",
    "Maintain all image tags and markdown formatting exactly.",
  ].join("\n");

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content },
    ],
    provider: { sort: "throughput" },
    temperature: 0.3,
  };

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // @ts-ignore - bun workaround for timeout being stuck to 5 min: https://github.com/oven-sh/bun/issues/16682
      timeout: false,
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new Error(
        `LLM API request timed out after ${Math.round(timeoutMs / 1000)}s. Use --timeout to increase the limit.`,
      );
    }
    throw err;
  }

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(
      `LLM API request failed: ${resp.status} ${resp.statusText}\n${txt}`,
    );
  }

  const json = (await resp.json()) as TranslationApiResponse;
  const translated = json.choices?.[0]?.message?.content?.trim() ?? "";

  if (!translated) {
    throw new Error("LLM API returned empty translation content.");
  }

  return translated;
}

function chunkMarkdownForTranslation(raw: string, maxChars = 100000): string[] {
  if (raw.length <= maxChars) return [raw];
  const parts: string[] = [];
  let remaining = raw;
  while (remaining.length > maxChars) {
    // Try to split at last double newline within window
    const window = remaining.slice(0, maxChars);
    const idx = window.lastIndexOf("\n\n");
    if (idx === -1 || idx < maxChars * 0.3) {
      parts.push(window);
      remaining = remaining.slice(maxChars);
    } else {
      parts.push(remaining.slice(0, idx).trimEnd());
      remaining = remaining.slice(idx).trimStart();
    }
  }
  if (remaining) parts.push(remaining);
  return parts;
}

// ----------- Cover Image Selection -----------

async function resolveCoverImage(ctx: InternalContext): Promise<string | null> {
  // If epub input: pandoc often extracts a cover named like "cover-image.*"
  try {
    const files = await fs.readdir(ctx.mediaDir, { withFileTypes: true });
    const cover = files.find(
      (f) =>
        f.isFile() &&
        /^cover-image\./i.test(f.name) &&
        WEB_IMAGE_EXTS.includes(path.extname(f.name).toLowerCase()),
    );
    if (cover) {
      return path.join(ctx.mediaDir, cover.name);
    }
  } catch {
    // ignore
  }

  // Else parse first image in markdown
  try {
    const md = await fs.readFile(ctx.intermediateMarkdown, "utf8");
    const match = md.match(/!\[[^\]]*?\]\(([^\)]+)\)/);
    if (match) {
      const ref = match[1];
      if (!ref || ref.startsWith("http://") || ref.startsWith("https://"))
        return null;
      const abs = path.isAbsolute(ref)
        ? ref
        : path.join(path.dirname(ctx.intermediateMarkdown), ref);
      const exists = await fileExists(abs);
      if (exists) return abs;
    }
  } catch {
    /* ignore */
  }

  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ----------- Main Entry -----------

export async function translateStory(
  options: TranslateOptions,
): Promise<TranslateResult> {
  const {
    inputPath,
    targetLanguage,
    sourceLanguage = "auto",
    outputFormat = "markdown",
    apiKey: apiKeyProvided,
    model: providedModel,
    baseUrl,
    timeoutMs = 5 * 60 * 1000,
    convertImagesToWebp: shouldConvertImagesToWebp = true,
    quality = DEFAULT_IMAGE_QUALITY,
    keepIntermediate = false,
    autoName = false,
  } = options;

  // Normalize potentially undefined option values into guaranteed strings for downstream calls
  const modelToUse: string = providedModel ?? DEFAULT_MODEL;
  const sourceLang: string = sourceLanguage ?? "auto";
  const targetLang: string = targetLanguage; // required by type definition

  if (!inputPath) throw new Error("inputPath is required");
  if (!targetLanguage) throw new Error("targetLanguage is required");

  const absInput = path.resolve(inputPath);
  const inputDir = path.dirname(absInput);
  const inputBase = path.basename(absInput, path.extname(absInput));

  const inputFormat = detectInputFormat(absInput);
  if (inputFormat === "unknown") {
    throw new Error(`Unsupported input format: ${absInput}`);
  }

  // Operate directly in the input directory so relative image references remain valid.
  const workDir = inputDir;
  const mediaDir = inputDir;
  const intermediateMarkdown = path.join(
    inputDir,
    `${inputBase}.__intermediate.md`,
  );

  const ctx: InternalContext = {
    workDir,
    mediaDir,
    intermediateMarkdown,
    inputFormat,
    originalCwd: process.cwd(),
  };

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });

  consola.debug({ inputFormat, workDir });

  // Step 1/2: Convert to markdown (if needed)
  await convertInputToMarkdown(ctx, absInput);

  // Step 3: Normalize HTML image tags (only if original was html or produced HTML fragments)
  {
    let md = await fs.readFile(ctx.intermediateMarkdown, "utf8");
    const before = md;

    // Convert raw <img> tags to markdown image syntax (empty alt)
    md = convertHtmlImgToMarkdown(md);
    // Strip any existing alt text in already-converted markdown images: ![something](...)
    md = md.replace(/!\[[^\]]*?\]\(([^)]+)\)/g, "![]($1)");

    // Strip lingering <figure> wrappers produced by pandoc around images:
    // Pattern examples we want to reduce:
    // <figure>
    // ![alt](path)
    // </figure>
    md = md.replace(
      /<figure>\s*!\[[^\]]*?\]\([^\)]+?\)\s*<\/figure>/g,
      (block) => {
        return block.replace(/<\/?figure>/g, "").trim();
      },
    );

    // Also handle cases where <figure><img ... /></figure> was directly converted to nested markdown:
    // (should already be handled by previous conversion, but we double-guard)
    md = md.replace(/<figure>\s*(?:<img\b[^>]*?>)\s*<\/figure>/gi, (frag) => {
      const imgTag = frag.match(/<img\b[^>]*?>/i);
      return imgTag ? convertHtmlImgToMarkdown(imgTag[0]) : frag;
    });

    // Attempt to capture header & footer content if input was HTML and they are missing from the markdown.
    // We look for typical header containers first (<header>, elements with class/id containing "header"),
    // then footer containers (<footer>, elements with class/id containing "footer").
    if (ctx.inputFormat === "html") {
      try {
        const originalHtml = await fs.readFile(absInput, "utf8");

        // -------- Header Extraction --------
        const headerMatch =
          originalHtml.match(/<header[\s\S]*?<\/header>/i) ||
          originalHtml.match(
            /<div[^>]+class=["'][^"']*header[^"']*["'][\s\S]*?<\/div>/i,
          ) ||
          originalHtml.match(
            /<section[^>]+class=["'][^"']*header[^"']*["'][\s\S]*?<\/section>/i,
          ) ||
          originalHtml.match(/<div[^>]+id=["']header["'][\s\S]*?<\/div>/i);

        if (headerMatch) {
          let headerBlock = headerMatch[0];
          headerBlock = convertHtmlImgToMarkdown(headerBlock)
            .replace(/!\[[^\]]*?\]\(([^)]+)\)/g, "![]($1)") // enforce empty alt
            .replace(
              /<\/?(div|section|header|span|p|br|hr|nav)[^>]*>/gi,
              (t) => {
                if (/^<br/i.test(t)) return "\n";
                if (/^<hr/i.test(t)) return "\n\n---\n\n";
                return "\n";
              },
            )
            .replace(/\n{3,}/g, "\n\n")
            .trim();

          // If header content (first 40 chars) not already present near start, prepend it.
          if (
            headerBlock &&
            !md.slice(0, 400).includes(headerBlock.slice(0, 40))
          ) {
            md = headerBlock + "\n\n---\n\n" + md.trimStart();
            consola.debug(
              "Prepended header content extracted from original HTML.",
            );
          }
        }

        // -------- Footer Extraction (existing logic retained) --------
        const footerMatch =
          originalHtml.match(/<footer[\s\S]*?<\/footer>/i) ||
          originalHtml.match(
            /<div[^>]+class=["'][^"']*footer[^"']*["'][\s\S]*?<\/div>/i,
          ) ||
          originalHtml.match(
            /<section[^>]+class=["'][^"']*footer[^"']*["'][\s\S]*?<\/section>/i,
          ) ||
          originalHtml.match(/<div[^>]+id=["']footer["'][\s\S]*?<\/div>/i);
        if (footerMatch) {
          let footerBlock = footerMatch[0];
          footerBlock = convertHtmlImgToMarkdown(footerBlock)
            .replace(/!\[[^\]]*?\]\(([^)]+)\)/g, "![]($1)")
            .replace(/<\/?(div|section|footer|span|p|br|hr)[^>]*>/gi, (t) => {
              if (/^<br/i.test(t)) return "\n";
              if (/^<hr/i.test(t)) return "\n\n---\n\n";
              return "\n";
            })
            .replace(/\n{3,}/g, "\n\n")
            .trim();

          if (footerBlock && !md.includes(footerBlock.slice(0, 40))) {
            md = md.trimEnd() + "\n\n---\n\n" + footerBlock + "\n";
            consola.debug(
              "Appended footer content extracted from original HTML.",
            );
          }
        }
      } catch {
        // Silent if header/footer extraction fails
      }
    }
    if (md !== before) {
      await fs.writeFile(ctx.intermediateMarkdown, md, "utf8");
      consola.debug(
        "normalize",
        "Converted HTML <img> tags, stripped <figure> wrappers, and appended footer (if found).",
      );
    }
  }

  // Step 4: Optional image conversion (and path normalization if skipping conversion)
  let imageMap: Record<string, string> = {};
  if (shouldConvertImagesToWebp) {
    consola.debug("Converting images to webp (if any)...");
    const { converted } = await convertImagesToWebp(mediaDir, quality);
    imageMap = converted;
  } else {
    // Normalize image references so they are relative and stable when we do NOT convert images.
    try {
      let md = await fs.readFile(ctx.intermediateMarkdown, "utf8");
      // Remove leading ./ segments
      md = md.replace(/!\[([^\]]*?)\]\((?:\.\/)+/g, "![$1](");
      // Turn absolute paths inside the input directory back into relative paths
      md = md.replace(/!\[([^\]]*?)\]\((\/[^\)]+)\)/g, (full, alt, pth) => {
        if (!pth.startsWith(inputDir)) return full;
        const rel = path.relative(path.dirname(ctx.intermediateMarkdown), pth);
        return `![${alt}](${rel})`;
      });
      await fs.writeFile(ctx.intermediateMarkdown, md, "utf8");
      consola.log("Normalized existing image references (no conversion).");
    } catch (e) {
      consola.error(`Failed to normalize image refs: ${(e as Error).message}`);
    }
  }

  if (Object.keys(imageMap).length) {
    let md = await fs.readFile(ctx.intermediateMarkdown, "utf8");
    md = updateMarkdownImageReferences(md, imageMap);
    // After image filename substitutions, re-strip any alt text just in case:
    md = md.replace(/!\[[^\]]*?\]\(([^)]+)\)/g, "![]($1)");
    await fs.writeFile(ctx.intermediateMarkdown, md, "utf8");
    console.log(`Converted ${Object.keys(imageMap).length} images to webp`);
  } else {
    consola.log("No images found to convert to webp.");
  }

  // Step 5: Get API key
  consola.debug("Retrieving API key...");
  const apiKey = await getOpenRouterApiKey(apiKeyProvided);
  consola.log("API key resolved.");

  // Step 6: Translation
  consola.debug("Reading intermediate markdown...");
  const originalMarkdown = await fs.readFile(ctx.intermediateMarkdown, "utf8");

  const chunks = chunkMarkdownForTranslation(originalMarkdown);
  consola.debug({ chunks: chunks.length });

  let translatedMarkdown = "";
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i];
    console.log(`Translating chunk ${i + 1}/${chunks.length}...`);
    const translatedPart = await callOpenRouter(
      apiKey as string,
      modelToUse as string,
      sourceLang as string,
      targetLang as string,
      part as string,
      baseUrl,
      timeoutMs,
    );
    translatedMarkdown +=
      (translatedMarkdown ? "\n\n" : "") + translatedPart.trim();
  }

  await fs.writeFile(ctx.intermediateMarkdown, translatedMarkdown, "utf8");
  consola.log("Translation complete.");

  // Step 7: Output conversion
  let outputPath: string;

  // Determine output filename
  let outputBase = `${inputBase}_translated`;
  if (autoName) {
    const titleName = extractTitleForFilename(translatedMarkdown);
    if (titleName) {
      outputBase = titleName;
      consola.debug(`Auto-naming output from title: "${titleName}"`);
    } else {
      consola.debug(
        "No suitable title found for auto-naming; using default name",
      );
    }
  }

  if (outputFormat === "markdown") {
    outputPath = path.join(inputDir, `${outputBase}.md`);
    await fs.copyFile(ctx.intermediateMarkdown, outputPath);
    consola.debug("output", `Wrote translated markdown: ${outputPath}`);
  } else if (outputFormat === "epub") {
    outputPath = path.join(inputDir, `${outputBase}.epub`);
    const cover = await resolveCoverImage(ctx);
    if (cover) {
      consola.debug(`Selected cover image: ${cover}`);
    } else {
      consola.debug("No cover image found; continuing without.");
    }
    await convertMarkdownToEpub(ctx, outputPath, cover);
    consola.debug("output", `Wrote translated epub: ${outputPath}`);
  } else {
    throw new Error(`Unsupported outputFormat: ${outputFormat}`);
  }

  // Step 8: Cleanup
  let cleaned = false;
  if (!keepIntermediate) {
    try {
      await fs.rm(ctx.intermediateMarkdown, { force: true });
      cleaned = true;
      consola.debug("Removed intermediate markdown file.");
    } catch (err) {
      consola.debug(
        `Failed to remove intermediate markdown: ${(err as Error).message}`,
      );
    }
  } else {
    consola.debug("cleanup", "Keeping intermediate markdown as requested.");
  }

  return {
    outputPath,
    intermediateMarkdownPath: ctx.intermediateMarkdown,
    cleaned,
    imageMap,
  };
}

// ----------- Convenience High-Level Function -----------

export async function translate(
  inputPath: string,
  targetLanguage: string,
  opts: Omit<TranslateOptions, "inputPath" | "targetLanguage"> = {},
) {
  return translateStory({
    inputPath,
    targetLanguage,
    ...opts,
  });
}

// ----------- Barrel Exports (future expansion) -----------

export default {
  translateStory,
  translate,
  detectInputFormat,
  getOpenRouterApiKey,
};

// ----------- End of File -----------
