import { normalizeExtractedText } from '../src/topic-content/utils/normalize-pdf-text.util';
import { buildLectureContentFromPdfExtraction } from '../src/topic-content/utils/pdf-lecture-content.util';
import { extractPdfDocument } from '../src/topic-content/utils/extract-pdf-text.util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

async function verifyPdf(path: string) {
  const buffer = readFileSync(path);
  const extraction = await extractPdfDocument(buffer);
  const lecture = buildLectureContentFromPdfExtraction({
    topicTitle: 'Verification Topic',
    fileName: path.split('/').pop() ?? 'file.pdf',
    filePath: path,
    size: buffer.length,
    extraction,
  });

  const moduleChars = lecture.modules.reduce(
    (total, module) =>
      total +
      String(module.theoreticalFoundations?.formalDefinition ?? '').length,
    0,
  );

  console.log(`\n=== ${path.split('/').pop()} ===`);
  console.log('method:', extraction.method);
  console.log('pages:', extraction.pageCount);
  console.log('non-empty pages:', extraction.nonEmptyPageCount);
  console.log('extracted characters:', extraction.characterCount);
  console.log('module characters:', moduleChars);
  console.log(
    'coverage:',
    extraction.characterCount
      ? `${Math.round((moduleChars / extraction.characterCount) * 100)}%`
      : 'n/a',
  );
  console.log('modules:', lecture.modules.length);
  console.log('warnings:', [...extraction.warnings, ...(lecture.metadata.extraction?.warnings ?? [])]);

  assert(extraction.nonEmptyPageCount > 0, 'No pages with readable content');
  assert(extraction.characterCount > 0, 'Extracted text is empty');
  assert(moduleChars >= extraction.characterCount * 0.95, 'Module content lost text during mapping');

  for (const page of extraction.pages) {
    if (page.characterCount === 0) {
      console.warn(`  page ${page.pageNumber}: empty (${page.method})`);
    }
  }

  console.log('sample:', extraction.text.slice(0, 220).replace(/\n/g, ' '));
}

async function run() {
  const normalized = normalizeExtractedText('mainten-\nance plan');
  assert(normalized === 'maintenance plan', 'Hyphen normalization failed');

  const samples = [
  join(process.cwd(), 'tmp/lecture-uploads/1/topic-19-1782757628268-Mid-Term Exam.pdf'),
  join(process.cwd(), 'tmp/lecture-uploads/1/topic-19-1782757490064-Rapport_IA_Maintenance-1.pdf'),
  ].filter((path) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  });

  assert(samples.length > 0, 'No sample PDFs found under tmp/lecture-uploads');

  for (const sample of samples) {
    await verifyPdf(sample);
  }

  console.log('\nAll PDF extraction checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
