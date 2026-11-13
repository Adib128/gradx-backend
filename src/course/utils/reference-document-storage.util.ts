import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

/**
 * Stable on-disk archive for original PDF/DOCX reference files.
 * Chapter text lives on Course.references JSON; binaries stay here (not in DB).
 */
export const REFERENCE_DOCUMENT_STORAGE_ROOT = 'uploads/reference-documents';

export function resolveReferenceDocumentDir(tenantId: number): {
  absoluteDir: string;
  relativeDir: string;
} {
  const relativeDir = join(REFERENCE_DOCUMENT_STORAGE_ROOT, String(tenantId));
  return {
    absoluteDir: join(process.cwd(), relativeDir),
    relativeDir,
  };
}

export async function storeReferenceDocumentFile(options: {
  tenantId: number;
  originalName: string;
  buffer: Buffer;
}): Promise<{ relativePath: string; absolutePath: string; storedName: string }> {
  const { absoluteDir, relativeDir } = resolveReferenceDocumentDir(
    options.tenantId,
  );
  await mkdir(absoluteDir, { recursive: true });

  // Keep the real extension (e.g. .pdf) even when the long original name is truncated.
  // Without it, browsers treat the file as a download and refuse to render in an iframe.
  const original = String(options.originalName || 'document').trim() || 'document';
  const extMatch = original.match(/(\.[A-Za-z0-9]{1,10})$/);
  const extension = extMatch ? extMatch[1].toLowerCase() : '';
  const baseName = original
    .slice(0, Math.max(0, original.length - extension.length))
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '')
    .slice(0, 60) || 'document';
  const storedName = `ref-${Date.now()}-${baseName}${extension}`;
  const absolutePath = join(absoluteDir, storedName);
  await writeFile(absolutePath, options.buffer);

  return {
    relativePath: join(relativeDir, storedName),
    absolutePath,
    storedName,
  };
}

/**
 * Resolve a tenant-scoped relative path under reference-documents storage.
 * Rejects path traversal and cross-tenant paths.
 */
export async function resolveTenantReferenceFilePath(
  tenantId: number,
  relativePath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const raw = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!raw) {
    throw new Error('REFERENCE_FILE_NOT_FOUND');
  }

  const { absoluteDir, relativeDir } = resolveReferenceDocumentDir(tenantId);
  const tenantPrefix = relativeDir.replace(/\\/g, '/');
  const normalizedRelative = normalize(raw).replace(/\\/g, '/');

  if (
    normalizedRelative !== tenantPrefix &&
    !normalizedRelative.startsWith(`${tenantPrefix}/`)
  ) {
    throw new Error('REFERENCE_FILE_FORBIDDEN');
  }

  const absolutePath = resolve(process.cwd(), normalizedRelative);
  const allowedRoot = resolve(absoluteDir);
  if (
    absolutePath !== allowedRoot &&
    !absolutePath.startsWith(allowedRoot + sep)
  ) {
    throw new Error('REFERENCE_FILE_FORBIDDEN');
  }

  try {
    await access(absolutePath);
  } catch {
    throw new Error('REFERENCE_FILE_NOT_FOUND');
  }

  return { absolutePath, relativePath: normalizedRelative };
}
