/** Default max output tokens for OpenRouter chat completions.
 * Without this, some models request ~65535 and fail with 402 when
 * remaining credits cannot cover that ceiling.
 */
export const OPENROUTER_MAX_OUTPUT_TOKENS = 8192;
