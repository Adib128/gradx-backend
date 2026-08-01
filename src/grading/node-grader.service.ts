/**
 * Pure Node.js OMR grader using `sharp`.
 *
 * Algorithm (no Python / OpenCV required):
 *  1. Resize image to 1000 × 1414 (A4 ratio, no perspective needed for flat scans).
 *  2. Convert to grayscale.
 *  3. For each bubble position defined in sheet-config, sample the mean pixel
 *     intensity inside a circular ROI.
 *  4. Relative-darkness comparison within each question row to find the filled bubble.
 *
 * Deliberate design: we skip a full-image adaptive threshold (O(n²)) and instead
 * compute per-bubble means directly from the grayscale buffer (O(bubbles × area)).
 * For 50 questions × 5 options × ~320 px/bubble ≈ 80 000 operations — fast.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SHEET_CONFIG, WARP_WIDTH, WARP_HEIGHT } from './sheet-config';

interface BubbleResult {
  question: number;
  detected: string | null;
  status: 'answered' | 'blank' | 'multiple';
  fills: Record<string, number>;
}

interface GradeResult {
  answers: Record<string, string>;
  confidence: number;
  decodedFormId: number | null;
  questionDetails: BubbleResult[];
  detectedStudentId: string | null;
  debug: Record<string, unknown>;
}

@Injectable()
export class NodeGraderService {
  private readonly logger = new Logger(NodeGraderService.name);

  async gradeSheet(imagePath: string, numIdDigits = 5): Promise<GradeResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require('sharp');
    const cfg = SHEET_CONFIG.answerGrid;

    // -----------------------------------------------------------------------
    // Load, resize to standard A4 dimensions, convert to grayscale
    // -----------------------------------------------------------------------
    const { data: grayBuf, info } = await sharp(imagePath)
      .resize(WARP_WIDTH, WARP_HEIGHT, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w: number = info.width;
    const h: number = info.height;

    // Compute global mean intensity for normalising fill ratios
    let globalSum = 0;
    for (let i = 0; i < grayBuf.length; i++) globalSum += grayBuf[i];
    const globalMean = globalSum / grayBuf.length;

    this.logger.debug(`Image loaded: ${w}×${h}, globalMean=${globalMean.toFixed(1)}`);

    // -----------------------------------------------------------------------
    // Grade each question
    // -----------------------------------------------------------------------
    const radiusPx = Math.max(5, Math.round(cfg.bubbleRadius * w));
    const answers: Record<string, string> = {};
    const details: BubbleResult[] = [];

    for (const col of cfg.columns) {
      for (let rowIdx = 0; rowIdx < col.count; rowIdx++) {
        const qNum = col.startQuestion + rowIdx;
        const rowY = Math.round((col.rowYStart + rowIdx * cfg.rowYStep) * h);

        // Sample mean intensity for each option bubble
        const means: number[] = [];
        for (let optIdx = 0; optIdx < cfg.options.length; optIdx++) {
          const bx = Math.round((col.bubbleAX + optIdx * cfg.bubbleXStep) * w);
          means.push(this.sampleMean(grayBuf as Buffer, w, h, bx, rowY, radiusPx));
        }

        // Convert mean intensities to fill ratios:
        //   A dark (filled) bubble has a low mean → high fill ratio.
        //   fill = (globalMean - bubbleMean) / globalMean  clamped to [0, 1]
        const fills = means.map((m) => Math.max(0, Math.min(1, (globalMean - m) / globalMean)));

        const maxFill = Math.max(...fills);
        const opts = cfg.options;

        if (maxFill < cfg.fillThreshold) {
          answers[String(qNum)] = '';
          details.push({
            question: qNum,
            detected: null,
            status: 'blank',
            fills: this.zipFills(opts, fills),
          });
          continue;
        }

        const bestIdx = fills.indexOf(maxFill);

        // Check for multiple heavily-filled bubbles
        const heavy = fills.filter(
          (f, i) =>
            i !== bestIdx &&
            f >= cfg.fillThreshold &&
            f >= maxFill / cfg.darknessDifferential,
        );

        const detected = opts[bestIdx];
        const status = heavy.length > 0 ? 'multiple' : 'answered';
        answers[String(qNum)] = detected;
        details.push({
          question: qNum,
          detected,
          status,
          fills: this.zipFills(opts, fills),
        });
      }
    }

    const answeredCount = details.filter((d) => d.status === 'answered').length;
    const total = Math.max(1, details.length);
    const confidence = Math.min(0.95, 0.2 + (answeredCount / total) * 0.75);

    // Detect student ID from bubble grid
    const detectedStudentId = this.detectStudentId(
      grayBuf as Buffer,
      w,
      h,
      Math.max(1, Math.min(12, numIdDigits)),
      globalMean,
    );

    const version = this.decodeVersionCode(grayBuf as Buffer, w, h, globalMean);

    this.logger.log(
      `Node grader done: ${answeredCount}/${total} answered, conf=${confidence.toFixed(2)}, studentId=${detectedStudentId}, version=${version.value ?? 'unknown'}`,
    );

    return {
      answers,
      confidence: Math.round(confidence * 1000) / 1000,
      decodedFormId: version.value,
      questionDetails: details,
      // Return null only if every digit is blank, otherwise keep partial result
      detectedStudentId: /^_+$/.test(detectedStudentId) ? null : detectedStudentId || null,
      debug: {
        grader: 'node-sharp',
        radiusPx,
        globalMean: Math.round(globalMean),
        answeredCount,
        totalQuestions: total,
        detectedStudentId,
        versionCode: version,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Paper-version marker decoding
  //
  // Slot 0 is always printed, so it doubles as a calibration mark: we search a
  // small window around its nominal position, then read the remaining slots at
  // the same offset.
  // -------------------------------------------------------------------------
  private decodeVersionCode(
    gray: Buffer,
    w: number,
    h: number,
    globalMean: number,
  ): { value: number | null; fills: number[]; offsetPx: [number, number] } {
    const cfg = SHEET_CONFIG.versionCode;
    const radius = Math.max(3, Math.round(cfg.sampleHalf * w));
    const nominalX = Math.round(cfg.centerX * w);
    const nominalY = Math.round(cfg.firstCenterY * h);
    const searchX = Math.max(4, Math.round(0.012 * w));
    const searchY = Math.max(4, Math.round(0.012 * h));
    const step = Math.max(2, Math.round(radius / 2));

    const fillAt = (cx: number, cy: number) => {
      if (cx < radius || cy < radius || cx >= w - radius || cy >= h - radius) {
        return 0;
      }
      const mean = this.sampleMean(gray, w, h, cx, cy, radius);
      return Math.max(0, Math.min(1, (globalMean - mean) / globalMean));
    };

    let bestFill = 0;
    let offsetX = 0;
    let offsetY = 0;
    for (let dy = -searchY; dy <= searchY; dy += step) {
      for (let dx = -searchX; dx <= searchX; dx += step) {
        const fill = fillAt(nominalX + dx, nominalY + dy);
        if (fill > bestFill) {
          bestFill = fill;
          offsetX = dx;
          offsetY = dy;
        }
      }
    }

    const pitchPx = cfg.slotPitch * h;
    const fills: number[] = [];
    for (let slot = 0; slot < cfg.totalSlots; slot += 1) {
      fills.push(
        fillAt(nominalX + offsetX, Math.round(nominalY + offsetY + slot * pitchPx)),
      );
    }

    const marked = fills.map((fill) => fill >= cfg.fillThreshold);
    const rounded = fills.map((fill) => Math.round(fill * 1000) / 1000);

    // Start mark missing -> the sheet predates the marker or the strip is unreadable
    if (!marked[0]) {
      return { value: null, fills: rounded, offsetPx: [offsetX, offsetY] };
    }

    const dataBits = marked.slice(1, 1 + cfg.dataBits);
    const parityExpected = dataBits.filter(Boolean).length % 2 === 1;
    if (marked[1 + cfg.dataBits] !== parityExpected) {
      return { value: null, fills: rounded, offsetPx: [offsetX, offsetY] };
    }

    const value = dataBits.reduce((acc, bit) => (acc << 1) | (bit ? 1 : 0), 0);

    return {
      value: value > 0 ? value : null,
      fills: rounded,
      offsetPx: [offsetX, offsetY],
    };
  }

  // -------------------------------------------------------------------------
  // Student ID detection from bubble grid
  // -------------------------------------------------------------------------
  private findStudentIdBlobs(
    gray: Buffer,
    w: number,
    h: number,
    globalMean: number,
  ): Array<{ x: number; y: number; area: number }> {
    // Left edge starts right of the version-code strip (ends at 0.143 w) so its
    // solid squares are never mistaken for filled ID bubbles.
    const x0 = Math.floor(0.17 * w);
    const x1 = Math.floor(0.32 * w);
    const y0 = Math.floor(0.08 * h);
    const y1 = Math.floor(0.36 * h);
    const thresh = globalMean * 0.72;
    const visited = new Uint8Array(w * h);
    const blobs: Array<{ x: number; y: number; area: number }> = [];

    const idx = (x: number, y: number) => y * w + x;
    const isDark = (x: number, y: number) => gray[idx(x, y)] < thresh;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = idx(x, y);
        if (visited[i] || !isDark(x, y)) continue;

        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let sumX = 0;
        let sumY = 0;
        let area = 0;
        const stack: Array<[number, number]> = [[x, y]];
        visited[i] = 1;

        while (stack.length > 0) {
          const [cx, cy] = stack.pop()!;
          sumX += cx;
          sumY += cy;
          area++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          for (const [nx, ny] of [
            [cx - 1, cy],
            [cx + 1, cy],
            [cx, cy - 1],
            [cx, cy + 1],
          ] as const) {
            if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
            const ni = idx(nx, ny);
            if (!visited[ni] && isDark(nx, ny)) {
              visited[ni] = 1;
              stack.push([nx, ny]);
            }
          }
        }

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
        if (area < 50 || area > 650 || aspect > 2.2) continue;

        blobs.push({ x: sumX / area, y: sumY / area, area });
      }
    }

    blobs.sort((a, b) => a.x - b.x);
    return blobs;
  }

  private detectStudentId(
    gray: Buffer,
    w: number,
    h: number,
    numDigits: number,
    globalMean: number,
  ): string {
    const cfg = SHEET_CONFIG.studentIdGrid;
    const R = Math.max(4, Math.round(cfg.bubbleRadius * w));
    const numRows = cfg.rowDigits.length;
    const cols = Math.max(1, Math.min(12, numDigits));
    const fillThreshold = 0.15;

    const colPitchPx = Math.round(cfg.digitGap * w);
    const rowPitchPx = Math.round(cfg.rowGap * h);
    const halfX = Math.max(2, Math.round(colPitchPx * 0.5));
    const halfY = Math.max(2, Math.round(rowPitchPx * 0.5));
    const step = Math.max(2, Math.round(R / 2));

    const peakFillAt = (cx: number, cy: number): number => {
      let peak = 0;
      for (let dy = -halfY; dy <= halfY; dy += step) {
        for (let dx = -halfX; dx <= halfX; dx += step) {
          const px = cx + dx;
          const py = cy + dy;
          if (px < R || py < R || px >= w - R || py >= h - R) continue;
          const mean = this.sampleMean(gray, w, h, px, py, R);
          const fill = Math.max(0, (globalMean - mean) / globalMean);
          if (fill > peak) peak = fill;
        }
      }
      return peak;
    };

    const readGrid = (
      xs: number,
      ys: number,
      colGapPx: number,
      rowGapPx: number,
    ): { id: string; blanks: number; totalFill: number } => {
      let id = '';
      let totalFill = 0;
      for (let col = 0; col < cols; col++) {
        const cx = Math.round(xs + col * colGapPx);
        let bestFill = 0;
        let bestRow = -1;
        for (let row = 0; row < numRows; row++) {
          const cy = Math.round(ys + row * rowGapPx);
          const fill = peakFillAt(cx, cy);
          if (fill > bestFill) {
            bestFill = fill;
            bestRow = row;
          }
        }
        if (bestFill >= fillThreshold && bestRow >= 0) {
          id += cfg.rowDigits[bestRow];
          totalFill += bestFill;
        } else {
          id += '_';
        }
      }
      return { id, blanks: (id.match(/_/g) ?? []).length, totalFill };
    };

    const scoreId = (id: string): [number, number, number] => {
      const blanks = (id.match(/_/g) ?? []).length;
      const filled = cols - blanks;
      let diag = 0;
      for (let i = 0; i < id.length && i < cfg.rowDigits.length; i++) {
        if (id[i] === cfg.rowDigits[i]) diag++;
      }
      return [blanks, -filled, -diag];
    };

    type Candidate = { id: string; blanks: number; score: [number, number, number] };
    const candidates: Candidate[] = [];

    const nomXs = cfg.digitStartX * w;
    const nomYs = cfg.gridTopY * h;

    // Method 1: blob-calibrated grid
    const blobs = this.findStudentIdBlobs(gray, w, h, globalMean);
    if (blobs.length >= 2) {
      const dxs: number[] = [];
      const dys: number[] = [];
      for (let i = 0; i < blobs.length - 1; i++) {
        dxs.push(blobs[i + 1].x - blobs[i].x);
        dys.push(blobs[i + 1].y - blobs[i].y);
      }
      const goodDxs = dxs.filter((d) => d >= 15 && d <= 42);
      const goodDys = dys.filter((d) => d >= 18 && d <= 72);
      const estColGap = goodDxs.length
        ? goodDxs.sort((a, b) => a - b)[Math.floor(goodDxs.length / 2)]
        : colPitchPx;
      const estRowGap = goodDys.length
        ? goodDys.sort((a, b) => a - b)[Math.floor(goodDys.length / 2)]
        : rowPitchPx;

      for (let startIdx = 0; startIdx < Math.min(3, blobs.length); startIdx++) {
        const { x: bx, y: by } = blobs[startIdx];
        for (let col0 = 0; col0 < 3; col0++) {
          for (let row0 = 0; row0 < 3; row0++) {
            const xs = bx - col0 * estColGap;
            const ys = by - row0 * estRowGap;
            if (xs < 40 || ys < 60) continue;
            const { id, blanks } = readGrid(xs, ys, estColGap, estRowGap);
            candidates.push({ id, blanks, score: scoreId(id) });
          }
        }
      }
    }

    const blobPerfect = candidates.some((c) => c.blanks === 0);

    // Method 2: 2-D shift search (skip if blob found all digits)
    if (!blobPerfect) {
      for (let xSh = -5; xSh <= 1; xSh += 0.5) {
        for (let ySh = -6; ySh <= 1; ySh += 0.5) {
          const xs = nomXs + xSh * colPitchPx;
          const ys = nomYs + ySh * rowPitchPx;
          if (xs < 40 || ys < 60) continue;
          const { id, blanks } = readGrid(xs, ys, colPitchPx, rowPitchPx);
          candidates.push({ id, blanks, score: scoreId(id) });
        }
      }
    }

    if (candidates.length === 0) return '_'.repeat(cols);

    candidates.sort((a, b) => {
      if (a.score[0] !== b.score[0]) return a.score[0] - b.score[0];
      if (a.score[1] !== b.score[1]) return a.score[1] - b.score[1];
      return a.score[2] - b.score[2];
    });

    return candidates[0].id;
  }

  // -------------------------------------------------------------------------
  // Per-bubble mean intensity sampling (circular ROI)
  // -------------------------------------------------------------------------
  private sampleMean(
    gray: Buffer,
    w: number,
    h: number,
    cx: number,
    cy: number,
    radius: number,
  ): number {
    const r2 = radius * radius;
    let sum = 0;
    let count = 0;

    const x0 = Math.max(0, cx - radius);
    const y0 = Math.max(0, cy - radius);
    const x1 = Math.min(w - 1, cx + radius);
    const y1 = Math.min(h - 1, cy + radius);

    for (let py = y0; py <= y1; py++) {
      const dy2 = (py - cy) * (py - cy);
      for (let px = x0; px <= x1; px++) {
        if ((px - cx) * (px - cx) + dy2 <= r2) {
          sum += gray[py * w + px];
          count++;
        }
      }
    }

    return count > 0 ? sum / count : 255;
  }

  private zipFills(opts: readonly string[], fills: number[]): Record<string, number> {
    const out: Record<string, number> = {};
    opts.forEach((o, i) => {
      out[o] = Math.round(fills[i] * 1000) / 1000;
    });
    return out;
  }
}
