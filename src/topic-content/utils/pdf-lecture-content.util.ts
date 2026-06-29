import type { PdfExtractionResult } from './extract-pdf-text.util';
import { normalizeExtractedText } from './normalize-pdf-text.util';

type LectureSection = {
  title: string;
  body: string;
};

const SECTION_HEADER_PATTERN =
  /^(?:\d+(?:\.\d+)*[.)]?\s+|[A-Z][A-Z0-9\s/&-]{3,}$|Chapter\s+\d+|Section\s+\d+|Module\s+\d+)/;

function titleFromPageText(pageNumber: number, text: string): string {
  const firstMeaningfulLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length >= 8 && line.length <= 120);

  if (!firstMeaningfulLine) {
    return `Page ${pageNumber}`;
  }

  if (SECTION_HEADER_PATTERN.test(firstMeaningfulLine)) {
    return firstMeaningfulLine;
  }

  return `Page ${pageNumber}: ${firstMeaningfulLine.slice(0, 80)}`;
}

function splitIntoSections(text: string): LectureSection[] {
  const normalizedText = normalizeExtractedText(text);
  const pageSections = normalizedText
    .split(/\n*--- Page \d+ ---\n*/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  if (pageSections.length > 1) {
    return pageSections.map((body, index) => ({
      title: titleFromPageText(index + 1, body),
      body,
    }));
  }

  const lines = normalizedText.split('\n');
  const sections: LectureSection[] = [];
  let currentTitle = 'Uploaded Lecture Content';
  let currentLines: string[] = [];

  const pushSection = () => {
    const body = currentLines.join('\n').trim();
    if (!body) return;
    sections.push({ title: currentTitle, body });
    currentLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader =
      trimmed.length > 0 &&
      trimmed.length <= 120 &&
      SECTION_HEADER_PATTERN.test(trimmed) &&
      !trimmed.endsWith('.');

    if (isHeader && currentLines.length > 0) {
      pushSection();
      currentTitle = trimmed;
      continue;
    }

    if (isHeader && currentLines.length === 0) {
      currentTitle = trimmed;
      continue;
    }

    currentLines.push(line);
  }

  pushSection();

  if (sections.length > 0) {
    return sections;
  }

  const chunkSize = 4000;
  const chunks: LectureSection[] = [];
  for (let index = 0; index < normalizedText.length; index += chunkSize) {
    chunks.push({
      title: `Section ${chunks.length + 1}`,
      body: normalizedText.slice(index, index + chunkSize).trim(),
    });
  }

  return chunks.length > 0
    ? chunks
    : [{ title: 'Uploaded Lecture Content', body: normalizedText }];
}

function verifyModuleCoverage(
  sections: LectureSection[],
  sourceText: string,
): string[] {
  const warnings: string[] = [];
  const sourceLength = normalizeExtractedText(sourceText).length;
  const moduleLength = sections.reduce(
    (total, section) => total + normalizeExtractedText(section.body).length,
    0,
  );

  if (sourceLength > 0 && moduleLength < sourceLength * 0.95) {
    warnings.push(
      `Module content may be incomplete (${moduleLength}/${sourceLength} characters preserved).`,
    );
  }

  return warnings;
}

export function buildLectureContentFromPdfExtraction(params: {
  topicTitle: string;
  fileName: string;
  filePath: string;
  size: number;
  extraction: PdfExtractionResult;
}) {
  const normalizedText = normalizeExtractedText(params.extraction.text);
  const sections = splitIntoSections(normalizedText);
  const coverageWarnings = verifyModuleCoverage(sections, normalizedText);
  const abstractSource = sections[0]?.body || normalizedText;
  const abstract =
    abstractSource.length > 700
      ? `${abstractSource.slice(0, 700).trim()}...`
      : abstractSource;

  return {
    metadata: {
      targetTopic: params.topicTitle,
      noteType: 'Uploaded PDF',
      audienceTier: 'General',
      depthProfile: 'Uploaded',
      difficultyLevel: 'Uploaded',
      qualityComplianceMode: 'UPLOADED',
      source: 'upload',
      fileName: params.fileName,
      filePath: params.filePath,
      size: params.size,
      mimeType: 'application/pdf',
      extraction: {
        method: params.extraction.method,
        pageCount: params.extraction.pageCount,
        characterCount: params.extraction.characterCount,
        nonEmptyPageCount: params.extraction.nonEmptyPageCount,
        warnings: [
          ...params.extraction.warnings,
          ...coverageWarnings,
        ],
      },
    },
    lectureOverview: {
      abstract,
      learningObjectives: [],
      prerequisiteKnowledgeCheck: [],
    },
    modules: sections.map((section, index) => ({
      moduleIndex: index + 1,
      title: section.title,
      theoreticalFoundations: {
        formalDefinition: section.body,
      },
    })),
    comprehensiveAssessment: [],
    providedReferences: [],
    academicReviewVerification: {
      checksPassed: [],
      status: 'UPLOADED_PDF',
    },
  };
}

export function buildLectureContentFromPdfText(params: {
  topicTitle: string;
  fileName: string;
  filePath: string;
  size: number;
  extractedText: string;
}) {
  const normalizedText = normalizeExtractedText(params.extractedText);

  return buildLectureContentFromPdfExtraction({
    topicTitle: params.topicTitle,
    fileName: params.fileName,
    filePath: params.filePath,
    size: params.size,
    extraction: {
      text: normalizedText,
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          text: normalizedText,
          characterCount: normalizedText.length,
          method: 'text-layer',
        },
      ],
      method: 'text-layer',
      characterCount: normalizedText.length,
      nonEmptyPageCount: normalizedText ? 1 : 0,
      warnings: [],
    },
  });
}
