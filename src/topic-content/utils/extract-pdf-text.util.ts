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

export async function extractPdfDocument(
  buffer: Buffer,
): Promise<PdfExtractionResult> {
  const parser = new PDFParse({ data: buffer });
  const warnings: string[] = [];

  try {
    const info = await parser.getInfo();
    const pageCount = Math.max(info.total ?? 0, 1);

    const textResult = await parser.getText({
      parseHyperlinks: true,
      lineEnforce: true,
      pageJoiner: '',
      itemJoiner: ' ',
    });

    const textLayerPages: PdfExtractionPage[] = Array.from(
      { length: pageCount },
      (_, index) => {
        const pageNumber = index + 1;
        const pageText = normalizeExtractedText(
          textResult.getPageText(pageNumber) ??
            textResult.pages.find((page) => page.num === pageNumber)?.text ??
            '',
        );

        return {
          pageNumber,
          text: pageText,
          characterCount: pageText.length,
          method: 'text-layer' as const,
        };
      },
    );

    const emptyPageNumbers = textLayerPages
      .filter((page) => isPageEffectivelyEmpty(page.text))
      .map((page) => page.pageNumber);

    const nonEmptyTextLayerPages =
      textLayerPages.length - emptyPageNumbers.length;
    const needsOcr =
      emptyPageNumbers.length > 0 &&
      (nonEmptyTextLayerPages === 0 ||
        emptyPageNumbers.length / pageCount >= 0.4);

    let finalPages = textLayerPages;

    if (needsOcr) {
      const worker = await createWorker(OCR_LANGUAGES);

      try {
        const ocrTexts = await recognizePages(parser, emptyPageNumbers, worker);

        finalPages = textLayerPages.map((page) => {
          if (!emptyPageNumbers.includes(page.pageNumber)) {
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
          `Used OCR for ${emptyPageNumbers.length} of ${pageCount} pages where the text layer was empty.`,
        );
      }
    } else if (emptyPageNumbers.length > 0) {
      warnings.push(
        `Skipped OCR for ${emptyPageNumbers.length} low-content page(s); text layer values were kept.`,
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

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const result = await extractPdfDocument(buffer);
  return result.text;
}
