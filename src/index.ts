/**
 * Barrel exports for story-translate library.
 *
 * Public API surface:
 *  - translateStory(options)
 *  - translate(inputPath, targetLanguage, opts)
 *  - detectInputFormat(path)
 *  - getOpenRouterApiKey(provided?)
 *
 *  Types:
 *  - TranslateOptions
 *  - TranslateResult
 *
 *  Default export is an object containing the main functions.
 */

export {
  translateStory,
  translate,
  detectInputFormat,
  getOpenRouterApiKey,
  type TranslateOptions,
  type TranslateResult
} from './lib/translator.js';

import {
  translateStory,
  translate,
  detectInputFormat,
  getOpenRouterApiKey
} from './lib/translator.js';

export default {
  translateStory,
  translate,
  detectInputFormat,
  getOpenRouterApiKey
};
