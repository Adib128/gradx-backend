import { ErrorMessageKey } from '../constants/error-message';

const KNOWN_KEYS = new Set(Object.values(ErrorMessageKey));

const MESSAGE_ALIASES: Array<{ pattern: RegExp; key: ErrorMessageKey }> = [
  {
    pattern: /assessment container shell not found/i,
    key: ErrorMessageKey.ASSESSMENT_SHELL_NOT_FOUND,
  },
  {
    pattern: /job not found/i,
    key: ErrorMessageKey.GENERATION_JOB_NOT_FOUND,
  },
  {
    pattern: /failed to communicate with ai|openai|openrouter|econnrefused|fetch failed/i,
    key: ErrorMessageKey.GENERATION_AI_API_FAILED,
  },
  {
    pattern: /invalid json|invalid response|invalid questions payload/i,
    key: ErrorMessageKey.GENERATION_AI_INVALID_JSON,
  },
  {
    pattern: /ai failed to generate question/i,
    key: ErrorMessageKey.ASSESSMENT_AI_QUESTION_FAILED,
  },
  {
    pattern: /file is required/i,
    key: ErrorMessageKey.COURSE_EXTRACT_FILE_REQUIRED,
  },
  {
    pattern: /unsupported (file|type)|pdf\/docx|pptx/i,
    key: ErrorMessageKey.COURSE_EXTRACT_UNSUPPORTED_FILE,
  },
  {
    pattern: /docx file does not contain readable text|empty docx/i,
    key: ErrorMessageKey.COURSE_EXTRACT_EMPTY_DOCX,
  },
  {
    pattern: /invalid docx/i,
    key: ErrorMessageKey.COURSE_EXTRACT_INVALID_DOCX,
  },
  {
    pattern: /generate and accept lecture|lecture content before/i,
    key: ErrorMessageKey.TOPIC_CONTENT_LECTURE_REQUIRED,
  },
  {
    pattern: /content type .+ not supported|type must be lecture/i,
    key: ErrorMessageKey.TOPIC_CONTENT_UNSUPPORTED_TYPE,
  },
  {
    pattern: /skywork.?api.?key|api key is required/i,
    key: ErrorMessageKey.SKYWORK_API_KEY_MISSING,
  },
  {
    pattern: /insufficient benefit|not enough benefit|quota|balance/i,
    key: ErrorMessageKey.SKYWORK_PPT_INSUFFICIENT_BENEFIT,
  },
  {
    pattern: /billing|payment required|402/i,
    key: ErrorMessageKey.SKYWORK_PPT_BILLING_ERROR,
  },
  {
    pattern: /no download url|download url/i,
    key: ErrorMessageKey.SKYWORK_PPT_NO_DOWNLOAD_URL,
  },
  {
    pattern: /failed to download|download failed/i,
    key: ErrorMessageKey.SKYWORK_PPT_DOWNLOAD_FAILED,
  },
  {
    pattern: /skywork ppt generation failed|skywork/i,
    key: ErrorMessageKey.SKYWORK_PPT_GENERATION_FAILED,
  },
  {
    pattern: /timeout|etimedout|aborterror/i,
    key: ErrorMessageKey.GENERATION_TIMEOUT,
  },
  {
    pattern: /redis|bullmq|queue|econnreset/i,
    key: ErrorMessageKey.GENERATION_QUEUE_UNAVAILABLE,
  },
  {
    pattern: /topic not found/i,
    key: ErrorMessageKey.TOPIC_NOT_FOUND,
  },
  {
    pattern: /course not found/i,
    key: ErrorMessageKey.COURSE_NOT_FOUND,
  },
];

export function normalizeGenerationErrorKey(
  raw: unknown,
  fallback: ErrorMessageKey = ErrorMessageKey.GENERATION_JOB_FAILED,
): ErrorMessageKey {
  if (raw == null) return fallback;

  const text = String(raw).trim();
  if (!text) return fallback;

  if (KNOWN_KEYS.has(text as ErrorMessageKey)) {
    return text as ErrorMessageKey;
  }

  // Nest sometimes wraps: "Error: KEY" or JSON-ish bodies
  for (const key of KNOWN_KEYS) {
    if (text.includes(key)) return key;
  }

  for (const alias of MESSAGE_ALIASES) {
    if (alias.pattern.test(text)) return alias.key;
  }

  return fallback;
}

export function generationErrorPayload(
  failedReason: string | null | undefined,
  fallback: ErrorMessageKey = ErrorMessageKey.GENERATION_JOB_FAILED,
) {
  if (!failedReason) {
    return { error: null as string | null, errorKey: null as string | null };
  }

  const errorKey = normalizeGenerationErrorKey(failedReason, fallback);
  return {
    error: failedReason,
    errorKey,
  };
}
