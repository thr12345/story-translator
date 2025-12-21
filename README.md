# Story translator

Translate downloaded, illustrated stories (HTML, Markdown, or EPUB) into another language using OpenRouter while preserving images.
The pipeline normalizes everything to Markdown (LLM-friendly), translates, and then outputs either Markdown (default) or epub2.
Optionally converts local images to WebP (quality 90) to reduce size.

## Features

- Input formats: `.html`, `.md`, `.epub`
- Output formats: Markdown (default) or `epub2`
- Intermediary standardized Markdown
- Optional image conversion to WebP (default on)
- Local image path rewriting after conversion
- OpenRouter key discovery order:
  1. Direct CLI or library option
  2. Environment variable `OPENROUTER_API_KEY`
  3. Stored config `~/.config/story-translator.json`
  4. Interactive prompt (persisted for future runs)
- Automatic cover image:
  - If input EPUB: extracted cover (e.g. `cover-image.*`)
  - Otherwise first image found in the story
- Cleans temp working directory unless `--keep-intermediate` is set

## Requirements

- Bun (runtime) >= 1.0
- Node (for publishing / compatibility) >= 18
- Pandoc (must be installed and on PATH)
- Optional: `cwebp` (from libwebp) for image conversion. If missing, conversion is skipped with a notice.

## Installation

```/dev/null/shell.sh#L1-3
bun install story-translator
# or with npm
# npm install story-translator
```

(If using directly from this repo:)
```/dev/null/shell.sh#L1-3
bun install
bun run build
```

## CLI Usage

```/dev/null/shell.sh#L1-12
story-translator <inputFile> --to <TargetLanguage> [options]

# Basic markdown to English
story-translator ./test/test.md --to English

# HTML to Spanish, keep intermediates for inspection
story-translator ./test/test.html --to Spanish --keep-intermediate

# EPUB to English epub output
story-translator ./test/test.epub --to English --format epub

# Disable image conversion
story-translator ./test/test.md --to English --no-image-conversion

# Auto-name output file from the translated title
story-translator ./test/test.md --to English --auto-name
```

### CLI Options

(Names use kebab-case; aliases shown in parens)

- `--to, -t <string>` Target language (required)
- `--source, -s <string>` Source language (default: auto / model-detect)
- `--format, -f <markdown|epub>` Output format (default: markdown)
- `--model, -m <string>` OpenRouter model (default: deepseek/deepseek-chat-v3.1)
- `--apiKey, -k <string>` Explicit API key (otherwise discovery applies)
- `--quality <0-100>` WebP quality (default: 90)
- `--no-image-conversion` Disable image conversion
- `--keep-intermediate` Keep temp working directory & intermediate markdown
- `--auto-name` Name output file from first non-image line (usually the title) (default: false)
- `--work-root <dir>` Place temporary work folder under this directory
- `--quiet` Suppress non-error logs
- `--verbose` More detailed logs
- `--version, -v` Show version
- `--help, -h` Help text

### Exit Codes

- `0` success
- `1` validation / usage error
- `2` unexpected runtime failure

## Library Usage (TypeScript)

```/dev/null/translate.ts#L1-40
import { translateStory } from 'story-translator';

async function run() {
  const result = await translateStory({
    inputPath: './test/test.md',
    targetLanguage: 'English',
    outputFormat: 'markdown',     // or 'epub'
    convertImagesToWebp: true,
    quality: 90,
    // apiKey: 'sk-or-...',       // optional override
    // sourceLanguage: 'Japanese',
    keepIntermediate: false,
    autoName: false,    // set to true to name output from title
    onProgress: (stage, details) => {
      console.log(`[${stage}]`, details);
    }
  });

  console.log('Output file:', result.outputPath);
  console.log('Image conversions:', result.imageMap);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
```

### Quick Helper

```/dev/null/simple.ts#L1-12
import { translate } from 'story-translator';

await translate('./chapter.html', 'English', {
  outputFormat: 'epub',
  convertImagesToWebp: true
});
```

## Programmatic API

```/dev/null/api.txt#L1-20
translateStory(options: TranslateOptions) => Promise<TranslateResult>
translate(inputPath, targetLanguage, opts?) => Promise<TranslateResult>
detectInputFormat(path) => 'markdown' | 'html' | 'epub' | 'unknown'
getOpenRouterApiKey(optionalProvidedKey?) => Promise<string>

type TranslateOptions = {
  inputPath: string;
  targetLanguage: string;
  sourceLanguage?: string;
  outputFormat?: 'markdown' | 'epub';
  apiKey?: string;
  model?: string;
  convertImagesToWebp?: boolean;
  quality?: number;
  keepIntermediate?: boolean;
  autoName?: boolean;
  workRoot?: string;
  onProgress?: (stage: string, details?: any) => void;
}
```

`TranslateResult`:

```/dev/null/types.txt#L1-8
{
  outputPath: string;
  intermediateMarkdownPath: string;
  cleaned: boolean;
  imageMap: Record<string, string>; // originalRelative -> newRelative
}
```

## API Key Persistence

1. Provided directly (`--apiKey` or `apiKey` option)
2. Env var `OPENROUTER_API_KEY`
3. Stored config JSON: `~/.config/story-translator.json`
4. Interactive masked prompt (then persists to config)

Stored file format:

```/dev/null/config.json#L1-3
{
  "openRouterApiKey": "sk-or-..."
}
```

## Image Handling

- All original images extracted by Pandoc into a temp media directory
- When enabled, images with extensions `.png .jpg .jpeg .bmp .tif .tiff` are converted to `.webp`
- Markdown references rewritten to new `.webp` filenames
- Already `.webp` images are left as-is

## EPUB Output Notes

- Uses `epub2` target to maximize compatibility
- Cover preference:
  1. Extracted `cover-image.*` (if EPUB input)
  2. First image reference encountered in translated markdown
- Result written beside original: `originalName_translated.epub`

## Output File Naming

By default:
```
<originalBase>_translated.md
<originalBase>_translated.epub
```

With `--auto-name`:
```
<FirstNonImageLine>.md
<FirstNonImageLine>.epub
```

The auto-naming feature extracts the first non-image line from the translated content (usually the title), removes markdown formatting, and sanitizes it for use as a filename. If no suitable line is found, it falls back to the default naming.

Placed in the same directory as the input file.

## Manual Testing

Example inputs provided (see `test/`):
- `test/test.md` (Markdown + relative images)
- `test/test.html` (HTML + images)
- `test/test.epub` (Embedded images)

Try:

```/dev/null/tests.sh#L1-5
story-translator test/test.md --to English
story-translator test/test.html --to English --format epub
story-translator test/test.epub --to English --format markdown
```

## Publishing

The project is set up for npm publication (GitHub Actions workflow triggers on tags `v*`).
Exports:
- ESM entry: `dist/index.js`
- Types: `dist/index.d.ts`
- CLI binary: `story-translator`

## Troubleshooting

- Pandoc not found: Install from https://pandoc.org/install.html
- cwebp missing: Install `libwebp` (Homebrew: `brew install webp`)
- API key prompt not appearing: Ensure you are in an interactive TTY
- Large inputs: The markdown is chunked automatically before translation

## License

MIT

## Repository

https://github.com/thr12345/story-translator
