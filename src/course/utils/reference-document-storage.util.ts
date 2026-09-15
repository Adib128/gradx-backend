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

  const safeName = String(options.originalName || 'document')
    .replace(/[^\w.\-]+/g, '_')
    .slice(0, 80);
  const storedName = `ref-${Date.now()}-${safeName}`;
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
