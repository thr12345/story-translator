#!/usr/bin/env node
/**
 * CLI entrypoint for story-translator
 *
 * Spec responsibilities:
 *  - Accept input file (html|md|epub)
 *  - Translate to target language using OpenRouter
 *  - Optional image conversion to webp (default on)
 *  - Output as markdown (default) or epub2
 *  - Persist API key (handled in library)
 *
 * Usage examples:
 *  story-translator ./test/test.md --to English
 *  story-translator ./test/test.html --to English --format epub
 *  story-translator ./test/test.epub --to English --keep-intermediate
 *
 * Exit codes:
 *  0 success
 *  1 user / validation error
 *  2 unexpected failure
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import consola from "consola";
import path from "path";
import { fileURLToPath } from "url";
import { translateStory, type TranslateOptions } from "../lib/translator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure consola defaults (can be toggled with --quiet / --verbose)
let logger = consola.create({ level: 3 });

interface CliArgs {
  input: string;
  to: string;
  format: "markdown" | "epub";
  model: string;
  source?: string;
  quality: number;
  noImageConversion: boolean;
  keepIntermediate: boolean;
  autoName: boolean;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  workRoot?: string;
  quiet: boolean;
  verbose: boolean;
  _?: (string | number)[];
}

function buildCli() {
  return yargs(hideBin(process.argv))
    .scriptName("story-translator")
    .command(
      "$0 <input>",
      "Translate a story file",
      (cmd) =>
        cmd
          .positional("input", {
            describe: "Path to input story file (html, md, epub)",
            type: "string",
          })
          .option("to", {
            alias: "t",
            type: "string",
            default: "English",
            describe: "Target language (e.g. English, Spanish, German)",
          })
          .option("source", {
            alias: "s",
            type: "string",
            describe:
              'Source language (if omitted, let model detect / use "auto")',
          })
          .option("format", {
            alias: "f",
            choices: ["markdown", "epub"] as const,
            default: "markdown",
            describe: "Output format for translated story",
          })
          .option("model", {
            alias: "m",
            type: "string",
            default: "deepseek/deepseek-chat-v3.1",
            describe: "LLM model identifier",
          })
          .option("baseUrl", {
            alias: "u",
            type: "string",
            describe:
              "LLM API base URL (defaults to https://openrouter.ai/api/v1)",
          })
          .option("timeout", {
            alias: "T",
            type: "number",
            describe:
              "Per-chunk request timeout in seconds (default: 300). Increase this for slow local models.",
          })
          .option("apiKey", {
            alias: "k",
            type: "string",
            describe:
              "Explicit OpenRouter API key (else env OPENROUTER_API_KEY or stored config or interactive prompt)",
          })
          .option("quality", {
            type: "number",
            default: 90,
            describe: "WEBP conversion quality (0-100)",
          })
          .option("no-image-conversion", {
            type: "boolean",
            default: false,
            describe: "Disable conversion of referenced images to webp",
          })
          .option("keep-intermediate", {
            type: "boolean",
            default: false,
            describe:
              "Keep intermediate markdown & temp working directory (for debugging)",
          })
          .option("auto-name", {
            type: "boolean",
            default: false,
            describe:
              "Automatically name the output file using the first non-image line (usually the title)",
          })
          .option("work-root", {
            type: "string",
            describe:
              "Directory in which to create temporary work folder (defaults to input file directory)",
          })
          .option("quiet", {
            type: "boolean",
            default: false,
            describe: "Suppress non-error logs",
          })
          .option("verbose", {
            type: "boolean",
            default: false,
            describe: "Enable verbose logging",
          })
          .example(
            "$0 ./story.md --to English",
            "Translate markdown story to English (markdown output)",
          )
          .example(
            "$0 ./book.epub --to English --format epub",
            "Translate epub to English and produce translated epub2",
          )
          .example(
            "$0 ./chapter.html --to Spanish --no-image-conversion",
            "Translate HTML story to Spanish without converting images",
          ),
      () => {
        /* no-op handler; parsing handled in main */
      },
    )
    .help()
    .alias("h", "help")
    .strict();
}

async function main() {
  const argv = (await buildCli().parse()) as unknown as CliArgs;

  // Adjust logging level
  if (argv.quiet) {
    logger = consola.create({ level: 0 });
  } else if (argv.verbose) {
    logger = consola.create({ level: 4 });
  }

  const input = (argv._ && argv._[0]) || argv.input;
  if (!input) {
    logger.error("Missing <input> file path.");
    process.exit(1);
  }

  const inputPath = path.resolve(String(input));
  const targetLanguage = argv.to;

  logger.start("Starting translation pipeline...");
  logger.info(`Input: ${inputPath}`);
  logger.info(`Target language: ${targetLanguage}`);
  logger.info(`Output format: ${argv.format}`);
  if (argv.source) {
    logger.info(`Source language: ${argv.source}`);
  }

  const options: TranslateOptions = {
    inputPath,
    targetLanguage,
    sourceLanguage: argv.source,
    outputFormat: argv.format,
    model: argv.model,
    apiKey: argv.apiKey,
    baseUrl: argv.baseUrl,
    timeoutMs: argv.timeout !== undefined ? argv.timeout * 1000 : undefined,
    convertImagesToWebp: !argv.noImageConversion,
    quality: argv.quality,
    keepIntermediate: argv.keepIntermediate,
    autoName: argv.autoName,
  };

  try {
    const result = await translateStory(options);
    logger.success(`Translation complete: ${result.outputPath}`);
    if (!argv.keepIntermediate) {
      logger.debug("Intermediate artifacts cleaned.");
    } else {
      logger.log(
        `Intermediate markdown kept at: ${result.intermediateMarkdownPath}`,
      );
    }
    process.exit(0);
  } catch (err) {
    const e = err as Error;
    logger.error(e.message);
    if (argv.verbose && e.stack) {
      logger.box(e.stack);
    }
    process.exit(2);
  }
}

// Global error safety nets
process.on("unhandledRejection", (reason) => {
  consola.error("Unhandled rejection:", reason);
  process.exit(2);
});
process.on("uncaughtException", (err) => {
  consola.error("Uncaught exception:", err);
  process.exit(2);
});

main();
