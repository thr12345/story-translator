# Story Translator

This Bun-based Typescript project is meant to take in downloaded, illustrated stories in multiple formats (html, markdown, epub) and output translated stories in either markdown or epub format.
It does this by first converting the input into an intermediary Markdown format and then using OpenRouter to translate that Markdown into the new target language. This is done because LLMs understand Markdown better than raw html. Once translated, the story is then packaged into either epub or Markdown file formats for output.

This is loosely based on the convert_epub.py script that is in this repo for reference. It has the LLM prompts needed. Otherwise you should base your work on this script, but do not need to re-implement it 1-1 or implement all of its features.

This is meant to be a relatively simple app for a narrow set of cases. Don't complicate and don't add unecessary options that aren't listed. I'll explicitly ask for them later if I want them.

## Steps
1. Takes input in html, Markdown, or epub format
  - These files can have references to local images embedded in them
2. Optionally, the script will convert the references images into webp quality 90 to save space (this is a default: true option)
  - If converting the images, put them in the same path as the original ones, just with a different extension
4. Converts the input to a Markdown intermediary (if not already Markdown) using Pandoc
  - If images were converted to webp, change the file extension of the image references in the Markdown file
  - Ensure that the local image refernces use the standard Markdown format: `![Uploaded Image 20722119](images/tei495422169314_42e6c5b3bc4a132290dced9e2df7a5a7_1.webp)`
5. Gets an OpenRouter API key:
  1. If run via library it will get it via an argument
  2. If via cli, it will check for an env variable
  3, If no env variable, it will check for a stored key in ~/.config/story-translate.json. If not there, it will interactivly prompt the user for a key via Consola and store the key for future runs.
6. Feeds the Markdown into the LLM using the prompts in convert_epub.py and get translated results
7. Converts the final translated story to either Markdown or epub (default Markdown)
  - Pandoc is sensitive to relative input folder when it comes to preseving images so make sure to run it in the
  - Use epub2 as the output spec for epubs
  - When converting to epub, set the cover image as either the input cover image (if input was epub) or as the first image in the story (if input was html or Markdown)
  - Make sure to place the output file in the same directory as the input with a filename of `${originalName}_translated.${extension}`
8. Delete intermediary Markdown file if no longer needed

## Technolgies
1. Pandoc for format conversion
2. Consola for logging and user input
3. Yargs for cli parsing

# Documentation
1. Include both cli and library examples in the README
2. Include an example typescript file that shows how to import and use the library

# NPM Publishing
1. Publishable to npm via the GitHub Acitons workflows in .github/workflows
  - It should expose a type file
2. Should expose both a cli (with args parsing via yargs) and a barrel-exported library to use the functions from another typescript project
3. GitHub repo is: https://github.com/thr12345/story-translator

# Testing
This is meant to be a relatively light app, so it does not require automated tests - manual tests will be fine. I've included example inputs in the test/ folder for manual testing. You can ask me to input the API key once you have bun.secrets with Consola user prompting working

Example inputs in /test
1. test/test.md - Markdown input with relative images
2. test/test.epub - epub input with embedded images
2. test/test.html - html input with relative images
