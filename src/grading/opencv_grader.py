#!/usr/bin/env python3
"""
GradX ZipGrade-style OMR grading engine.

Usage:
    python3 opencv_grader.py <image_path> [<config_json>]

Output (stdout):
    JSON object with keys: answers, confidence, decodedFormId, questionDetails, debug
"""

import json
import os
import re
import sys
import math

# Tesseract spawns one OpenMP thread per core; on small servers that only adds
# contention (measured: 22.8 s → 12.1 s for a full grade on a 1-vCPU host).
os.environ.setdefault("OMP_THREAD_LIMIT", "1")

# ---------------------------------------------------------------------------
# Default sheet config (mirrors sheet-config.ts)
# ---------------------------------------------------------------------------
DEFAULT_CONFIG = {
    # Expected registration mark centres in full-page normalised coords
    # Mark TL (8, 12) + half 2.25 → (10.25, 14.25) / (210, 297)
    "inputAnchors": {
        "topLeft":     {"x": 0.0488, "y": 0.0480},
        "topRight":    {"x": 0.9512, "y": 0.0480},
        "bottomLeft":  {"x": 0.0488, "y": 0.7349},
        "bottomRight": {"x": 0.9512, "y": 0.7349},
    },
    "anchorSearchHalf": 0.12,
    # Warp target: A4 ratio 1000 × 1414
    "warpWidth":  1000,
    "warpHeight": 1414,
    # Warp DESTINATION of each anchor in the output image
    # (same normalised coords × output size)
    "anchorDst": {
        "topLeft":     {"x": 0.0488, "y": 0.0480},
        "topRight":    {"x": 0.9512, "y": 0.0480},
        "bottomLeft":  {"x": 0.0488, "y": 0.7349},
        "bottomRight": {"x": 0.9512, "y": 0.7349},
    },
    "answerGrid": {
        "columns": [
            {"startQuestion": 1,  "count": 10, "bubbleAX": 0.4524, "rowYStart": 0.2071},
            {"startQuestion": 11, "count": 10, "bubbleAX": 0.7190, "rowYStart": 0.2071},
            {"startQuestion": 21, "count": 10, "bubbleAX": 0.1857, "rowYStart": 0.4764},
            {"startQuestion": 31, "count": 10, "bubbleAX": 0.4524, "rowYStart": 0.4764},
            {"startQuestion": 41, "count": 10, "bubbleAX": 0.7190, "rowYStart": 0.4764},
        ],
        "options": ["A", "B", "C", "D", "E"],
        "bubbleXStep": 0.02619,   # 5.5 / 210
        "rowYStep":    0.02525,   # 7.5 / 297
        "bubbleRadius": 0.01048,  # 2.2 / 210  — tight circle, no inflation
        "fillThreshold": 0.28,
        "darknessDifferential": 1.5,
    },
    # Machine-readable paper-version marker (mirrors sheet-config.ts versionCode).
    # Solid 4 mm squares: slot 0 = start mark, slots 1-4 = version bits (MSB
    # first), slot 5 = even parity. Replaces the old visible Key Version column.
    "versionCode": {
        "centerX": 0.04881,       # 10.25 / 210 (aligned with left marks)
        "firstCenterY": 0.22222,  # 66 / 297
        "slotPitch": 0.03367,     # 10 / 297
        "sampleHalf": 0.00952,    # 2 / 210
        "totalSlots": 6,
        "dataBits": 4,
        "fillThreshold": 0.35,
    },
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def merge_config(base: dict, override: dict) -> dict:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_config(result[key], value)
        else:
            result[key] = value
    return result


# ---------------------------------------------------------------------------
# Perspective warp
# ---------------------------------------------------------------------------

def find_corner_anchor(gray, np, x0, y0, x1, y1, prefer="any", thr=None, near=None):
    """
    Find the centre of the darkest square-ish blob in the given ROI.

    prefer:
      'top'    — bias toward the highest marks (true top registration squares)
      'bottom' — bias toward the lowest marks (avoids left mid-page / version squares)
      'any'    — pure shape confidence

    Filled answer bubbles and letter glyphs (e.g. the X in GradeX) are rejected
    via circularity / low squareness so they cannot steal the bottom corners.
    """
    roi = gray[y0:y1, x0:x1]
    if roi.size == 0:
        return ((x0 + x1) // 2, (y0 + y1) // 2, 0.0)

    try:
        import cv2
    except ImportError:
        return ((x0 + x1) // 2, (y0 + y1) // 2, 0.0)

    if thr is None:
        thr = 90
    _, thresh = cv2.threshold(roi, thr, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    best_centre = ((x0 + x1) // 2, (y0 + y1) // 2)
    best_conf = 0.0
    roi_area = roi.shape[0] * roi.shape[1]
    box_h = max(1, y1 - y0)
    box_w = max(1, x1 - x0)

    # Printed squares are 6.5 mm (older sheets: 4.5 mm). Their pixel size scales
    # with the photo, so the size cap follows the image width (a 6.5 mm square
    # is ~3 % of a page-wide photo) instead of a fixed pixel count.
    max_side = max(55, int(0.05 * gray.shape[1]))
    max_area = max(2500, max_side * max_side)

    for cnt in contours:
        area = cv2.contourArea(cnt)
        # Registration marks are small solid squares — reject huge dark regions.
        if area < 20 or area > min(roi_area * 0.25, max_area):
            continue
        rx, ry, rw, rh = cv2.boundingRect(cnt)
        if rw == 0 or rh == 0:
            continue
        # Reject long thin noise / huge blobs.
        if max(rw, rh) > max_side or min(rw, rh) < 8:
            continue
        aspect = max(rw, rh) / min(rw, rh)
        if aspect > 1.45:
            continue
        squareness = 1.0 - abs(rw - rh) / max(rw, rh)
        if squareness < 0.72:
            continue
        fill_in_rect = area / (rw * rh) if rw * rh > 0 else 0
        if fill_in_rect < 0.55:
            continue
        # Bottom ROIs overlap answer bubbles — reject near-circles there.
        # Top marks at phone resolution can look almost circular; keep them.
        peri = cv2.arcLength(cnt, True)
        if peri > 1e-3 and prefer == "bottom":
            circularity = float(4.0 * np.pi * area / (peri * peri))
            if circularity > 0.82:
                continue
        shape_conf = squareness * 0.55 + fill_in_rect * 0.45
        cy = y0 + ry + rh // 2
        cx = x0 + rx + rw // 2
        y_frac = (cy - y0) / box_h
        x_frac = (cx - x0) / box_w
        if prefer == "bottom":
            conf = shape_conf * 0.6 + y_frac * 0.4
        elif prefer == "top":
            conf = shape_conf * 0.6 + (1.0 - y_frac) * 0.4
        else:
            conf = shape_conf
        if near is not None:
            # Device hint: the real mark is the square closest to it.
            d_near = ((cx - near[0]) ** 2 + (cy - near[1]) ** 2) ** 0.5
            conf = shape_conf - 0.8 * d_near / max(1.0, 0.5 * max(box_w, box_h))
        # Prefer marks near the outer edge of the search box.
        if prefer == "bottom":
            edge_bonus = (1.0 - x_frac) if x0 < gray.shape[1] * 0.3 else x_frac
            conf += 0.12 * edge_bonus
        if conf > best_conf:
            best_conf = conf
            best_centre = (cx, cy)

    return (*best_centre, best_conf)


def _perspective_warp_once(cv2, np, image, config, use_hints=True):
    """
    Detect the 4 corner registration marks and warp so marks land at their
    expected full-page positions in the output (1000 × 1414).

    The search window is intentionally wide (±30 % of image dimension) so that
    images with non-A4 aspect ratios or partial crops are still handled correctly.
    The old "anchors_reliable" proximity check has been removed: when the camera
    captures a portrait sheet in landscape or with a margin cut off, the anchors
    appear far from their A4-normalised expected positions — but the homography
    is still valid and should be applied.
    """
    h, w = image.shape[:2]
    out_w = config.get("warpWidth",  1000)
    out_h = config.get("warpHeight", 1414)

    ia = config.get("inputAnchors", DEFAULT_CONFIG["inputAnchors"])
    ad = config.get("anchorDst",    DEFAULT_CONFIG.get("anchorDst", ia))

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image.copy()

    corner_names = ["topLeft", "topRight", "bottomLeft", "bottomRight"]
    found_src  = []
    found_dst  = []
    total_conf = 0.0

    # Search in the CORNER QUADRANTS of the actual image.
    #
    # GradX answer sheet registration mark Y positions (fraction of 297 mm page):
    #   Top marks    (8/197.5 mm, 12 mm)   → y ≈  4.8 %  → top strip  [0,   20%] ✓
    #   Bottom marks (8/197.5 mm, 216 mm)  → y ≈ 72.7 %  → MUST search from 60 %
    #   Middle marks (18 mm, 140 mm) etc. → y ≈ 47–59 %  → excluded by 60 % floor
    #
    # The bottom marks at 72.7 % would be MISSED by the old [80 %, 100 %] window.
    # All intermediate marks (left side at 47 %, right side at 47–59 %) stay
    # below the 60 % floor and are therefore excluded automatically.
    # Keep bottom boxes narrow so answer bubbles / GradeX logo cannot win.
    # Bottom marks sit ~73% down the page — stop before the footer logo band.
    corner_search_boxes = {
        "topLeft":     (0,           0,            int(0.18 * w), int(0.18 * h)),
        "topRight":    (int(0.82 * w), 0,          w,            int(0.18 * h)),
        "bottomLeft":  (0,           int(0.62 * h), int(0.12 * w), int(0.92 * h)),
        "bottomRight": (int(0.88 * w), int(0.62 * h), w,         int(0.92 * h)),
    }

    # The mobile scanner sends the registration-mark centres it measured in
    # its fixed viewfinder windows (six squares of the right size, planar,
    # steady). Those are far more reliable than a blind corner search that can
    # lock onto answer bubbles or the logo, so a hint inside the image wins:
    # we only refine it to sub-pixel accuracy on the full-resolution photo.
    hints = (config.get("anchorHints") or {}) if use_hints else {}
    hint_half = int(0.03 * max(w, h))

    anchor_debug = {}
    for name in corner_names:
        x0, y0, x1, y1 = corner_search_boxes[name]
        prefer = "top" if name.startswith("top") else "bottom"

        fx, fy, conf = find_corner_anchor(gray, np, x0, y0, x1, y1, prefer=prefer)
        source = "auto"
        hint = hints.get(name)
        try:
            hx = int(float(hint["x"]) * w) if hint else None
            hy = int(float(hint["y"]) * h) if hint else None
        except (KeyError, TypeError, ValueError):
            hx = hy = None
        if hx is not None and 0 < hx < w and 0 < hy < h:
            wx0, wy0 = max(0, hx - hint_half), max(0, hy - hint_half)
            wx1, wy1 = min(w, hx + hint_half), min(h, hy + hint_half)
            window = gray[wy0:wy1, wx0:wx1]
            # Local threshold: halfway between the paper and the dark square
            # keeps dim / shadowed photos from losing the mark.
            local_thr = 90
            if window.size > 0:
                lo = float(np.percentile(window, 2))
                mid = float(np.percentile(window, 60))
                local_thr = int(max(60, min(150, (lo + mid) / 2.0)))
            hfx, hfy, hconf = find_corner_anchor(
                gray, np, wx0, wy0, wx1, wy1, prefer="any", thr=local_thr, near=(hx, hy),
            )
            if hconf >= 0.45 and math.hypot(hfx - hx, hfy - hy) <= hint_half:
                fx, fy, conf, source = hfx, hfy, max(hconf, 0.6), "hint_refined"
            else:
                fx, fy, conf, source = hx, hy, max(conf, 0.5), "hint_raw"
        found_src.append([fx, fy])

        # Destination: expected position in output (full-page coords)
        dx = int(ad[name]["x"] * out_w)
        dy = int(ad[name]["y"] * out_h)
        found_dst.append([dx, dy])
        total_conf += conf
        anchor_debug[name] = {
            "src": [fx, fy],
            "src_norm": [round(fx/w, 3), round(fy/h, 3)],
            "dst": [dx, dy],
            "conf": round(conf, 3),
            "source": source,
        }

    warp_conf = total_conf / 4.0
    corner_confs = [float(anchor_debug[n]["conf"]) for n in corner_names]
    min_corner_conf = min(corner_confs) if corner_confs else 0.0

    # Geometric sanity check: the detected quadrilateral must not be degenerate.
    # We verify that top anchors are above bottom anchors and left anchors are
    # left of right anchors — regardless of how far they are from A4-normalised
    # expected positions (which will be wrong for non-A4 images).
    tl, tr, bl, br = found_src
    quad_valid = (
        tl[1] < bl[1] and tr[1] < br[1] and  # tops above bottoms
        tl[0] < tr[0] and bl[0] < br[0] and  # lefts left of rights
        warp_conf > 0.25
        # A single failed corner (conf≈0) skews the ID grid into garbage reads
        # like 444332208 instead of 443206950 — prefer a plain resize then.
        and min_corner_conf >= 0.35
    )

    if quad_valid:
        M = cv2.getPerspectiveTransform(np.float32(found_src), np.float32(found_dst))
        warped = cv2.warpPerspective(image, M, (out_w, out_h))
        warp_applied = True
    else:
        # Fallback: plain resize. Mobile already crops to the page, so this
        # keeps bubble geometry intact when a corner mark was missed.
        warped = cv2.resize(image, (out_w, out_h))
        warp_conf = max(0.10, min_corner_conf)
        warp_applied = False
        anchor_debug["fallback"] = "resize_low_corner_confidence"

    return warped, warp_conf, warp_applied, anchor_debug


def middle_marks_found(cv2, np, warped, config):
    """
    Count (0-2) how many of the two middle registration squares sit where a
    correct warp puts them. The middle marks are not used to compute the warp,
    so they independently validate it.
    """
    out_h, out_w = warped.shape[:2]
    ad = config.get("anchorDst", DEFAULT_CONFIG.get("anchorDst", config.get("inputAnchors")))
    try:
        frac = 128.0 / 204.0
        mid_y = (ad["topLeft"]["y"] + (ad["bottomLeft"]["y"] - ad["topLeft"]["y"]) * frac) * out_h
        xs = [ad["topLeft"]["x"] * out_w, ad["topRight"]["x"] * out_w]
    except (KeyError, TypeError):
        return 2
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) if len(warped.shape) == 3 else warped
    half = max(20, int(0.035 * out_w))
    found = 0
    for mx in xs:
        x0, y0 = max(0, int(mx) - half), max(0, int(mid_y) - half)
        x1, y1 = min(out_w, int(mx) + half), min(out_h, int(mid_y) + half)
        window = gray[y0:y1, x0:x1]
        if window.size == 0:
            continue
        lo = float(np.percentile(window, 2))
        mid = float(np.percentile(window, 60))
        thr = int(max(60, min(150, (lo + mid) / 2.0)))
        cx, cy, conf = find_corner_anchor(
            gray, np, x0, y0, x1, y1, prefer="any", thr=thr, near=(mx, mid_y),
        )
        if conf >= 0.45 and math.hypot(cx - mx, cy - mid_y) <= 0.02 * out_w:
            found += 1
    return found


def perspective_warp(cv2, np, image, config):
    """
    Warp the sheet upright. Device-measured mark centres (`anchorHints`) are
    preferred; the warp is then verified with the two middle marks, which the
    homography does not use. If that check fails the blind corner search is
    tried instead and the better-verified warp wins.
    """
    result = _perspective_warp_once(cv2, np, image, config, use_hints=True)
    if not config.get("anchorHints"):
        return result

    warped, _conf, applied, debug = result
    hinted_mid = middle_marks_found(cv2, np, warped, config) if applied else 0
    debug["middleMarks"] = hinted_mid
    if hinted_mid >= 2:
        return result

    alt = _perspective_warp_once(cv2, np, image, config, use_hints=False)
    alt_mid = middle_marks_found(cv2, np, alt[0], config) if alt[2] else 0
    alt[3]["middleMarks"] = alt_mid
    if alt_mid > hinted_mid:
        alt[3]["warpFrom"] = "auto_after_hint_check_failed"
        return alt
    return result


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------

def preprocess(cv2, np, image):
    """Grayscale → combined OTSU + adaptive threshold → binary (dark pixels = 255)."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image.copy()
    # OTSU global threshold
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # Adaptive Gaussian threshold to handle local lighting differences
    adaptive = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        35, 8,
    )
    binary = cv2.bitwise_or(otsu, adaptive)
    # Light denoise
    kernel = np.ones((2, 2), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    return binary


def ink_darkness_map(cv2, np, image):
    """
    Per-pixel ink darkness in [0, 1] relative to the surrounding paper.

    Uses the darkest colour channel so coloured ink (red, pink, blue pen)
    counts like pencil, and divides by a local paper estimate so shadows and
    screen glare do not read as marks. A global binary threshold cannot do
    this: mid-tone ink (pink, light pencil) falls on the "paper" side of Otsu.
    Low-contrast / unclear photos get a mild percentile stretch so faint
    graphite still separates from paper.
    """
    darkest = image.min(axis=2) if image.ndim == 3 else image
    darkest = darkest.astype(np.float32)
    k = max(15, int(image.shape[1] * 0.06)) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    paper = cv2.morphologyEx(darkest, cv2.MORPH_CLOSE, kernel)
    paper = cv2.GaussianBlur(paper, (k, k), 0)
    darkness = np.clip((paper - darkest) / np.maximum(paper, 1.0), 0.0, 1.0)
    p2, p98 = np.percentile(darkness, [2, 98])
    span = float(p98 - p2)
    if span < 0.22:
        # Flat lighting / phone glare: stretch the useful ink range.
        darkness = np.clip((darkness - float(p2)) / max(span, 1e-3), 0.0, 1.0)
    return darkness


def paper_ink_contrast(np, gray_u8):
    """
    How far the printed ink sits below the paper (0..255): the paper level
    (75th percentile) minus the darkest 1 % of pixels.

    The old p95 - p5 span measured how much of the page is covered by ink, not
    how strong it is: a short quiz with few bubbles reads as "low contrast"
    even in a perfect photo. Paper-vs-ink does not depend on how full the sheet
    is (healthy scans of every length sit at 125-215; a washed-out print or a
    dim room drops it).
    """
    p1, p75 = np.percentile(gray_u8, [1, 75])
    return float(p75 - p1)


def estimate_sheet_quality(cv2, np, image):
    """
    Cheap blur / contrast / resolution heuristics for adapting bubble thresholds.
    Low laplacian variance → soft/blurry capture; low grey span → flat light;
    small pixel size → phone thumbnail / far capture.
    """
    gray = (
        cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        if len(image.shape) == 3
        else image
    )
    if gray.dtype != np.uint8:
        gray_u8 = np.clip(gray, 0, 255).astype(np.uint8)
    else:
        gray_u8 = gray
    h, w = gray_u8.shape[:2]
    lap = float(cv2.Laplacian(gray_u8, cv2.CV_64F).var())
    contrast = paper_ink_contrast(np, gray_u8)
    blurry = lap < 90.0
    low_contrast = contrast < MIN_CONTRAST
    low_res = min(w, h) < 900
    return {
        "laplacian": round(lap, 1),
        "contrast": round(contrast, 1),
        "width": int(w),
        "height": int(h),
        "blurry": blurry,
        "lowContrast": low_contrast,
        "lowRes": low_res,
        "degraded": blurry or low_contrast or low_res,
    }


def registration_marks_check(cv2, np, gray, config):
    """
    Independent geometry check on the image the bubbles are read from: do the
    six printed registration squares (4 corners + 2 middles) sit where this
    geometry says they should? A correct read has all of them within a few px;
    a missed corner, a partial page or a bad warp leaves several off / missing.
    """
    out_h, out_w = gray.shape[:2]
    ad = config.get("anchorDst", DEFAULT_CONFIG.get("anchorDst", config.get("inputAnchors")))
    try:
        frac = 128.0 / 204.0
        top_y = ad["topLeft"]["y"]
        bottom_y = ad["bottomLeft"]["y"]
        mid_y = top_y + (bottom_y - top_y) * frac
        expected = [
            (ad["topLeft"]["x"], ad["topLeft"]["y"]),
            (ad["topRight"]["x"], ad["topRight"]["y"]),
            (ad["bottomLeft"]["x"], ad["bottomLeft"]["y"]),
            (ad["bottomRight"]["x"], ad["bottomRight"]["y"]),
            (ad["topLeft"]["x"], mid_y),
            (ad["topRight"]["x"], mid_y),
        ]
    except (KeyError, TypeError):
        return {"found": 6, "total": 6, "maxDev": 0.0, "devs": []}
    half = max(20, int(0.035 * out_w))
    tol = 0.022 * out_w
    devs = []
    found = 0
    for ex, ey in expected:
        mx, my = ex * out_w, ey * out_h
        x0, y0 = max(0, int(mx) - half), max(0, int(my) - half)
        x1, y1 = min(out_w, int(mx) + half), min(out_h, int(my) + half)
        window = gray[y0:y1, x0:x1]
        if window.size == 0:
            devs.append(None)
            continue
        lo = float(np.percentile(window, 2))
        mid = float(np.percentile(window, 60))
        thr = int(max(60, min(150, (lo + mid) / 2.0)))
        cx, cy, conf = find_corner_anchor(
            gray, np, x0, y0, x1, y1, prefer="any", thr=thr, near=(mx, my),
        )
        dev = math.hypot(cx - mx, cy - my)
        if conf >= 0.45 and dev <= tol:
            found += 1
            devs.append(round(dev, 1))
        else:
            devs.append(None)
    seen = [d for d in devs if d is not None]
    return {
        "found": found,
        "total": len(expected),
        "maxDev": round(max(seen), 1) if seen else None,
        "devs": devs,
    }


def sharpness_metrics(cv2, np, gray):
    """Edge sharpness (blur), contrast and lighting evenness of the sheet."""
    g8 = gray if gray.dtype == np.uint8 else np.clip(gray, 0, 255).astype(np.uint8)
    h, w = g8.shape[:2]
    # Stay clear of the image border: a warp fills the area outside the photo
    # with black, and that artificial edge would read as "sharp".
    top, bottom = int(0.045 * h), int(0.78 * h)
    margin = max(12, int(0.03 * w))
    region = g8[top:bottom, margin:w - margin]
    contrast = paper_ink_contrast(np, region)
    p5, p95 = np.percentile(region, [5, 95])
    # Edge strength is judged against the contrast the edge could reach. On a
    # sparse sheet p95 - p5 collapses (few ink pixels) and would inflate the
    # score, so never use less than ~80 % of the paper-vs-ink contrast.
    span_contrast = max(float(p95 - p5), 0.8 * contrast)
    gx = cv2.Sobel(region, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(region, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    edge = float(np.percentile(mag, 99.5))
    # Normalised by contrast: a crisp black/white edge gives ~constant, blur
    # spreads the edge over many px and drops it.
    sharp = edge / max(span_contrast, 1.0)
    k = max(15, int(w * 0.06)) | 1
    paper = cv2.morphologyEx(region, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    paper = cv2.resize(paper, (10, 14), interpolation=cv2.INTER_AREA).astype(np.float32)
    shade = 1.0 - float(paper.min()) / max(float(paper.max()), 1.0)
    return {
        "sharp": round(sharp, 3),
        "contrast": round(contrast, 1),
        "shade": round(shade, 3),
        "paperLevel": round(float(np.median(paper)), 1),
    }


def mean_in_disc(values, np, cx, cy, radius_px):
    """Mean of `values` inside a disc (0 when the disc is off the image)."""
    h, w = values.shape[:2]
    x0, y0 = max(0, cx - radius_px), max(0, cy - radius_px)
    x1, y1 = min(w, cx + radius_px + 1), min(h, cy + radius_px + 1)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    yy, xx = np.ogrid[y0:y1, x0:x1]
    disc = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius_px ** 2
    patch = values[y0:y1, x0:x1][disc]
    return float(patch.mean()) if patch.size else 0.0


_DISC_CACHE = {}


def _cached_maps(values):
    """Per-array cache of disc-mean maps (keeps a handful of arrays alive)."""
    key = id(values)
    entry = _DISC_CACHE.get(key)
    if entry is None or entry[0] is not values:
        if len(_DISC_CACHE) >= 4:
            _DISC_CACHE.pop(next(iter(_DISC_CACHE)))
        entry = (values, {})
        _DISC_CACHE[key] = entry
    return entry[1]


def _disc_mean_map(values, np, radius_px):
    """
    Mean of `values` inside a disc of `radius_px` centred on every pixel
    (discs are clipped at the image border, like `mean_in_disc`).

    One filter2D pass replaces tens of thousands of per-bubble numpy slices;
    the map is cached per (array, radius) because bubble sampling reuses it.
    """
    import cv2

    maps = _cached_maps(values)
    if radius_px not in maps:
        size = 2 * radius_px + 1
        yy, xx = np.ogrid[-radius_px:radius_px + 1, -radius_px:radius_px + 1]
        kernel = ((xx ** 2 + yy ** 2) <= radius_px ** 2).astype(np.float32)
        src = values.astype(np.float32)
        total = cv2.filter2D(src, -1, kernel, borderType=cv2.BORDER_CONSTANT)
        count = cv2.filter2D(
            np.ones(src.shape, np.float32), -1, kernel, borderType=cv2.BORDER_CONSTANT,
        )
        maps[radius_px] = total / np.maximum(count, 1.0)
    return maps[radius_px]


def peak_in_disc(values, np, cx, cy, radius_px, search_px=3, radius_scale=0.72):
    """
    Best interior-disc mean in a small search window.

    Handles slight warp / camera misalignment and soft bubble edges on
    low-quality photos. Samples a smaller radius so the printed ring / neighbour
    bleed contributes less than the filled core.
    """
    r_inner = max(3, int(radius_px * radius_scale))
    search = max(0, int(search_px))
    step = 1 if search <= 4 else 2
    mean_map = _disc_mean_map(values, np, r_inner)
    h, w = mean_map.shape[:2]
    ys = [cy + dy for dy in range(-search, search + 1, step) if 0 <= cy + dy < h]
    xs = [cx + dx for dx in range(-search, search + 1, step) if 0 <= cx + dx < w]
    if not ys or not xs:
        return 0.0
    return max(0.0, float(mean_map[np.ix_(ys, xs)].max()))


def _row_empty_baseline(raw):
    """Baseline from the emptiest options in a row (handles uneven lighting)."""
    if not raw:
        return 0.0
    ordered = sorted(raw)
    k = max(1, int(math.ceil(len(ordered) * 0.6)))
    return sum(ordered[:k]) / float(k)


def _calibrate_answer_offset(darkness, np, row_centres, radius_px, search_px=4):
    """
    Find a global (dx, dy) that maximises clear single-mark margins across rows.
    Compensates small perspective / crop drift common in mobile photos.

    Vectorised: the "best interior disc in a 3x3 window" value of every pixel is
    computed once (disc-mean map + 3x3 max filter), then each candidate offset
    is a pure array lookup instead of ~100 000 per-bubble numpy slices.
    """
    if not row_centres:
        return 0, 0
    import cv2

    r_inner = max(3, int(radius_px * 0.72))
    mean_map = _disc_mean_map(darkness, np, r_inner)
    peak_map = np.maximum(
        cv2.dilate(mean_map.astype(np.float32), np.ones((3, 3), np.uint8)), 0.0,
    )
    h, w = peak_map.shape[:2]
    by_len = {}
    for centres in row_centres:
        if len(centres) >= 2:
            by_len.setdefault(len(centres), []).append(centres)
    groups = [np.asarray(rows, dtype=np.int64) for rows in by_len.values()]

    def offset_score(dx, dy):
        score = 0.0
        for arr in groups:  # arr: (rows, options, 2)
            xs = arr[..., 0] + dx
            ys = arr[..., 1] + dy
            valid = (xs >= 0) & (xs < w) & (ys >= 0) & (ys < h)
            vals = np.where(
                valid,
                peak_map[np.clip(ys, 0, h - 1), np.clip(xs, 0, w - 1)],
                0.0,
            )
            top2 = np.partition(vals, vals.shape[1] - 2, axis=1)[:, -2:]
            score += float((top2[:, 1] - top2[:, 0]).sum())
        return score

    best_score = -1.0
    best_dx, best_dy = 0, 0
    # Coarse then refine — keep cost low on large sheets.
    for dy in range(-search_px, search_px + 1, 2):
        for dx in range(-search_px, search_px + 1, 2):
            score = offset_score(dx, dy)
            if score > best_score:
                best_score = score
                best_dx, best_dy = dx, dy
    # Fine search around the coarse winner.
    fine_best = best_score
    fine_dx, fine_dy = best_dx, best_dy
    for dy in range(best_dy - 1, best_dy + 2):
        for dx in range(best_dx - 1, best_dx + 2):
            if dx == best_dx and dy == best_dy:
                continue
            score = offset_score(dx, dy)
            if score > fine_best:
                fine_best = score
                fine_dx, fine_dy = dx, dy
    return fine_dx, fine_dy


# ---------------------------------------------------------------------------
# Bubble analysis
# ---------------------------------------------------------------------------

def sample_square(binary, x, y, half):
    """Return fill ratio (dark pixels / total) for a square ROI."""
    h, w = binary.shape
    x0 = max(0, x - half)
    y0 = max(0, y - half)
    x1 = min(w, x + half + 1)
    y1 = min(h, y + half + 1)
    if x1 <= x0 or y1 <= y0:
        return 0.0

    roi = binary[y0:y1, x0:x1]
    return float((roi > 0).sum()) / float(roi.size)


def decode_version_code(binary, config):
    """
    Decode the covert paper-version marker.

    Slot 0 is always printed, so it is used to calibrate a small positional
    offset before the remaining slots are read.
    Returns (version_or_none, debug_dict).
    """
    cfg = config.get("versionCode", DEFAULT_CONFIG["versionCode"])
    h, w = binary.shape
    half = max(3, int(cfg["sampleHalf"] * w))
    nominal_x = int(cfg["centerX"] * w)
    nominal_y = int(cfg["firstCenterY"] * h)
    search_x = max(4, int(0.012 * w))
    search_y = max(4, int(0.012 * h))
    step = max(2, half // 2)

    best_fill, offset_x, offset_y = 0.0, 0, 0
    for dy in range(-search_y, search_y + 1, step):
        for dx in range(-search_x, search_x + 1, step):
            fill = sample_square(binary, nominal_x + dx, nominal_y + dy, half)
            if fill > best_fill:
                best_fill, offset_x, offset_y = fill, dx, dy

    pitch = cfg["slotPitch"] * h
    fills = [
        sample_square(
            binary,
            nominal_x + offset_x,
            int(nominal_y + offset_y + slot * pitch),
            half,
        )
        for slot in range(int(cfg["totalSlots"]))
    ]
    marked = [fill >= cfg["fillThreshold"] for fill in fills]
    debug = {
        "fills": [round(f, 3) for f in fills],
        "offset": [offset_x, offset_y],
    }

    data_bits_count = int(cfg["dataBits"])
    if not marked[0]:
        return None, {**debug, "reason": "start_mark_missing"}

    data_bits = marked[1:1 + data_bits_count]
    parity_expected = sum(data_bits) % 2 == 1
    if marked[1 + data_bits_count] != parity_expected:
        return None, {**debug, "reason": "parity_mismatch"}

    value = 0
    for bit in data_bits:
        value = (value << 1) | (1 if bit else 0)

    return (value if value > 0 else None), debug


# Hand-drawn "X" over a bubble means "cancel this mark". Its strokes cross the
# printed ring and poke out into all four corners around the bubble, whereas a
# filled bubble only has ink inside the ring. Strokes are rarely on exact
# diagonals, so we look for ink in the ring-shaped zone around the bubble,
# split into four quadrants.
CROSS_ZONE_INNER = 1.40   # × bubble radius: just outside the printed ring
CROSS_ZONE_OUTER = 2.10   # × bubble radius: stays above/below neighbour rows
CROSS_NEIGHBOUR_CLEAR = 1.60  # × radius: ignore pixels on a neighbour's ring
CROSS_INK = 0.30          # darkness a stroke must reach to count as ink
CROSS_QUADRANTS_NEEDED = 3  # of the 4 corners must hold a stroke
CROSS_MAX_SHARE = 0.35    # more crossed bubbles than this → dirty photo, ignore


def detect_crossed_bubbles(cv2, np, darkness, rows, radius_px):
    """
    Find bubbles the student crossed out with an X.

    `rows` is a list of (question, options, centres). Returns the set of
    (row_index, option_index) pairs whose X strokes stick out of the ring in
    (at least) three of the four corners.
    """
    if not rows:
        return set()
    h, w = darkness.shape[:2]
    outer = int(math.ceil(CROSS_ZONE_OUTER * radius_px))
    span = np.arange(-outer, outer + 1)
    ox, oy = np.meshgrid(span, span)
    dist = np.sqrt(ox.astype(np.float32) ** 2 + oy.astype(np.float32) ** 2)
    zone = (dist >= CROSS_ZONE_INNER * radius_px) & (dist <= CROSS_ZONE_OUTER * radius_px)
    # Quadrants are split by the axes, so each corner of the X owns one.
    quadrants = [
        zone & (ox < 0) & (oy < 0),
        zone & (ox >= 0) & (oy < 0),
        zone & (ox < 0) & (oy >= 0),
        zone & (ox >= 0) & (oy >= 0),
    ]
    min_px = max(4, int(round(0.6 * radius_px)))
    clear2 = (CROSS_NEIGHBOUR_CLEAR * radius_px) ** 2
    # Every bubble on the sheet: a neighbour in the same row OR the rows
    # above / below can sit inside the zone on tightly packed layouts.
    all_centres = np.asarray(
        [c for _, _, centres in rows for c in centres], dtype=np.int64,
    ).reshape(-1, 2)
    near_limit2 = ((CROSS_ZONE_OUTER + CROSS_NEIGHBOUR_CLEAR) * radius_px) ** 2
    crossed = set()
    total = 0
    for row_i, (_, _, centres) in enumerate(rows):
        for opt_i, (cx, cy) in enumerate(centres):
            total += 1
            x0, y0 = cx - outer, cy - outer
            sx0, sy0 = max(0, x0), max(0, y0)
            sx1, sy1 = min(w, cx + outer + 1), min(h, cy + outer + 1)
            if sx1 <= sx0 or sy1 <= sy0:
                continue
            patch = darkness[sy0:sy1, sx0:sx1]
            ink = patch >= CROSS_INK
            if int(ink.sum()) < min_px:
                continue
            # Drop pixels that belong to a neighbouring bubble's ring.
            gx = ox[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] + cx
            gy = oy[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] + cy
            d2 = (all_centres[:, 0] - cx) ** 2 + (all_centres[:, 1] - cy) ** 2
            for nx, ny in all_centres[(d2 > 0) & (d2 <= near_limit2)]:
                ink &= ((gx - nx) ** 2 + (gy - ny) ** 2) > clear2
            hits = 0
            for quad in quadrants:
                q = quad[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0]
                if int((ink & q).sum()) >= min_px:
                    hits += 1
            if hits >= CROSS_QUADRANTS_NEEDED:
                crossed.add((row_i, opt_i))
    if total and len(crossed) > CROSS_MAX_SHARE * total:
        return set()
    return crossed


# Darkness above the empty-bubble baseline that counts as a fully filled
# bubble (pencil or pen on paper typically reaches 0.4-0.6).
FULL_INK_DARKNESS = 0.4
# Grid-offset search range (px) once the registration squares verified the warp.
TRUSTED_GRID_SEARCH_PX = 10


def analyze_answer_grid(darkness, np, config, quality=None):
    """
    Read every answer row from the ink-darkness map.

    A bubble's fill is how much darker its interior is than unmarked bubbles
    on the same row (handles uneven lighting), scaled so FULL_INK_DARKNESS
    reads as 1.0. On blurry / low-contrast / low-res photos we widen search,
    lower the fill threshold slightly, and calibrate a global grid offset so
    faint marks still register without inventing false multi-marks.
    """
    h, w = darkness.shape
    grid = config.get("answerGrid", DEFAULT_CONFIG["answerGrid"])
    options = grid.get("options", ["A", "B", "C", "D", "E"])
    x_step = grid.get("bubbleXStep", 0.03254)
    y_step = grid.get("rowYStep", 0.03676)
    b_radius_norm = grid.get("bubbleRadius", 0.01302)
    # Slightly higher than PDF default so faint graphite rings are not "answered".
    fill_thresh = float(grid.get("fillThreshold", 0.34))
    # Stronger separation: a second mark must be clearly filled to count as multi.
    diff_factor = float(grid.get("darknessDifferential", 1.55))
    quality = quality or {}
    degraded = bool(quality.get("degraded"))
    low_res = bool(quality.get("lowRes"))
    if degraded or low_res:
        fill_thresh = max(0.20, fill_thresh * 0.82)
        diff_factor = max(1.32, diff_factor * 0.94)
    else:
        # Sharp sheets: be a bit stricter to avoid false marks from print rings.
        fill_thresh = max(fill_thresh, 0.34)

    radius_px = max(4, int(b_radius_norm * w))
    search_px = 5 if (degraded or low_res) else 3
    # Clear single-mark margin: above this, accept the winner even if a neighbour
    # is also above fill_thresh (adjacent bleed / printed letter noise).
    clear_margin = 0.07 if (degraded or low_res) else 0.11
    soft_margin = 0.04 if (degraded or low_res) else 0.04

    # Build nominal centres first so we can calibrate a global offset.
    nominal_rows = []
    for col in grid.get("columns", []):
        start_q = col["startQuestion"]
        count = col["count"]
        bubble_ax = col["bubbleAX"]
        row_y_start = col["rowYStart"]
        col_x_step = col.get("bubbleXStep", x_step)
        col_y_step = col.get("rowYStep", y_step)
        col_options = col.get("options") or options
        row_labels = col.get("rowLabels") or []

        for row_i in range(count):
            q_num = start_q + row_i
            row_y_px = int((row_y_start + row_i * col_y_step) * h)
            row_options = (
                row_labels[row_i]
                if row_i < len(row_labels) and row_labels[row_i]
                else col_options
            )
            centres = [
                (int((bubble_ax + opt_i * col_x_step) * w), row_y_px)
                for opt_i in range(len(row_options))
            ]
            nominal_rows.append((q_num, row_options, centres))

    # Global offset: wide search — mobile photos often drift 10–60px after warp.
    # When the six printed squares already verified the warp, the true offset is
    # a few px: searching wider only lets the fit lock onto the NEXT bubble
    # (pitch ~38 px) on sheets with little ink.
    if config.get("_trustedGeometry"):
        calibration_search = TRUSTED_GRID_SEARCH_PX
    else:
        calibration_search = 28 if (degraded or low_res) else 18
    offset_dx, offset_dy = _calibrate_answer_offset(
        darkness, np,
        [centres for _, _, centres in nominal_rows],
        radius_px,
        search_px=calibration_search,
    )

    import cv2

    shifted_rows = [
        (q_num, row_options, [(cx + offset_dx, cy + offset_dy) for cx, cy in centres])
        for q_num, row_options, centres in nominal_rows
    ]
    crossed = detect_crossed_bubbles(cv2, np, darkness, shifted_rows, radius_px)

    rows = []
    crossed_by_row = []
    for row_i, (q_num, row_options, centres) in enumerate(shifted_rows):
        raw = [
            peak_in_disc(darkness, np, cx, cy, radius_px, search_px=search_px)
            for cx, cy in centres
        ]
        row_crossed = [i for i in range(len(raw)) if (row_i, i) in crossed]
        # A crossed-out bubble is cancelled: treat it as an empty bubble.
        kept = [v for i, v in enumerate(raw) if i not in row_crossed]
        if row_crossed and kept:
            empty = min(kept)
            raw = [empty if i in row_crossed else v for i, v in enumerate(raw)]
        elif row_crossed:
            raw = [0.0] * len(raw)
        rows.append((q_num, row_options, raw))
        crossed_by_row.append([row_options[i] for i in row_crossed])

    # Global floor from unmarked bubbles (sheet-wide lighting).
    all_raw = sorted(v for _, _, raw in rows for v in raw)
    global_baseline = all_raw[len(all_raw) // 4] if all_raw else 0.0

    # On degraded sheets, filled ink may be flatter — scale so the typical
    # strongest mark still sits near 1.0 without forcing blanks upward.
    peaks_above = []
    for _, _, raw in rows:
        base = max(global_baseline, _row_empty_baseline(raw))
        peaks_above.append(max(raw) - base if raw else 0.0)
    peaks_above.sort()
    typical_peak = peaks_above[int(len(peaks_above) * 0.75)] if peaks_above else FULL_INK_DARKNESS
    ink_scale = FULL_INK_DARKNESS
    if (degraded or low_res) and typical_peak > 0.08:
        ink_scale = max(0.20, min(FULL_INK_DARKNESS, typical_peak * 0.9))

    answers = {}
    details = []
    for row_i, (q_num, row_options, raw) in enumerate(rows):
        row_base = max(global_baseline * 0.85, _row_empty_baseline(raw))
        fills = [
            min(1.0, max(0.0, (v - row_base) / ink_scale)) for v in raw
        ]
        max_fill = max(fills) if fills else 0.0
        # List keeps the printed option order (JSON objects may be re-sorted).
        fill_info = {
            "fills": {opt: round(fills[i], 3) for i, opt in enumerate(row_options)},
            "options": list(row_options),
        }
        if crossed_by_row[row_i]:
            fill_info["crossedOut"] = crossed_by_row[row_i]

        if max_fill < fill_thresh:
            answers[str(q_num)] = ""
            details.append({
                "question": q_num,
                "detected": None,
                "status": "blank",
                **fill_info,
            })
            continue

        best_idx = fills.index(max_fill)
        second = sorted(fills, reverse=True)[1] if len(fills) > 1 else 0.0
        margin = max_fill - second
        detected = row_options[best_idx]

        # Clear winner → single answer (ignore light neighbour bleed).
        if margin >= clear_margin:
            answers[str(q_num)] = detected
            details.append({
                "question": q_num,
                "detected": detected,
                "status": "answered",
                **fill_info,
            })
            continue

        # Multiple-answer: another bubble is above threshold and close to the best.
        heavy = [
            i for i, f in enumerate(fills)
            if i != best_idx
            and f >= fill_thresh
            and f >= max_fill / diff_factor
        ]
        if heavy:
            answers[str(q_num)] = ""
            details.append({
                "question": q_num,
                "detected": None,
                "status": "multiple",
                "candidates": [row_options[best_idx]] + [row_options[i] for i in heavy],
                **fill_info,
            })
            continue

        # Soft ambiguous mark on degraded / low-res photos → blank, not a guess.
        if (degraded or low_res) and margin < soft_margin and max_fill < fill_thresh * 1.35:
            answers[str(q_num)] = ""
            details.append({
                "question": q_num,
                "detected": None,
                "status": "blank",
                **fill_info,
            })
            continue

        answers[str(q_num)] = detected
        details.append({
            "question": q_num,
            "detected": detected,
            "status": "answered",
            **fill_info,
        })

    return answers, details, {
        "baseline": round(global_baseline, 3),
        "inkScale": round(ink_scale, 3),
        "fillThreshold": round(fill_thresh, 3),
        "searchPx": search_px,
        "gridOffset": [offset_dx, offset_dy],
        "clearMargin": clear_margin,
        "crossedOut": len(crossed),
        "quality": quality,
    }


# ---------------------------------------------------------------------------
# Assessment code detection (printed ASM###### above the Name header)
# ---------------------------------------------------------------------------

ASSESSMENT_CODE_RE = re.compile(r"\bASM\d{4,8}\b", re.IGNORECASE)
# OCR often swaps A↔4, S↔5, M↔H/N on thin print.
_ASSESSMENT_CODE_FUZZY_RE = re.compile(
    r"(?:ASM|[A4][S5][MHN])\d{4,8}",
    re.IGNORECASE,
)


def _normalize_assessment_code(raw: str):
    """Extract and normalize an ASM###### code from noisy OCR text."""
    if not raw:
        return None
    compact = re.sub(r"[^A-Za-z0-9]", "", raw).upper()
    match = ASSESSMENT_CODE_RE.search(compact)
    if not match:
        match = _ASSESSMENT_CODE_FUZZY_RE.search(compact)
    if not match:
        return None
    token = match.group(0).upper()
    # Digits after the (possibly confused) 3-letter prefix only — so A5M123
    # becomes ASM123, not ASM5123.
    digits = re.sub(r"\D", "", token[3:])
    if len(digits) < 4:
        return None
    # GradX codes are ASM + 6 zero-padded digits (ASM000007). Trim OCR tail
    # so ASM0000077 → ASM000007.
    if len(digits) > 6:
        digits = digits[:6]
    return f"ASM{digits}"


def detect_assessment_code(cv2, gray_img, np):
    """
    OCR the horizontal assessment code printed near the top of the sheet.
    Returns (code_or_none, debug_dict).
    """
    h, w = gray_img.shape[:2]
    # Printed near the Name header on A4 — several bands for crop variance.
    rois = [
        (int(0.06 * w), int(0.01 * h), int(0.48 * w), int(0.075 * h)),
        (int(0.08 * w), int(0.015 * h), int(0.55 * w), int(0.085 * h)),
        (int(0.05 * w), int(0.01 * h), int(0.95 * w), int(0.12 * h)),
        (int(0.40 * w), int(0.01 * h), int(0.95 * w), int(0.09 * h)),
    ]
    debug = {"rois": [], "raw": []}
    try:
        import subprocess
        import tempfile
        import os
    except Exception as exc:
        return None, {"error": str(exc)}

    for x0, y0, x1, y1 in rois:
        roi = gray_img[y0:y1, x0:x1]
        if roi.size == 0:
            continue
        scale = 3
        big = cv2.resize(
            roi,
            (roi.shape[1] * scale, roi.shape[0] * scale),
            interpolation=cv2.INTER_CUBIC,
        )
        variants = []
        try:
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            enhanced = clahe.apply(big)
            _, thr = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            variants.extend([thr, cv2.bitwise_not(thr), enhanced])
        except Exception:
            _, thr = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            variants.extend([thr, cv2.bitwise_not(thr)])
        debug["rois"].append([x0, y0, x1, y1])
        for img_variant in variants:
            fd, tmp = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            try:
                cv2.imwrite(tmp, img_variant)
                for psm in ("7", "6"):
                    proc = subprocess.run(
                        [
                            "tesseract", tmp, "stdout",
                            "--psm", psm,
                            "-c", "tessedit_char_whitelist=ASMasm0123456789",
                        ],
                        capture_output=True,
                        text=True,
                        timeout=6,
                    )
                    text = (proc.stdout or "").strip()
                    debug["raw"].append(text)
                    found = _normalize_assessment_code(text)
                    if found:
                        return found, {**debug, "method": "ocr", "psm": psm}
            except Exception as exc:
                debug["error"] = str(exc)
            finally:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    return None, debug


# ---------------------------------------------------------------------------
# Handwritten Name / Section (Name header capsule on the sheet)
# ---------------------------------------------------------------------------

# Strip printed EN/AR field labels that OCR sometimes glues onto handwriting.
_NAME_LABEL_RE = re.compile(
    r"(?i)\b(name|section|sec|اسم|الاسم|الشعبة|شعبة|القسم|قسم)\s*:?\s*",
    re.UNICODE,
)
_ARABIC_RE = re.compile(r"[\u0600-\u06FF]")
_TESS_LANGS_TRIED: list[str] | None = None


def _tesseract_langs():
    """Prefer ara+eng when Arabic tessdata is installed; else eng only."""
    global _TESS_LANGS_TRIED
    if _TESS_LANGS_TRIED is not None:
        return _TESS_LANGS_TRIED
    try:
        import subprocess
        proc = subprocess.run(
            ["tesseract", "--list-langs"],
            capture_output=True,
            text=True,
            timeout=4,
        )
        available = set((proc.stdout or proc.stderr or "").split())
        if "ara" in available and "eng" in available:
            _TESS_LANGS_TRIED = ["ara+eng", "ara", "eng"]
        elif "ara" in available:
            _TESS_LANGS_TRIED = ["ara", "eng"]
        else:
            _TESS_LANGS_TRIED = ["eng"]
    except Exception:
        _TESS_LANGS_TRIED = ["eng"]
    return _TESS_LANGS_TRIED


def _clean_ocr_field(text: str) -> str:
    text = (text or "").replace("\u200f", "").replace("\u200e", "").replace("\ufeff", "")
    text = _NAME_LABEL_RE.sub("", text)
    text = re.sub(r"[|_•·]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" .-_:،,;\"'`~")
    return text


def _script_counts(text: str):
    arabic = len(_ARABIC_RE.findall(text or ""))
    latin = sum(1 for c in (text or "") if ("A" <= c <= "Z") or ("a" <= c <= "z"))
    digits = sum(1 for c in (text or "") if c.isdigit())
    letters = sum(1 for c in (text or "") if c.isalpha())
    weird = sum(
        1
        for c in (text or "")
        if not (c.isalnum() or c.isspace() or c in ".-'،ـ ")
    )
    return arabic, latin, digits, letters, weird


# Alef / Yeh unification + strip tatweel / harakat for Arabic name matching.
_AR_NORMALIZE_MAP = str.maketrans({
    "\u0622": "\u0627",  # آ → ا
    "\u0623": "\u0627",  # أ → ا
    "\u0625": "\u0627",  # إ → ا
    "\u0671": "\u0627",  # ٱ → ا
    "\u0649": "\u064a",  # ى → ي
    "\u0640": None,      # tatweel ـ
})
_AR_DIACRITICS_RE = re.compile(r"[\u064B-\u065F\u0670]")


def _normalize_arabic_glyphs(text: str) -> str:
    """Unify common Arabic letter variants without changing Latin text."""
    if not text:
        return text
    text = _AR_DIACRITICS_RE.sub("", text)
    return text.translate(_AR_NORMALIZE_MAP)


def _ocr_text_score(text: str, kind: str = "name") -> float:
    """
    Rank OCR candidates. Do NOT boost Arabic counts — that made ara-garbage
    beat correct English (e.g. 'Ahmed Hassan'). Prefer clean letters for names
    and short alphanumerics for sections.
    """
    text = (text or "").strip()
    if not text:
        return -1.0
    arabic, latin, digits, letters, weird = _script_counts(text)
    if kind == "section":
        alnum = letters + digits
        if alnum < 1 or len(text) > 24:
            return -1.0
        score = float(alnum * 4 - weird * 5 - max(0, len(text) - 4) * 2)
        # Classroom codes are usually letter+digit (A1, B2, أ1, ٢ب) or pure digits.
        if letters and digits:
            score += 5.0
        if latin and digits:
            score += 2.0
        # Pure 1–3 digit sections (e.g. "40") are the common GradX case.
        if digits and not letters and 1 <= digits <= 3 and weird == 0:
            score += 8.0
        return score

    if letters < 2:
        return -1.0
    # Digits / symbols in a person name are almost always OCR noise.
    score = float(letters * 4 - digits * 6 - weird * 5)
    # Slight preference for a dominant script (EN or AR), still allow mixed names.
    if arabic and latin:
        dominant = max(arabic, latin)
        score += dominant * 0.25
    else:
        score += letters * 0.25
    # Real Arabic names are usually 2–4 words; reward that shape lightly.
    if arabic >= 4 and arabic > latin:
        ar_words = [w for w in text.split() if _ARABIC_RE.search(w)]
        if 2 <= len(ar_words) <= 5:
            score += 4.0
        elif len(ar_words) == 1 and arabic >= 6:
            score += 1.5
        # Common given-name prefixes (helps pick real OCR over glyph soup).
        head = ar_words[0] if ar_words else ""
        if head.startswith(("محمد", "محم", "عبد", "أحمد", "احمد", "علي", "يوسف")):
            score += 5.0
        # Penalize digit-heavy Arabic OCR garbage.
        if digits:
            score -= digits * 3.0
    return score


def _ocr_roi_variants(cv2, roi):
    """Upscaled preprocess variants for faint / handwritten EN+AR text."""
    scale = 4
    big = cv2.resize(
        roi,
        (max(1, roi.shape[1] * scale), max(1, roi.shape[0] * scale)),
        interpolation=cv2.INTER_CUBIC,
    )
    variants = [big]
    try:
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        enhanced = clahe.apply(big)
        variants.append(enhanced)
        _, otsu = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append(otsu)
        # Adaptive + light close reconnects thin Arabic stroke joins.
        adaptive = cv2.adaptiveThreshold(
            enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 9,
        )
        variants.append(adaptive)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        variants.append(cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, kernel))
    except Exception:
        _, otsu = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append(otsu)
    return variants


def _normalize_arabic_candidate(text: str) -> list[str]:
    """
    Tesseract sometimes emits Arabic in visual order on shaped print.
    Normalize glyphs and keep word-order / full reverse so scoring can pick
    the readable form.
    """
    text = _clean_ocr_field(text)
    if not text:
        return []
    arabic, latin, _, _, _ = _script_counts(text)
    out = [text]
    if arabic >= 2 and arabic > latin:
        normalized = _normalize_arabic_glyphs(text)
        if normalized and normalized not in out:
            out.append(normalized)
        # Word-order reverse first (common RTL OCR artifact, less destructive).
        words = text.split()
        if len(words) > 1:
            swapped = " ".join(reversed(words))
            if swapped not in out:
                out.append(swapped)
            swapped_n = _normalize_arabic_glyphs(swapped)
            if swapped_n and swapped_n not in out:
                out.append(swapped_n)
        rev = text[::-1].strip()
        if rev and rev not in out:
            out.append(rev)
            rev_n = _normalize_arabic_glyphs(rev)
            if rev_n and rev_n not in out:
                out.append(rev_n)
    return out


def _pick_best_ocr_candidate(
    candidates: list[tuple[float, str]],
    kind: str = "name",
) -> str:
    """
    Choose among scored OCR strings.

    Names: English and Arabic can both hallucinate on the other script. Keep
    the best Arabic-heavy and Latin-heavy candidates, then pick with a margin
    so 'isle sare' does not beat 'محمد علي', and ara-digit garbage does not
    beat 'Ahmed Hassan'.

    Sections: short codes — just take the highest section score (no script
    preference), otherwise Arabic noise like 'كم' beats 'A1'.
    """
    if not candidates:
        return ""
    if kind == "section":
        return max(candidates, key=lambda item: item[0])[1]

    best_ar = ("", -1.0)
    best_lat = ("", -1.0)
    best_any = ("", -1.0)
    for score, text in candidates:
        if score > best_any[1]:
            best_any = (text, score)
        arabic, latin, digits, letters, weird = _script_counts(text)
        if letters < 1 and digits < 1:
            continue
        # Ignore digit-heavy junk when classifying script winners.
        if digits > letters and letters < 3:
            continue
        if arabic >= 2 and arabic >= latin:
            if score > best_ar[1]:
                best_ar = (text, score)
        elif latin >= 2 and latin > arabic:
            if score > best_lat[1]:
                best_lat = (text, score)
    if best_ar[0] and best_lat[0]:
        if best_lat[1] > best_ar[1] * 1.35:
            return best_lat[0]
        if best_ar[1] > best_lat[1] * 1.35:
            return best_ar[0]
        # Close scores: fewer digits / weird chars wins.
        def cleanliness(t: str) -> tuple:
            _a, _l, digits, letters, weird = _script_counts(t)
            return (-digits - weird, letters)

        return best_ar[0] if cleanliness(best_ar[0]) >= cleanliness(best_lat[0]) else best_lat[0]
    if best_ar[0]:
        return best_ar[0]
    if best_lat[0]:
        return best_lat[0]
    return best_any[0]


def _ocr_roi_text(cv2, gray_img, x0, y0, x1, y1, psm=7, kind: str = "name"):
    """
    Run tesseract on a ROI with Arabic + English when available.
    Tries several preprocess variants and language packs; returns best text.
    """
    h, w = gray_img.shape[:2]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    if x1 <= x0 + 4 or y1 <= y0 + 4:
        return ""
    roi = gray_img[y0:y1, x0:x1]
    try:
        import subprocess
        import tempfile
        import os
    except Exception:
        return ""

    candidates: list[tuple[float, str]] = []
    langs = _tesseract_langs()
    # Keep the search small: raw+CLAHE cover most handwriting; extra PSMs
    # mainly help short section codes.
    base_psms = (psm, 8) if kind == "section" else (psm, 6)
    try:
        for variant in _ocr_roi_variants(cv2, roi):
            fd, tmp = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            try:
                cv2.imwrite(tmp, variant)
                for lang in langs:
                    # PSM 13 (raw line) only for Arabic packs — helps name lines.
                    psms = base_psms
                    if kind == "name" and "ara" in lang:
                        psms = (*base_psms, 13)
                    for mode in psms:
                        cmd = [
                            "tesseract", tmp, "stdout",
                            "-l", lang,
                            "--psm", str(mode),
                        ]
                        # Arabic packs: preserve spaces between name parts.
                        if kind == "name" and "ara" in lang:
                            cmd.extend(["-c", "preserve_interword_spaces=1"])
                        # Sections are short codes — digit whitelist helps a lot.
                        if kind == "section":
                            cmd.extend([
                                "-c",
                                "tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz٠١٢٣٤٥٦٧٨٩",
                            ])
                        try:
                            proc = subprocess.run(
                                cmd,
                                capture_output=True,
                                text=True,
                                timeout=8,
                            )
                        except Exception:
                            continue
                        for text in _normalize_arabic_candidate(proc.stdout or ""):
                            score = _ocr_text_score(text, kind=kind)
                            if score > 0:
                                candidates.append((score, text))
            finally:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
    except Exception:
        return _pick_best_ocr_candidate(candidates, kind=kind)
    return _pick_best_ocr_candidate(candidates, kind=kind)


def capsule_crop_png_b64(cv2, np, warped):
    """PNG (base64) of the Name / Section capsule from the warped sheet,
    upscaled and padded so a vision model can read the handwriting."""
    import base64

    h, w = warped.shape[:2]
    x0, y0 = int(21 / 210 * w), int(12.6 / 297 * h)
    x1, y1 = int((24 + 164 + 1) / 210 * w), int(28.2 / 297 * h)
    crop = warped[y0:y1, x0:x1]
    target_w = 1400
    scale = target_w / max(1, crop.shape[1])
    crop = cv2.resize(
        crop,
        (target_w, max(1, int(crop.shape[0] * scale))),
        interpolation=cv2.INTER_CUBIC,
    )
    ok, buf = cv2.imencode(".png", crop)
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None


def id_write_in_crop_png_b64(cv2, np, img_bgr, grid, num_digits):
    """PNG (base64) of the hand-written Student ID boxes printed just above the
    ID bubble grid, for an optional vision-model cross-check of the bubbles.

    `grid` is [x of column 0, y of digit row 0, column gap, row gap] in the
    pixels of `img_bgr`. The boxes sit above the grid frame, one per column,
    on the same vertical lines as the bubbles.
    """
    import base64

    if not grid or len(grid) < 4:
        return None
    h, w = img_bgr.shape[:2]
    xs, ys, col_gap = float(grid[0]), float(grid[1]), float(grid[2])
    mm = w / 210.0
    x0 = int(max(0, xs - 0.8 * col_gap))
    x1 = int(min(w, xs + (max(1, num_digits) - 1) * col_gap + 0.8 * col_gap))
    y0 = int(max(0, ys - 11.5 * mm))
    y1 = int(min(h, ys - 1.9 * mm))
    if x1 - x0 < 20 or y1 - y0 < 10:
        return None
    crop = img_bgr[y0:y1, x0:x1]
    target_w = 1200
    scale = target_w / max(1, crop.shape[1])
    crop = cv2.resize(
        crop,
        (target_w, max(1, int(crop.shape[0] * scale))),
        interpolation=cv2.INTER_CUBIC,
    )
    ok, buf = cv2.imencode(".png", crop)
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None


# Handwriting regions inside the Name / Section capsule (mm on A4), clear of the
# printed "Name:" / "section:" labels, the divider and the capsule outline.
NAME_FIELD_MM = (38.0, 15.8, 138.0, 24.4)
SECTION_FIELD_MM = (157.0, 15.8, 178.0, 24.4)
# A field counts as written when this share of its area is dark ink.
FIELD_INK_MIN_RATIO = 0.004


def field_ink_ratio(cv2, np, gray, box_mm):
    """Share of a capsule field covered by handwriting (0 = left empty).

    Ink is whatever is clearly darker than the local paper, so shadows, paper
    texture and a tinted page do not count, and only specks of a few pixels are
    ignored. Used so an empty Name / Section is reported as empty instead of
    letting OCR invent characters from blank paper.
    """
    h, w = gray.shape[:2]
    x0 = max(0, int(box_mm[0] / 210.0 * w))
    x1 = min(w, int(box_mm[2] / 210.0 * w))
    y0 = max(0, int(box_mm[1] / 297.0 * h))
    y1 = min(h, int(box_mm[3] / 297.0 * h))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return 0.0
    roi = gray[y0:y1, x0:x1]
    k = 31 if min(roi.shape) > 31 else (min(roi.shape) // 2) * 2 - 1
    paper = cv2.medianBlur(roi, max(3, k))
    ink = (cv2.subtract(paper, roi) > 28).astype(np.uint8)
    count, _labels, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    area = sum(int(st[4]) for st in stats[1:count] if st[4] >= 8)
    return float(area) / float(roi.size)


def capsule_fields_written(cv2, np, gray):
    """(name_written, section_written) for the warped sheet."""
    return (
        field_ink_ratio(cv2, np, gray, NAME_FIELD_MM) >= FIELD_INK_MIN_RATIO,
        field_ink_ratio(cv2, np, gray, SECTION_FIELD_MM) >= FIELD_INK_MIN_RATIO,
    )


def detect_name_and_section(cv2, gray_img, np):
    """
    OCR the Name / Section capsule printed at the top of GradX sheets
    (NAME_HEADER: x=24,y=14,w=162,h=12 mm on A4; sectionWidth=44mm on the right).
    Supports handwritten Arabic and English names / sections.
    """
    h, w = gray_img.shape[:2]
    # Capsule bounds (normalised from mm / page). Slightly taller / deeper so
    # Arabic handwriting that sits low in the capsule is not clipped.
    hx0, hy0 = int(22 / 210 * w), int(13 / 297 * h)
    hx1, hy1 = int((24 + 164) / 210 * w), int((14 + 14) / 297 * h)
    section_w = int(44 / 210 * w)
    # Skip printed "Name:" / "section:" labels (section: is wider ~18–20mm).
    name_x0 = hx0 + int(16 / 210 * w)
    name_x1 = hx1 - section_w - int(3 / 210 * w)
    # Start earlier so handwritten section digits (e.g. "40") are not clipped.
    sec_x0 = hx1 - section_w + int(10 / 210 * w)
    sec_x1 = hx1 - int(1 / 210 * w)
    pad_y = max(1, int(0.002 * h))
    # An empty field must stay empty: OCR on blank paper returns junk glyphs.
    name_written, section_written = capsule_fields_written(cv2, np, gray_img)
    name = ""
    section = ""
    if name_written:
        name = _ocr_roi_text(
            cv2, gray_img, name_x0, hy0 + pad_y, name_x1, hy1 - pad_y, psm=7, kind="name",
        )
    if section_written:
        section = _ocr_roi_text(
            cv2, gray_img, sec_x0, hy0 + pad_y, sec_x1, hy1 - pad_y, psm=8, kind="section",
        )
        # Second, wider section crop — handwritten "40" is often clipped by the
        # first window. Keep the better digit-heavy read.
        section_wide = _ocr_roi_text(
            cv2,
            gray_img,
            max(0, sec_x0 - int(8 / 210 * w)),
            hy0 + pad_y,
            min(w, sec_x1 + int(4 / 210 * w)),
            hy1 - pad_y,
            psm=8,
            kind="section",
        )
        if _ocr_text_score(section_wide, "section") > _ocr_text_score(section, "section"):
            section = section_wide

    def clean_person(value: str) -> str | None:
        v = _clean_ocr_field(value or "")
        if len(v) < 2:
            return None
        # A real name is a few short words; a long run is OCR noise from paper
        # texture, shadows or the printed capsule outline.
        if len(v) > 60 or len(v.split()) > 7:
            return None
        # Drop OCR script noise glued onto real names:
        # 'isle محمد' → 'محمد', 'HULL عمر' → 'عمر', but keep 'Omar عمر'.
        tokens = v.split()
        if len(tokens) > 1:
            ar_tokens = [t for t in tokens if _ARABIC_RE.search(t)]
            if ar_tokens:
                kept = []
                for t in tokens:
                    if _ARABIC_RE.search(t):
                        kept.append(t)
                        continue
                    if not re.search(r"[A-Za-z]", t):
                        kept.append(t)
                        continue
                    # Keep real Latin name tokens (Title Case); drop ALLCAPS /
                    # alllower fragments that usually come from bad eng OCR.
                    if t.isupper() and len(t) <= 5:
                        continue
                    if t.islower():
                        continue
                    kept.append(t)
                if kept:
                    v = " ".join(kept)
        letters = sum(1 for c in v if c.isalpha())
        digits = sum(1 for c in v if c.isdigit())
        if letters < 2:
            return None
        # Names should not be mostly digits (Arabic/Latin OCR noise).
        if digits >= letters:
            return None
        if re.fullmatch(r"(?i)name|section|sec|اسم|الاسم|الشعبة|شعبة", v):
            return None
        # Drop isolated Latin OCR crumbs glued to Arabic names.
        if _ARABIC_RE.search(v):
            v = re.sub(r"(?<![A-Za-z])[A-Za-z]{1,3}(?![A-Za-z])", " ", v)
            v = re.sub(r"\s+", " ", v).strip(" .-_")
        return v or None

    def clean_section(value: str) -> str | None:
        v = _clean_ocr_field(value or "")
        if not v or len(v) > 24:
            return None
        if re.fullmatch(r"(?i)section|sec|name|اسم|الشعبة|شعبة|القسم|قسم", v):
            return None
        # Drop long zero-runs OCR often pads onto short codes ("000أ1", "8200").
        v = re.sub(r"0{2,}", "", v)
        v = v.strip(" 0.-")
        arabic, latin, digits, letters, _weird = _script_counts(v)
        # Latin short codes: O/l/I confusions (A1→Al, B2→82…).
        if latin and not arabic and len(v) <= 6:
            fixed = (
                v.replace("l", "1")
                .replace("I", "1")
                .replace("|", "1")
                .replace("O", "0")
                .replace("o", "0")
            )
            # If we still have a letter+digit pattern, keep it; if OCR read
            # only digits (B→8), leave as-is for the user to edit.
            if re.search(r"[A-Za-z]", fixed):
                v = fixed
        # Prefer pure digits when OCR glued Latin crumbs onto a numeric section
        # (e.g. "4ed" / "40x" → "40" / "4").
        digit_only = re.sub(r"\D", "", v)
        if digit_only and letters and not arabic and len(digit_only) <= 3:
            # "4ed" / "4o" often means handwritten "40" (0→e/o/d).
            if re.fullmatch(r"\d[oOeEdDQ]{1,2}", v):
                v = digit_only[0] + "0"
            else:
                v = digit_only
        # Eastern Arabic digits → Western.
        eastern = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
        v = v.translate(eastern)
        if not v or not any(c.isalnum() for c in v):
            return None
        return v

    return {
        "detectedStudentName": clean_person(name),
        "detectedStudentSection": clean_section(section),
        "rawName": name,
        "rawSection": section,
        "ocrLangs": _tesseract_langs(),
    }


# ---------------------------------------------------------------------------
# Student ID detection
# ---------------------------------------------------------------------------

def find_student_id_blobs(cv2, gray_img, roi_norm=None):
    """Locate filled bubble blobs in the student-ID region of a warped sheet."""
    h, w = gray_img.shape[:2]
    if isinstance(roi_norm, dict):
        x0 = int(float(roi_norm.get("x0", 0.12)) * w)
        y0 = int(float(roi_norm.get("y0", 0.08)) * h)
        x1 = int(float(roi_norm.get("x1", 0.42)) * w)
        y1 = int(float(roi_norm.get("y1", 0.40)) * h)
    else:
        x0, y0 = int(0.12 * w), int(0.08 * h)
        x1, y1 = int(0.42 * w), int(0.40 * h)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, max(x0 + 1, x1)), min(h, max(y0 + 1, y1))
    roi = gray_img[y0:y1, x0:x1]
    if roi.size == 0:
        return []

    _, binary = cv2.threshold(roi, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    blobs = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 50 or area > 650:
            continue
        rx, ry, rw, rh = cv2.boundingRect(cnt)
        if max(rw, rh) / max(1, min(rw, rh)) > 2.2:
            continue
        m = cv2.moments(cnt)
        if m["m00"] == 0:
            continue
        blobs.append((m["m10"] / m["m00"] + x0, m["m01"] / m["m00"] + y0, area))

    blobs.sort(key=lambda b: b[0])
    return blobs


def _cluster_1d(values, gap):
    """Group sorted 1-D positions into clusters separated by > gap."""
    if not values:
        return []
    values = sorted(values)
    groups = [[values[0]]]
    for v in values[1:]:
        if v - groups[-1][-1] > gap:
            groups.append([v])
        else:
            groups[-1].append(v)
    return [float(sum(g) / len(g)) for g in groups]


def locate_student_id_grid(cv2, gray_img, np, num_digits, preferred_position=None):
    """
    Locate the Student ID bubble grid from the printed circles / "Student ID"
    heading. Supports TOP_LEFT / TOP_RIGHT / BOTTOM_LEFT / BOTTOM_RIGHT.

    Returns dict with xs, ys, col_gap, row_gap (pixels) or None.
    """
    h, w = gray_img.shape[:2]
    # Four corner pockets covering every printed Student ID placement.
    pockets = [
        ("TOP_LEFT", int(0.04 * w), int(0.05 * h), int(0.50 * w), int(0.48 * h)),
        ("TOP_RIGHT", int(0.50 * w), int(0.05 * h), int(0.96 * w), int(0.48 * h)),
        ("BOTTOM_LEFT", int(0.04 * w), int(0.48 * h), int(0.50 * w), int(0.95 * h)),
        ("BOTTOM_RIGHT", int(0.50 * w), int(0.48 * h), int(0.96 * w), int(0.95 * h)),
    ]
    preferred = str(preferred_position or "").upper().replace("-", "_")
    if preferred not in {p[0] for p in pockets}:
        preferred = None

    def read_label_hints():
        """OCR the "Student ID" heading (slow: two tesseract passes)."""
        label_hints = []  # list of (x, y, conf, pocket_name_guess)
        try:
            import subprocess, tempfile, os
            # OCR top and bottom bands for "Student ID" / Arabic labels.
            bands = [
                (int(0.04 * h), int(0.42 * h), "TOP"),
                (int(0.48 * h), int(0.92 * h), "BOTTOM"),
            ]
            for y0b, y1b, band in bands:
                header = gray_img[y0b:y1b, int(0.04 * w):int(0.96 * w)]
                if header.size == 0:
                    continue
                fd, tmp = tempfile.mkstemp(suffix=".png")
                os.close(fd)
                try:
                    cv2.imwrite(tmp, header)
                    proc = subprocess.run(
                        ["tesseract", tmp, "stdout", "tsv", "--psm", "11"],
                        capture_output=True, text=True, timeout=7,
                    )
                    for line in (proc.stdout or "").splitlines()[1:]:
                        parts = line.split("\t")
                        if len(parts) < 12:
                            continue
                        try:
                            left, top, width, height = map(int, parts[6:10])
                            conf = float(parts[10])
                        except ValueError:
                            continue
                        text = (parts[11] or "").strip().lower()
                        if conf < 20:
                            continue
                        # EN "student"/"id" or AR رقم/طالب fragments.
                        hit = (
                            "stud" in text
                            or text in ("id", "i.d", "i.d.")
                            or "طالب" in text
                            or "رقم" in text
                        )
                        if not hit:
                            continue
                        gx = left + int(0.04 * w) + width // 2
                        gy = y0b + top + height  # just below the label
                        side = "LEFT" if gx < w * 0.5 else "RIGHT"
                        label_hints.append((gx, gy, conf + width, f"{band}_{side}"))
                finally:
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
        except Exception:
            pass
        return label_hints

    def pick(label_hints):
        best_label = None
        if label_hints:
            best_label = max(label_hints, key=lambda item: item[2])

        best_grid = None
        best_score = -1.0

        for pname, px0, py0, px1, py1 in pockets:
            pocket_bonus = 0.0
            if preferred and pname == preferred:
                pocket_bonus += 80.0
            if best_label is not None:
                lx, ly, _, guess = best_label
                if px0 - 30 <= lx <= px1 + 30 and py0 - 30 <= ly <= py1 + 30:
                    pocket_bonus += 60.0
                elif guess and guess.replace("TOP_", "TOP_").startswith(pname.split("_")[0]):
                    # weak band match
                    pocket_bonus += 10.0

            roi = gray_img[py0:py1, px0:px1]
            if roi.size == 0:
                continue
            blur = cv2.medianBlur(roi, 5)
            circles = cv2.HoughCircles(
                blur, cv2.HOUGH_GRADIENT, dp=1.2, minDist=11,
                param1=70, param2=15, minRadius=4, maxRadius=20,
            )
            if circles is None:
                continue
            pts = np.round(circles[0]).astype(int)
            if len(pts) < max(12, num_digits * 3):
                continue

            xs = _cluster_1d([int(p[0]) for p in pts], gap=10)
            ys = _cluster_1d([int(p[1]) for p in pts], gap=10)
            if len(xs) < max(4, num_digits - 2) or len(ys) < 8:
                continue

            if len(xs) >= num_digits:
                col_counts = []
                for i, cx in enumerate(xs):
                    col_counts.append(sum(1 for p in pts if abs(p[0] - cx) < 8))
                best_i, best_c = 0, -1
                for i in range(0, len(xs) - num_digits + 1):
                    c = sum(col_counts[i:i + num_digits])
                    if c > best_c:
                        best_c, best_i = c, i
                xs = xs[best_i:best_i + num_digits]
            else:
                continue

            if len(ys) > 10:
                ys = ys[-10:]
            elif len(ys) < 10:
                continue

            col_gap = float(np.median(np.diff(xs))) if len(xs) > 1 else 20.0
            row_gap = float(np.median(np.diff(ys))) if len(ys) > 1 else 20.0
            if col_gap < 10 or row_gap < 10:
                continue

            score = pocket_bonus + len(pts) + (25 if best_label else 0)
            if score > best_score:
                best_score = score
                best_grid = {
                    "xs": float(xs[0] + px0),
                    "ys": float(ys[0] + py0),
                    "col_gap": col_gap,
                    "row_gap": row_gap,
                    "label": (best_label[0], best_label[1]) if best_label else None,
                    "pocket": (px0, py0, px1, py1),
                    "position": pname,
                }
        return best_grid

    # The assessment's own ID position (always sent by the backend) already
    # identifies the right pocket, so the slow heading OCR only runs when that
    # position is unknown or the preferred pocket yields no grid.
    best_grid = pick([])
    if best_grid is None or not preferred or best_grid.get("position") != preferred:
        best_grid = pick(read_label_hints())
    return best_grid


# The ID grid is refined around its expected position in steps of 0.2 grid pitch.
# The refinement must stay well under one row: the ten digit rows repeat every
# row pitch, so a candidate shifted by a whole row reads a perfectly consistent
# ID that is off by one on every digit (e.g. 194763229 -> 083652118).
ID_MAX_X_SHIFT_STEPS = 3      # +-0.6 column pitch
ID_MAX_Y_SHIFT_STEPS = 2      # +-0.4 row pitch


def detect_student_id(gray_img, np, config, num_digits):
    """
    Detect the student ID from the bubble grid.

    1. Locate the ID block via bubble circles / "Student ID" text (position can move).
    2. Also try the PDF layout origin.
    3. Fine-shift and pick the strongest-fill complete read.
    """
    sid_cfg = config.get("studentIdGrid", DEFAULT_CONFIG.get("studentIdGrid", {}))
    digit_start_x = sid_cfg.get("digitStartX", 43.2 / 210)
    grid_top_y = sid_cfg.get("gridTopY", 59 / 297)
    digit_gap = sid_cfg.get("digitGap", 4.8 / 210)
    row_gap = sid_cfg.get("rowGap", 6.2 / 297)
    b_radius_norm = sid_cfg.get("bubbleRadius", (2.0 / 210) * 1.2)
    # Slightly higher to ignore empty printed rings; filled graphite clears this.
    fill_thresh = float(sid_cfg.get("fillThreshold", 0.18))
    row_digits = sid_cfg.get("rowDigits", ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"])

    h, w = gray_img.shape[:2]
    radius_px = max(4, int(b_radius_norm * w))
    global_mean = float(gray_img.mean())
    cols = max(1, min(12, num_digits))
    num_rows = len(row_digits)
    col_pitch_px = max(1, int(digit_gap * w))
    row_pitch_px = max(1, int(row_gap * h))

    # Paper is bright on ink_gray; filled bubbles are darker than the page mean.
    # Disc means for every pixel in one filter pass (was one numpy slice per probe).
    disc_means = _disc_mean_map(gray_img, np, radius_px)

    fill_map = np.maximum(
        0.0, (global_mean - disc_means) / max(1.0, global_mean),
    ).astype(np.float32)
    half = max(1, radius_px // 2)
    probe = np.array(
        [(dy, dx) for dy in (-half, 0, half) for dx in (-half, 0, half)],
        dtype=np.float64,
    )  # (9, 2)
    row_idx = np.arange(num_rows, dtype=np.float64)
    col_idx = np.arange(cols, dtype=np.float64)

    def read_grid(xs, ys, col_gap_px, row_gap_px):
        # Peak fill of every (column, digit-row) bubble: max over a 3x3 probe
        # pattern, gathered from the precomputed fill map in one shot.
        cx = xs + col_idx * col_gap_px            # (cols,)
        ny = ys + row_idx * row_gap_px            # (rows,)
        px = np.rint(cx[:, None, None] + probe[None, None, :, 1]).astype(np.int64)
        py = np.rint(ny[None, :, None] + probe[None, None, :, 0]).astype(np.int64)
        px = np.broadcast_to(px, (cols, num_rows, probe.shape[0]))
        py = np.broadcast_to(py, (cols, num_rows, probe.shape[0]))
        valid = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        vals = np.where(
            valid,
            fill_map[np.clip(py, 0, h - 1), np.clip(px, 0, w - 1)],
            0.0,
        )
        peaks = vals.max(axis=2)                  # (cols, rows)
        sid = ""
        total_fill = 0.0
        margin_sum = 0.0
        col_debug = []
        for col in range(cols):
            col_peaks = peaks[col]
            best_row = int(np.argmax(col_peaks))
            order = np.sort(col_peaks)
            best_f = float(order[-1])
            second_f = float(order[-2]) if num_rows > 1 else 0.0
            if best_f <= 0.0:
                best_row = -1
            confident = (
                best_f >= fill_thresh
                and best_row >= 0
                and (second_f < fill_thresh * 0.85 or best_f >= second_f * 1.35)
            )
            digit = row_digits[best_row] if confident else "_"
            sid += digit
            total_fill += best_f
            margin_sum += max(0.0, best_f - second_f)
            col_debug.append({
                "col": col,
                "nom_x": int(cx[col]),
                "best_row": best_row,
                "best_digit": digit,
                "best_fill": round(best_f, 3),
                "second_fill": round(second_f, 3),
            })
        return sid, sid.count("_"), total_fill, margin_sum, col_debug

    def score_candidate(blanks, total_fill, margin_sum):
        return (blanks, -total_fill, -margin_sum)

    seeds = [(digit_start_x * w, grid_top_y * h, col_pitch_px, row_pitch_px, "exact")]
    located = (sid_cfg or {}).get("_located")
    if isinstance(located, dict) and "xs" in located:
        seeds.insert(0, (
            float(located["xs"]), float(located["ys"]),
            float(located["col_gap"]), float(located["row_gap"]),
            "bubbles",
        ))
    else:
        located = None

    candidates = []
    for seed_xs, seed_ys, seed_cg, seed_rg, method in seeds:
        for x_sh in range(-ID_MAX_X_SHIFT_STEPS, ID_MAX_X_SHIFT_STEPS + 1):
            for y_sh in range(-ID_MAX_Y_SHIFT_STEPS, ID_MAX_Y_SHIFT_STEPS + 1):
                xs = seed_xs + x_sh * seed_cg * 0.2
                ys = seed_ys + y_sh * seed_rg * 0.2
                if xs < 15 or ys < 30:
                    continue
                sid, blanks, total, margin, col_dbg = read_grid(xs, ys, seed_cg, seed_rg)
                candidates.append({
                    "sid": sid,
                    "blanks": blanks,
                    "total_fill": total,
                    "score": score_candidate(blanks, total, margin),
                    "method": method if x_sh == 0 and y_sh == 0 else "grid",
                    "x_shift": x_sh,
                    "y_shift": y_sh,
                    "cols": col_dbg,
                    "grid": [xs, ys, seed_cg, seed_rg],
                })

    # Filled-blob calibration as a third family of seeds.
    blob_count = 0
    try:
        import cv2  # type: ignore
        roi = None
        if located is not None:
            px0, py0, px1, py1 = located["pocket"]
            roi = {
                "x0": px0 / w, "y0": py0 / h,
                "x1": px1 / w, "y1": py1 / h,
            }
        elif isinstance(sid_cfg.get("roi"), dict):
            roi = sid_cfg["roi"]
        blobs = find_student_id_blobs(cv2, gray_img, roi)
        blob_count = len(blobs)
        if len(blobs) >= max(3, cols // 2):
            # One blob per column → digit from y using layout/located row pitch.
            base_ys = located["ys"] if located else grid_top_y * h
            base_rg = located["row_gap"] if located else float(row_pitch_px)
            base_cg = located["col_gap"] if located else float(col_pitch_px)
            xs0 = min(b[0] for b in blobs)
            # Snap each blob to nearest column / row of a candidate grid.
            for x_off in range(-2, 3):
                for y_off in range(-ID_MAX_Y_SHIFT_STEPS, ID_MAX_Y_SHIFT_STEPS + 1):
                    xs = xs0 + x_off * base_cg * 0.2
                    ys = base_ys + y_off * base_rg * 0.2
                    sid, blanks, total, margin, col_dbg = read_grid(xs, ys, base_cg, base_rg)
                    candidates.append({
                        "sid": sid,
                        "blanks": blanks,
                        "total_fill": total,
                        "score": score_candidate(blanks, total, margin),
                        "method": "blob",
                        "x_shift": x_off,
                        "y_shift": y_off,
                        "cols": col_dbg,
                        "grid": [xs, ys, base_cg, base_rg],
                    })
    except Exception:
        pass

    if not candidates:
        return "_" * cols, {"blanks": cols, "method": "none"}

    candidates.sort(key=lambda c: c["score"])
    best = candidates[0]
    # Strongest alternative reading (a different ID from a shifted grid). A
    # trustworthy read has no serious rival with the same completeness.
    runner_up = None
    for cand in candidates[1:]:
        if cand["sid"] != best["sid"]:
            runner_up = {
                "sid": cand["sid"],
                "blanks": cand["blanks"],
                "fillRatio": round(
                    cand["total_fill"] / max(best["total_fill"], 1e-6), 3,
                ),
            }
            break
    debug_info = {
        "runnerUp": runner_up,
        "method": best["method"],
        "blanks": best["blanks"],
        "fillThresh": fill_thresh,
        "globalMean": round(global_mean, 1),
        "blobCount": blob_count,
        "totalFill": round(best.get("total_fill", 0), 3),
        "cols": best.get("cols", []),
        "xShift": best.get("x_shift"),
        "yShift": best.get("y_shift"),
        "grid": [round(float(v), 1) for v in best["grid"]] if best.get("grid") else None,
    }
    if located is not None:
        debug_info["located"] = {
            "xs": round(located["xs"], 1),
            "ys": round(located["ys"], 1),
            "colGap": round(located["col_gap"], 1),
            "rowGap": round(located["row_gap"], 1),
            "label": located.get("label"),
        }
    return best["sid"], debug_info


# ---------------------------------------------------------------------------
# Sheet alignment (mobile / camera must present a flat, near-rectilinear page)
# ---------------------------------------------------------------------------

def sheet_alignment_ok(corners_norm):
    """
    corners_norm: dict with topLeft/topRight/bottomLeft/bottomRight {x,y} in 0..1.
    Returns (ok: bool, reason: str|None).

    Only reject extreme captures — mild phone perspective is fine for warp.
    """
    if not isinstance(corners_norm, dict):
        return True, None
    try:
        tl = corners_norm["topLeft"]
        tr = corners_norm["topRight"]
        bl = corners_norm["bottomLeft"]
        br = corners_norm["bottomRight"]
    except (KeyError, TypeError):
        return True, None

    def dist(a, b):
        return ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5

    def angle(u, v):
        import math
        du = (u[0] ** 2 + u[1] ** 2) ** 0.5
        dv = (v[0] ** 2 + v[1] ** 2) ** 0.5
        if du < 1e-9 or dv < 1e-9:
            return 0.0
        cos = max(-1.0, min(1.0, (u[0] * v[0] + u[1] * v[1]) / (du * dv)))
        return math.degrees(math.acos(cos))

    top, bottom = dist(tl, tr), dist(bl, br)
    left, right = dist(tl, bl), dist(tr, br)
    if top < 0.12 or left < 0.18:
        return False, "too_small"
    wr = top / max(bottom, 1e-9)
    lr = left / max(right, 1e-9)
    if wr < 0.65 or wr > 1.55 or lr < 0.65 or lr > 1.55:
        return False, "skew"
    col = angle((bl["x"] - tl["x"], bl["y"] - tl["y"]), (br["x"] - tr["x"], br["y"] - tr["y"]))
    edge = angle((tr["x"] - tl["x"], tr["y"] - tl["y"]), (br["x"] - bl["x"], br["y"] - bl["y"]))
    if col > 22 or edge > 22:
        return False, "skew"
    import math
    top_tilt = abs(math.degrees(math.atan2(tr["y"] - tl["y"], tr["x"] - tl["x"])))
    if top_tilt > 20:
        return False, "tilt"
    return True, None


# ---------------------------------------------------------------------------
# Main grading function
# ---------------------------------------------------------------------------

# Quality gate thresholds (calibrated on real phone scans + synthetic blur /
# shadow / rotation sets; healthy sheets sit far inside every limit).
ID_MIN_MEAN_FILL = 0.24      # mean fill of the picked ID bubbles
MIN_SOURCE_SIDE_PX = 600     # shorter side of the uploaded photo
MIN_SHARPNESS = 2.3          # p99.5 edge / contrast (crisp sheets: 3.4-5)
MIN_CONTRAST = 85.0          # paper level (p75) minus ink (p1); healthy scans 125-215
MIN_PAPER_LEVEL = 105.0      # median paper brightness (under-exposed below)
MAX_SHADE = 0.62             # darkest / brightest paper block
TRUSTED_MARK_DEV_PX = 7.0      # max px a verified registration square may sit off its spot
MIN_MARKS_FOUND = 5          # of the 6 printed registration squares
MAX_GRID_OFFSET_PX = 10      # answer-grid drift that calibration had to absorb

ISSUE_PRIORITY = [
    "low_resolution",
    "blurry",
    "low_contrast",
    "too_dark",
    "uneven_light",
    "page_not_found",
    "grid_misaligned",
    "id_unclear",
    "id_incomplete",
]


def assess_scan_quality(source_size, registration, sharpness, grid_offset, id_raw, id_unclear):
    """
    Decide whether this photo can be graded reliably. Returns the issue codes
    (ordered by importance) and `ok` (no blocking issue). `id_*` issues are
    reported separately because the mobile review screen already handles them.
    """
    issues = []
    if min(source_size) < MIN_SOURCE_SIDE_PX:
        issues.append("low_resolution")
    if sharpness.get("sharp", 99.0) < MIN_SHARPNESS:
        issues.append("blurry")
    if sharpness.get("contrast", 255.0) < MIN_CONTRAST:
        issues.append("low_contrast")
    if sharpness.get("paperLevel", 255.0) < MIN_PAPER_LEVEL:
        issues.append("too_dark")
    if sharpness.get("shade", 0.0) > MAX_SHADE:
        issues.append("uneven_light")
    if registration.get("found", 6) < MIN_MARKS_FOUND:
        issues.append("page_not_found")
    if grid_offset is not None and max(abs(grid_offset[0]), abs(grid_offset[1])) > MAX_GRID_OFFSET_PX:
        issues.append("grid_misaligned")
    if id_unclear:
        issues.append("id_unclear")
    elif not id_raw or "_" in id_raw:
        issues.append("id_incomplete")
    issues.sort(key=ISSUE_PRIORITY.index)
    blocking = [i for i in issues if not i.startswith("id_")]
    return {
        "ok": not blocking,
        "issues": issues,
        "blocking": blocking,
        "metrics": {
            "sharp": sharpness.get("sharp"),
            "contrast": sharpness.get("contrast"),
            "paperLevel": sharpness.get("paperLevel"),
            "shade": sharpness.get("shade"),
            "marksFound": registration.get("found"),
            "markMaxDev": registration.get("maxDev"),
            "gridOffset": list(grid_offset) if grid_offset is not None else None,
            "sourceSize": list(source_size),
        },
    }


def grade_sheet(cv2, np, image_path: str, config: dict):
    image = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if image is None:
        return {
            "error": "image_read_failed",
            "answers": {},
            "confidence": 0.0,
            "questionDetails": [],
            "decodedFormId": None,
            "detectedStudentId": None,
        }

    # Reject crooked captures before expensive OCR / bubble work.
    anchors = config.get("anchorHints") or config.get("anchors")
    align_ok, align_reason = sheet_alignment_ok(anchors)
    if not align_ok:
        return {
            "error": "sheet_not_straight",
            "alignmentReason": align_reason,
            "answers": {},
            "confidence": 0.0,
            "questionDetails": [],
            "decodedFormId": None,
            "detectedStudentId": None,
        }

    # Phase 1: Perspective correction
    warped, warp_conf, warp_applied, anchor_debug = perspective_warp(cv2, np, image, config)

    # Name / section only (mobile: the student ID is not on the roster, so the
    # app offers to add the student). Reuses the regular OCR unchanged.
    mode_value = str(config.get("mode") or "").lower()
    if mode_value in ("namecrop", "name_crop"):
        # Crop only (no OCR): the caller reads the handwriting with a vision
        # model, which is far more reliable than Tesseract on cursive Arabic.
        crop_gray = (
            cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) if len(warped.shape) == 3 else warped
        )
        crop_name_written, crop_section_written = capsule_fields_written(cv2, np, crop_gray)
        return {
            "answers": {},
            "confidence": round(float(warp_conf), 3),
            "questionDetails": [],
            "decodedFormId": None,
            "detectedStudentId": None,
            "debug": {
                "mode": "nameCrop",
                "nameCrop": capsule_crop_png_b64(cv2, np, warped),
                "nameWritten": bool(crop_name_written),
                "sectionWritten": bool(crop_section_written),
            },
        }
    if mode_value in ("nameonly", "name_only"):
        name_gray = (
            cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
            if len(warped.shape) == 3
            else warped
        )
        name_only = detect_name_and_section(cv2, name_gray, np)
        return {
            "answers": {},
            "confidence": round(float(warp_conf), 3),
            "questionDetails": [],
            "decodedFormId": None,
            "detectedStudentId": None,
            "detectedStudentName": name_only.get("detectedStudentName"),
            "detectedStudentSection": name_only.get("detectedStudentSection"),
            "debug": {"mode": "nameOnly"},
        }

    # Phase 2: Preprocessing + quality estimate (blur / flat lighting / tiny capture)
    # Low-res is judged on the *source* photo — warp always stretches to ~1000px,
    # which would hide thumbnail / far-away phone captures.
    source_quality = estimate_sheet_quality(cv2, np, image)
    binary = preprocess(cv2, np, warped)
    darkness = ink_darkness_map(cv2, np, warped)
    sheet_quality = estimate_sheet_quality(cv2, np, warped)
    if source_quality.get("lowRes"):
        sheet_quality = {
            **sheet_quality,
            "lowRes": True,
            "degraded": True,
            "sourceWidth": source_quality.get("width"),
            "sourceHeight": source_quality.get("height"),
            "sourceLaplacian": source_quality.get("laplacian"),
        }

    id_only = str(config.get("mode") or "").lower() in ("idonly", "id_only", "detect")

    # Phase 3: Bubble analysis (idOnly — the mobile detect step — only runs it
    # for the grid-alignment quality check and discards the answers).
    want_grid = (not id_only) or bool(config.get("qualityGate"))
    answers, details, answer_debug = {}, [], {}
    grid_config = config
    if want_grid:
        early_registration = registration_marks_check(
            cv2, np,
            cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) if len(warped.shape) == 3 else warped,
            config,
        )
        if (
            early_registration.get("found", 0) >= MIN_MARKS_FOUND
            and (early_registration.get("maxDev") or 0.0) <= TRUSTED_MARK_DEV_PX
        ):
            grid_config = {**config, "_trustedGeometry": True}
        answers, details, answer_debug = analyze_answer_grid(
            darkness, np, grid_config, quality=sheet_quality,
        )

    # Phase 4: Student ID detection. Locate the ID block via bubble circles /
    # "Student ID" text when possible. Also compare against a plain resize —
    # mobile uploads are already page-cropped, and a slightly wrong warp can
    # invent confident but wrong IDs (e.g. 444332208 instead of 443206950).
    num_digits = int(config.get("numIdDigits", 5))

    def read_student_id_from(image_bgr):
        dark = ink_darkness_map(cv2, np, image_bgr)
        ink = ((1.0 - dark) * 255.0).astype(np.uint8)
        gray = (
            cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
            if len(image_bgr.shape) == 3
            else image_bgr
        )
        try:
            preferred = (
                config.get("studentIdPosition")
                or (config.get("studentIdGrid") or {}).get("position")
            )
            located = locate_student_id_grid(
                cv2, gray, np, num_digits, preferred_position=preferred,
            )
        except Exception:
            located = None
        sid_config = dict(config)
        if located is not None:
            sid_config = {
                **config,
                "studentIdGrid": {
                    **(config.get("studentIdGrid") or {}),
                    "_located": located,
                },
            }
        raw, debug = detect_student_id(ink, np, sid_config, num_digits)
        return raw, debug, dark

    raw_student_id, sid_debug, darkness = read_student_id_from(warped)
    resized = None
    raw_resize, sid_debug_resize, darkness_resize = None, None, None
    # A warp whose six printed marks all land on their spots, with every ID
    # column read, is the trustworthy geometry. Only otherwise is a plain
    # resize tried too (it can "read" a different, equally complete garbage ID
    # with more ink, which must never beat a verified read).
    verified_complete = (
        warp_applied
        and "_" not in raw_student_id
        and registration_marks_check(
            cv2, np,
            cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) if len(warped.shape) == 3 else warped,
            config,
        ).get("found", 0) >= MIN_MARKS_FOUND
    )
    if not verified_complete:
        resized = cv2.resize(image, (config.get("warpWidth", 1000), config.get("warpHeight", 1414)))
        raw_resize, sid_debug_resize, darkness_resize = read_student_id_from(resized)

    def sid_rank(raw, debug):
        blanks = int((debug or {}).get("blanks", raw.count("_") if raw else num_digits))
        fill = float((debug or {}).get("totalFill", 0.0))
        return (blanks, -fill)

    id_reads = {"warped": raw_student_id, "resized": raw_resize}
    if (
        raw_resize is not None
        and sid_rank(raw_resize, sid_debug_resize) < sid_rank(raw_student_id, sid_debug)
    ):
        raw_student_id = raw_resize
        sid_debug = {**(sid_debug_resize or {}), "source": "resize_fallback"}
        # Prefer the geometry that produced the better ID for answer bubbles too.
        if warp_applied:
            warped = resized
            darkness = darkness_resize
            binary = preprocess(cv2, np, warped)
            sheet_quality = estimate_sheet_quality(cv2, np, warped)
            if source_quality.get("lowRes"):
                sheet_quality = {
                    **sheet_quality,
                    "lowRes": True,
                    "degraded": True,
                    "sourceWidth": source_quality.get("width"),
                    "sourceHeight": source_quality.get("height"),
                }
            if want_grid:
                answers, details, answer_debug = analyze_answer_grid(
                    darkness, np, config, quality=sheet_quality,
                )
            warp_applied = False
            anchor_debug = {**anchor_debug, "idFallback": "resize_better_student_id"}
    else:
        sid_debug = {**(sid_debug or {}), "source": "warped"}
    # An ID is only trusted when the bubbles are really filled. A blank sheet
    # (or a mis-registered grid) otherwise "reads" printed ring noise as a
    # row of identical digits such as 000000000.
    id_cols = [c for c in ((sid_debug or {}).get("cols") or []) if c.get("best_digit") != "_"]
    id_mean_fill = (
        sum(float(c.get("best_fill", 0.0)) for c in id_cols) / len(id_cols) if id_cols else 0.0
    )
    id_digits = {c.get("best_digit") for c in id_cols}
    id_unclear = bool(id_cols) and (
        id_mean_fill < ID_MIN_MEAN_FILL
        or (len(id_cols) >= 5 and len(id_digits) == 1)
    )
    if id_unclear:
        sid_debug = {**(sid_debug or {}), "rejected": raw_student_id, "meanFill": round(id_mean_fill, 3)}
        raw_student_id = "_" * num_digits
    if config.get("idCrop"):
        # Crop of the hand-written ID boxes for the optional vision cross-check.
        return {
            "answers": {},
            "confidence": round(float(warp_conf), 3),
            "questionDetails": [],
            "decodedFormId": None,
            "detectedStudentId": None if re.fullmatch(r"_+", raw_student_id) else (raw_student_id or None),
            "debug": {
                "mode": "idCrop",
                "rawStudentId": raw_student_id,
                "idCrop": id_write_in_crop_png_b64(
                    cv2, np, warped, (sid_debug or {}).get("grid"), num_digits,
                ),
            },
        }
    # Return null only when every digit is blank; partial IDs are still useful
    detected_student_id = None if re.fullmatch(r'_+', raw_student_id) else (raw_student_id or None)

    # Phase 5: Paper-version marker (skip in idOnly).
    detected_version, version_debug = (None, {})
    if not id_only:
        detected_version, version_debug = decode_version_code(binary, config)

    # Phase 6: Assessment code (ASM######) printed above the Name header.
    warp_gray = (
        cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
        if len(warped.shape) == 3
        else warped
    )
    # Photo-quality verdict BEFORE the slow OCR steps: an unreadable photo is
    # reported at once (the app asks for a rescan) instead of after seconds of
    # text recognition.
    registration = registration_marks_check(cv2, np, warp_gray, config)
    sharpness = sharpness_metrics(cv2, np, warp_gray)
    scan_quality = assess_scan_quality(
        source_size=(int(image.shape[1]), int(image.shape[0])),
        registration=registration,
        sharpness=sharpness,
        grid_offset=(answer_debug or {}).get("gridOffset") if want_grid else None,
        id_raw=raw_student_id,
        id_unclear=id_unclear,
    )
    if id_only:
        answers, details = {}, []
    if config.get("qualityGate") and scan_quality["blocking"]:
        return {
            "answers": {},
            "confidence": round(warp_conf, 3),
            "decodedFormId": detected_version,
            "questionDetails": [],
            "detectedStudentId": detected_student_id,
            "detectedAssessmentCode": None,
            "detectedStudentName": None,
            "detectedStudentSection": None,
            "scanQuality": scan_quality,
            "debug": {
                "mode": "rejected",
                "warpConfidence": round(warp_conf, 3),
                "warpApplied": warp_applied,
                "rawStudentId": raw_student_id,
                "idReads": id_reads,
                "studentIdDebug": sid_debug,
                "registration": registration,
                "sharpness": sharpness,
                "sourceSize": [int(image.shape[1]), int(image.shape[0])],
                "answerGrid": answer_debug,
            },
        }

    detected_assessment_code, assessment_code_debug = detect_assessment_code(
        cv2, warp_gray, np
    )
    # Name OCR is expensive (ara+eng); skip on the fast detect-only path.
    name_section = {
        "detectedStudentName": None,
        "detectedStudentSection": None,
        "rawName": "",
        "rawSection": "",
        "ocrLangs": [],
    }
    if not id_only and not config.get("skipName"):
        name_section = detect_name_and_section(cv2, warp_gray, np)


    answered = sum(1 for d in details if d["status"] == "answered")
    total = max(1, len(details))
    bubble_conf = 1.0 if id_only else (answered / total)

    confidence = round(warp_conf if id_only else (warp_conf * 0.4 + bubble_conf * 0.6), 3)

    return {
        "answers": answers,
        "confidence": confidence,
        "decodedFormId": detected_version,
        "questionDetails": details,
        "detectedStudentId": detected_student_id,
        "detectedAssessmentCode": detected_assessment_code,
        "detectedStudentName": name_section.get("detectedStudentName"),
        "detectedStudentSection": name_section.get("detectedStudentSection"),
        "scanQuality": scan_quality,
        "debug": {
            "mode": "idOnly" if id_only else "full",
            "warpConfidence": round(warp_conf, 3),
            "warpApplied": warp_applied,
            "bubbleConfidence": round(bubble_conf, 3),
            "answeredCount": answered,
            "totalQuestions": total,
            "imageShape": list(warped.shape),
            "rawStudentId": raw_student_id,
            "idReads": id_reads,
            "anchors": anchor_debug,
            "studentIdDebug": sid_debug,
            "versionCode": version_debug,
            "assessmentCode": assessment_code_debug,
            "nameSection": {
                "rawName": name_section.get("rawName"),
                "rawSection": name_section.get("rawSection"),
                "ocrLangs": name_section.get("ocrLangs"),
            },
            "sheetQuality": sheet_quality,
            "registration": registration,
            "sharpness": sharpness,
            "sourceSize": [int(image.shape[1]), int(image.shape[0])],
            "answerGrid": answer_debug,
        },
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        emit({"error": "missing_image_path", "answers": {}, "confidence": 0.0, "questionDetails": [], "decodedFormId": None})
        return

    image_path = sys.argv[1]
    config = dict(DEFAULT_CONFIG)

    if len(sys.argv) > 2:
        try:
            override = json.loads(sys.argv[2])
            config = merge_config(config, override)
        except Exception:
            pass

    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as exc:
        emit({"error": "opencv_not_available", "details": str(exc), "answers": {}, "confidence": 0.0, "questionDetails": [], "decodedFormId": None})
        return

    result = grade_sheet(cv2, np, image_path, config)
    emit(result)


if __name__ == "__main__":
    main()
