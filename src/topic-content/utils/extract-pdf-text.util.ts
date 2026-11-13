import { PDFParse } from 'pdf-parse';
import { createWorker, type Worker } from 'tesseract.js';
import { normalizeExtractedText } from './normalize-pdf-text.util';

const MIN_CHARS_PER_PAGE = 40;
const OCR_LANGUAGES = 'fra+eng';

export type PdfExtractionMethod = 'text-layer' | 'ocr' | 'hybrid';

export type PdfExtractionPage = {
  pageNumber: number;
  text: string;
  characterCount: number;
  method: 'text-layer' | 'ocr';
};

export type PdfExtractionResult = {
  text: string;
  pageCount: number;
  pages: PdfExtractionPage[];
  method: PdfExtractionMethod;
  characterCount: number;
  nonEmptyPageCount: number;
  warnings: string[];
};

function isPageEffectivelyEmpty(text: string): boolean {
  return normalizeExtractedText(text).length < MIN_CHARS_PER_PAGE;
}

function buildCombinedText(pages: PdfExtractionPage[]): string {
  return pages
    .map((page) => {
      const body = page.text.trim();
      if (!body) return '';
      return `--- Page ${page.pageNumber} ---\n${body}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function resolveExtractionMethod(
  pages: PdfExtractionPage[],
): PdfExtractionMethod {
  const ocrPages = pages.filter((page) => page.method === 'ocr').length;
  if (ocrPages === 0) return 'text-layer';
  if (ocrPages === pages.length) return 'ocr';
  return 'hybrid';
}

async function recognizePages(
  parser: PDFParse,
  pageNumbers: number[],
  worker: Worker,
): Promise<Map<number, string>> {
  const recognized = new Map<number, string>();

  if (pageNumbers.length === 0) {
    return recognized;
  }

  const screenshots = await parser.getScreenshot({
    scale: 2,
    partial: pageNumbers,
  });

  for (const page of screenshots.pages) {
    const { data } = await worker.recognize(Buffer.from(page.data));
    recognized.set(
      page.pageNumber,
      normalizeExtractedText(data.text ?? ''),
    );
  }

  return recognized;
}

export type ExtractPdfDocumentOptions = {
  /**
   * OCR empty/scanned pages. Default true for course-spec uploads.
   * Reference textbooks should pass false — OCR on large PDFs OOMs the API box.
   */
  allowOcr?: boolean;
  /** Pages per getText() call to keep memory bounded on large books. */
  pageBatchSize?: number;
  onProgress?: (progress: { page: number; total: number }) => void;
};

const DEFAULT_PAGE_BATCH = 40;

export async function extractPdfDocument(
  buffer: Buffer,
  options: ExtractPdfDocumentOptions = {},
): Promise<PdfExtractionResult> {
  const allowOcr = options.allowOcr !== false;
  const pageBatchSize = Math.max(1, options.pageBatchSize ?? DEFAULT_PAGE_BATCH);
  const parser = new PDFParse({ data: buffer });
  const warnings: string[] = [];

  try {
    const info = await parser.getInfo();
    const pageCount = Math.max(info.total ?? 0, 1);
    const textLayerPages: PdfExtractionPage[] = [];

    // Batch page text extraction so multi-hundred-page textbooks stay within
    // the small production VM memory budget.
    for (let start = 1; start <= pageCount; start += pageBatchSize) {
      const end = Math.min(pageCount, start + pageBatchSize - 1);
      const partial = Array.from(
        { length: end - start + 1 },
        (_, index) => start + index,
      );
      const textResult = await parser.getText({
        parseHyperlinks: true,
        lineEnforce: true,
        pageJoiner: '',
        itemJoiner: ' ',
        partial,
      });

      for (const pageNumber of partial) {
        const pageText = normalizeExtractedText(
          textResult.getPageText(pageNumber) ??
            textResult.pages.find((page) => page.num === pageNumber)?.text ??
            '',
        );
        textLayerPages.push({
          pageNumber,
          text: pageText,
          characterCount: pageText.length,
          method: 'text-layer',
        });
      }

      options.onProgress?.({ page: end, total: pageCount });
    }

    const emptyPageNumbers = textLayerPages
      .filter((page) => isPageEffectivelyEmpty(page.text))
      .map((page) => page.pageNumber);

    const nonEmptyTextLayerPages =
      textLayerPages.length - emptyPageNumbers.length;
    const needsOcr =
      allowOcr &&
      emptyPageNumbers.length > 0 &&
      (nonEmptyTextLayerPages === 0 ||
        emptyPageNumbers.length / pageCount >= 0.4);

    let finalPages = textLayerPages;

    if (needsOcr) {
      // Cap OCR work — full-book OCR on a 2GB box will abort the request.
      const ocrPageLimit = Math.min(emptyPageNumbers.length, 25);
      const ocrPages = emptyPageNumbers.slice(0, ocrPageLimit);
      if (emptyPageNumbers.length > ocrPageLimit) {
        warnings.push(
          `OCR limited to first ${ocrPageLimit} of ${emptyPageNumbers.length} empty pages.`,
        );
      }

      const worker = await createWorker(OCR_LANGUAGES);

      try {
        const ocrTexts = await recognizePages(parser, ocrPages, worker);

        finalPages = textLayerPages.map((page) => {
          if (!ocrPages.includes(page.pageNumber)) {
            return page;
          }

          const ocrText = ocrTexts.get(page.pageNumber) ?? '';

          if (!ocrText) {
            warnings.push(
              `Page ${page.pageNumber} could not be extracted by text layer or OCR.`,
            );
          }

          return {
            pageNumber: page.pageNumber,
            text: ocrText,
            characterCount: ocrText.length,
            method: 'ocr' as const,
          };
        });
      } finally {
        await worker.terminate();
      }

      if (nonEmptyTextLayerPages > 0) {
        warnings.push(
          `Used OCR for ${ocrPages.length} of ${pageCount} pages where the text layer was empty.`,
        );
      }
    } else if (emptyPageNumbers.length > 0) {
      warnings.push(
        allowOcr
          ? `Skipped OCR for ${emptyPageNumbers.length} low-content page(s); text layer values were kept.`
          : `Skipped OCR for ${emptyPageNumbers.length} low-content page(s) (OCR disabled for this upload).`,
      );
    }

    const combinedText = buildCombinedText(finalPages);
    const nonEmptyPageCount = finalPages.filter(
      (page) => !isPageEffectivelyEmpty(page.text),
    ).length;

    return {
      text: combinedText,
      pageCount,
      pages: finalPages,
      method: resolveExtractionMethod(finalPages),
      characterCount: combinedText.length,
      nonEmptyPageCount,
      warnings,
    };
  } finally {
    await parser.destroy();
  }
}

export async function extractPdfText(
  buffer: Buffer,
  options: ExtractPdfDocumentOptions = {},
): Promise<string> {
  const result = await extractPdfDocument(buffer, options);
  return result.text;
}
