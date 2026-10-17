#!/usr/bin/env python3
"""
GradX ZipGrade-style OMR grading engine.

Usage:
    python3 opencv_grader.py <image_path> [<config_json>]

Output (stdout):
    JSON object with keys: answers, confidence, decodedFormId, questionDetails, debug
"""

import json
import re
import sys
import math

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
        "fillThreshold": 0.25,
        "darknessDifferential": 1.3,
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

def find_corner_anchor(gray, np, x0, y0, x1, y1, prefer="any"):
    """
    Find the centre of the darkest square-ish blob in the given ROI.

    prefer:
      'top'    — bias toward the highest marks (true top registration squares)
      'bottom' — bias toward the lowest marks (avoids left mid-page / version squares)
      'any'    — pure shape confidence
    """
    roi = gray[y0:y1, x0:x1]
    if roi.size == 0:
        return ((x0 + x1) // 2, (y0 + y1) // 2, 0.0)

    try:
        import cv2
    except ImportError:
        return ((x0 + x1) // 2, (y0 + y1) // 2, 0.0)

    _, thresh = cv2.threshold(roi, 90, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    best_centre = ((x0 + x1) // 2, (y0 + y1) // 2)
    best_conf = 0.0
    roi_area = roi.shape[0] * roi.shape[1]
    box_h = max(1, y1 - y0)

    for cnt in contours:
        area = cv2.contourArea(cnt)
        # Registration marks are small solid squares — reject huge dark regions.
        if area < 12 or area > min(roi_area * 0.25, 2500):
            continue
        rx, ry, rw, rh = cv2.boundingRect(cnt)
        if rw == 0 or rh == 0:
            continue
        # Marks are ~4.5 mm squares; reject long thin noise.
        if max(rw, rh) > 55 or min(rw, rh) < 8:
            continue
        aspect = max(rw, rh) / min(rw, rh)
        if aspect > 1.8:
            continue
        squareness = 1.0 - abs(rw - rh) / max(rw, rh)
        fill_in_rect = area / (rw * rh) if rw * rh > 0 else 0
        shape_conf = squareness * 0.5 + fill_in_rect * 0.5
        cy = y0 + ry + rh // 2
        y_frac = (cy - y0) / box_h
        if prefer == "bottom":
            conf = shape_conf * 0.55 + y_frac * 0.45
        elif prefer == "top":
            conf = shape_conf * 0.55 + (1.0 - y_frac) * 0.45
        else:
            conf = shape_conf
        if conf > best_conf:
            best_conf = conf
            best_centre = (x0 + rx + rw // 2, cy)

    return (*best_centre, best_conf)


def perspective_warp(cv2, np, image, config):
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
    corner_search_boxes = {
        "topLeft":     (0,           0,           int(0.22*w), int(0.20*h)),
        "topRight":    (int(0.78*w), 0,           w,           int(0.20*h)),
        "bottomLeft":  (0,           int(0.60*h), int(0.22*w), h          ),
        "bottomRight": (int(0.78*w), int(0.60*h), w,           h          ),
    }

    # The mobile scanner may send mark centres. Only trust hints that land
    # inside the same corner search box used for autodetection — cropped
    # uploads with full-frame coordinates would otherwise warp the sheet into
    # garbage and blank out the student-ID grid.
    hints = config.get("anchorHints") or {}
    hint_half = int(0.035 * max(w, h))

    anchor_debug = {}
    for name in corner_names:
        x0, y0, x1, y1 = corner_search_boxes[name]
        prefer = "top" if name.startswith("top") else "bottom"

        fx, fy, conf = find_corner_anchor(gray, np, x0, y0, x1, y1, prefer=prefer)
        hint = hints.get(name)
        # When corner autodetection is already confident, ignore hints — a
        # cropped upload with stale full-frame coordinates would pull the warp
        # onto answer bubbles and destroy student-ID reads.
        if hint and conf < 0.45:
            hx, hy = int(float(hint["x"]) * w), int(float(hint["y"]) * h)
            if x0 <= hx <= x1 and y0 <= hy <= y1:
                hfx, hfy, hconf = find_corner_anchor(
                    gray, np,
                    max(0, hx - hint_half), max(0, hy - hint_half),
                    min(w, hx + hint_half), min(h, hy + hint_half),
                    prefer=prefer,
                )
                if hconf >= 0.5 and hconf >= conf:
                    fx, fy, conf = hfx, hfy, hconf
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
    """
    darkest = image.min(axis=2) if image.ndim == 3 else image
    darkest = darkest.astype(np.float32)
    k = max(15, int(image.shape[1] * 0.06)) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    paper = cv2.morphologyEx(darkest, cv2.MORPH_CLOSE, kernel)
    paper = cv2.GaussianBlur(paper, (k, k), 0)
    return np.clip((paper - darkest) / np.maximum(paper, 1.0), 0.0, 1.0)


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


# Darkness above the empty-bubble baseline that counts as a fully filled
# bubble (pencil or pen on paper typically reaches 0.4-0.6).
FULL_INK_DARKNESS = 0.4


def analyze_answer_grid(darkness, np, config):
    """
    Read every answer row from the ink-darkness map.

    A bubble's fill is how much darker its interior is than an unmarked
    bubble on the same sheet (the printed letter inside every bubble sets
    that baseline), scaled so FULL_INK_DARKNESS reads as 1.0.
    """
    h, w = darkness.shape
    grid = config.get("answerGrid", DEFAULT_CONFIG["answerGrid"])
    options = grid.get("options", ["A", "B", "C", "D", "E"])
    x_step = grid.get("bubbleXStep", 0.03254)
    y_step = grid.get("rowYStep", 0.03676)
    b_radius_norm = grid.get("bubbleRadius", 0.01302)
    # Slightly higher than PDF default so faint graphite rings are not "answered".
    fill_thresh = grid.get("fillThreshold", 0.32)
    # Stronger separation: a second mark must be clearly filled to count as multi.
    diff_factor = grid.get("darknessDifferential", 1.45)

    radius_px = max(4, int(b_radius_norm * w))

    rows = []
    for col in grid.get("columns", []):
        start_q = col["startQuestion"]
        count = col["count"]
        bubble_ax = col["bubbleAX"]
        row_y_start = col["rowYStart"]
        # ZipGrade-grid sheets carry per-block pitch and per-row labels
        # (MCQ A-E vs True/False T-F); legacy sheets use the grid defaults.
        col_x_step = col.get("bubbleXStep", x_step)
        col_y_step = col.get("rowYStep", y_step)
        col_options = col.get("options") or options
        row_labels = col.get("rowLabels") or []

        for row_i in range(count):
            q_num = start_q + row_i
            row_y_px = int((row_y_start + row_i * col_y_step) * h)
            row_options = row_labels[row_i] if row_i < len(row_labels) and row_labels[row_i] else col_options

            raw = [
                mean_in_disc(
                    darkness, np,
                    int((bubble_ax + opt_i * col_x_step) * w), row_y_px, radius_px,
                )
                for opt_i in range(len(row_options))
            ]
            rows.append((q_num, row_options, raw))

    # Unmarked bubbles dominate the lower quartile (each row has at most one
    # intended mark and at least two options).
    all_raw = sorted(v for _, _, raw in rows for v in raw)
    baseline = all_raw[len(all_raw) // 4] if all_raw else 0.0

    answers = {}
    details = []
    for q_num, row_options, raw in rows:
        fills = [
            min(1.0, max(0.0, (v - baseline) / FULL_INK_DARKNESS)) for v in raw
        ]
        max_fill = max(fills) if fills else 0.0
        # List keeps the printed option order (JSON objects may be re-sorted).
        fill_info = {
            "fills": {opt: round(fills[i], 3) for i, opt in enumerate(row_options)},
            "options": list(row_options),
        }

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

        # Multiple-answer check: any other bubble within (max/diff_factor)
        heavy = [
            i for i, f in enumerate(fills)
            if i != best_idx
            and f >= fill_thresh
            and f >= max_fill / diff_factor
        ]

        detected = row_options[best_idx]
        if heavy:
            # Multi-mark rows earn no credit and must not look like a single answer.
            answers[str(q_num)] = ""
            details.append({
                "question": q_num,
                "detected": None,
                "status": "multiple",
                "candidates": [row_options[best_idx]] + [row_options[i] for i in heavy],
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

    return answers, details, {"baseline": round(baseline, 3)}


# ---------------------------------------------------------------------------
# Assessment code detection (printed ASM###### above the Name header)
# ---------------------------------------------------------------------------

ASSESSMENT_CODE_RE = re.compile(r"\bASM\d{4,8}\b", re.IGNORECASE)


def detect_assessment_code(cv2, gray_img, np):
    """
    OCR the horizontal assessment code printed near the top of the sheet.
    Returns (code_or_none, debug_dict).
    """
    h, w = gray_img.shape[:2]
    # Printed at ~NAME_HEADER (x=24mm,y≈12mm) on A4 — search the top band.
    rois = [
        (int(0.08 * w), int(0.015 * h), int(0.55 * w), int(0.085 * h)),
        (int(0.05 * w), int(0.01 * h), int(0.95 * w), int(0.12 * h)),
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
        # Upscale thin text for tesseract.
        scale = 3
        big = cv2.resize(roi, (roi.shape[1] * scale, roi.shape[0] * scale), interpolation=cv2.INTER_CUBIC)
        _, thr = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            cv2.imwrite(tmp, thr)
            proc = subprocess.run(
                ["tesseract", tmp, "stdout", "--psm", "7", "-c", "tessedit_char_whitelist=ASMasm0123456789"],
                capture_output=True,
                text=True,
                timeout=6,
            )
            text = (proc.stdout or "").strip()
            debug["raw"].append(text)
            debug["rois"].append([x0, y0, x1, y1])
            match = ASSESSMENT_CODE_RE.search(text.replace(" ", ""))
            if match:
                return match.group(0).upper(), {**debug, "method": "ocr"}
            # Also accept OCR that split letters oddly.
            compact = re.sub(r"[^A-Za-z0-9]", "", text).upper()
            match = ASSESSMENT_CODE_RE.search(compact)
            if match:
                return match.group(0).upper(), {**debug, "method": "ocr_compact"}
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

def _ocr_roi_text(cv2, gray_img, x0, y0, x1, y1, psm=7):
    """Run tesseract on a ROI; return cleaned text or ''."""
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
        scale = 3
        big = cv2.resize(
            roi,
            (max(1, roi.shape[1] * scale), max(1, roi.shape[0] * scale)),
            interpolation=cv2.INTER_CUBIC,
        )
        _, thr = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            cv2.imwrite(tmp, thr)
            proc = subprocess.run(
                ["tesseract", tmp, "stdout", f"--psm", str(psm)],
                capture_output=True,
                text=True,
                timeout=6,
            )
            text = (proc.stdout or "").strip()
            # Drop the printed labels if OCR picked them up.
            text = re.sub(r"(?i)\b(name|section|sec)\s*:?\s*", "", text).strip()
            text = re.sub(r"\s+", " ", text)
            return text
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    except Exception:
        return ""


def detect_name_and_section(cv2, gray_img, np):
    """
    OCR the Name / Section capsule printed at the top of GradX sheets
    (NAME_HEADER: x=24,y=14,w=162,h=12 mm on A4; sectionWidth=44mm on the right).
    """
    h, w = gray_img.shape[:2]
    # Capsule bounds (normalised from mm / page).
    hx0, hy0 = int(24 / 210 * w), int(14 / 297 * h)
    hx1, hy1 = int((24 + 162) / 210 * w), int((14 + 12) / 297 * h)
    section_w = int(44 / 210 * w)
    # Leave room for the printed "Name:" / "section:" labels.
    name_x0 = hx0 + int(18 / 210 * w)
    name_x1 = hx1 - section_w - int(4 / 210 * w)
    sec_x0 = hx1 - section_w + int(10 / 210 * w)
    sec_x1 = hx1 - int(2 / 210 * w)
    pad_y = max(1, int(0.004 * h))
    name = _ocr_roi_text(cv2, gray_img, name_x0, hy0 + pad_y, name_x1, hy1 - pad_y, psm=7)
    section = _ocr_roi_text(cv2, gray_img, sec_x0, hy0 + pad_y, sec_x1, hy1 - pad_y, psm=7)
    # Reject garbage that is mostly digits/symbols.
    def clean_person(value: str) -> str | None:
        v = (value or "").strip(" .-_|")
        if len(v) < 2:
            return None
        letters = sum(1 for c in v if c.isalpha())
        if letters < 2:
            return None
        return v

    def clean_section(value: str) -> str | None:
        v = (value or "").strip(" .-_|")
        if not v or len(v) > 24:
            return None
        if re.fullmatch(r"(?i)section|sec|name", v):
            return None
        return v

    return {
        "detectedStudentName": clean_person(name),
        "detectedStudentSection": clean_section(section),
        "rawName": name,
        "rawSection": section,
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


def locate_student_id_grid(cv2, gray_img, np, num_digits):
    """
    Locate the Student ID bubble grid from the printed circles / "Student ID"
    heading. The block can sit TOP_LEFT / TOP_RIGHT / BOTTOM_*, so we search
    both upper halves rather than trusting fixed PDF coordinates alone.

    Returns dict with xs, ys, col_gap, row_gap (pixels) or None.
    """
    h, w = gray_img.shape[:2]
    # Two candidate pockets: left and right of the upper page.
    pockets = [
        (int(0.06 * w), int(0.06 * h), int(0.48 * w), int(0.48 * h)),
        (int(0.52 * w), int(0.06 * h), int(0.94 * w), int(0.48 * h)),
    ]

    label_hint = None
    try:
        import subprocess, tempfile, os
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            # OCR the upper half for the printed heading.
            header = gray_img[int(0.05 * h):int(0.35 * h), int(0.05 * w):int(0.95 * w)]
            cv2.imwrite(tmp, header)
            proc = subprocess.run(
                ["tesseract", tmp, "stdout", "tsv", "--psm", "11"],
                capture_output=True, text=True, timeout=6,
            )
            best = None
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
                if conf < 25 or "stud" not in text:
                    continue
                score = conf + width
                if best is None or score > best[0]:
                    # Map back into full-image coords.
                    best = (score, left + int(0.05 * w), top + height + int(0.05 * h))
            if best is not None:
                label_hint = (best[1], best[2])
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    except Exception:
        pass

    best_grid = None
    best_score = -1.0

    for px0, py0, px1, py1 in pockets:
        # Prefer the pocket that contains the OCR label when available.
        if label_hint is not None:
            lx, ly = label_hint
            if not (px0 - 20 <= lx <= px1 + 20 and py0 - 20 <= ly <= py1 + 20):
                # Still evaluate, but with a penalty later.
                pocket_bonus = 0.0
            else:
                pocket_bonus = 50.0
        else:
            pocket_bonus = 0.0

        roi = gray_img[py0:py1, px0:px1]
        if roi.size == 0:
            continue
        blur = cv2.medianBlur(roi, 5)
        circles = cv2.HoughCircles(
            blur, cv2.HOUGH_GRADIENT, dp=1.2, minDist=11,
            param1=70, param2=16, minRadius=4, maxRadius=18,
        )
        if circles is None:
            continue
        pts = np.round(circles[0]).astype(int)
        if len(pts) < max(12, num_digits * 3):
            continue

        xs = _cluster_1d([int(p[0]) for p in pts], gap=10)
        ys = _cluster_1d([int(p[1]) for p in pts], gap=10)
        # Need ~num_digits columns and ~10 digit rows (write-in boxes may add 1).
        if len(xs) < max(4, num_digits - 2) or len(ys) < 8:
            continue

        # Pick the densest run of `num_digits` consecutive columns.
        if len(xs) >= num_digits:
            # Use the leftmost run with the most circles assigned.
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

        # Digit rows are the last 10 row clusters (write-in boxes sit above).
        if len(ys) > 10:
            ys = ys[-10:]
        elif len(ys) < 10:
            continue

        col_gap = float(np.median(np.diff(xs))) if len(xs) > 1 else 20.0
        row_gap = float(np.median(np.diff(ys))) if len(ys) > 1 else 20.0
        if col_gap < 10 or row_gap < 10:
            continue

        score = pocket_bonus + len(pts) + (20 if label_hint else 0)
        if score > best_score:
            best_score = score
            best_grid = {
                "xs": float(xs[0] + px0),
                "ys": float(ys[0] + py0),
                "col_gap": col_gap,
                "row_gap": row_gap,
                "label": label_hint,
                "pocket": (px0, py0, px1, py1),
            }

    return best_grid


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
    fill_thresh = sid_cfg.get("fillThreshold", 0.15)
    row_digits = sid_cfg.get("rowDigits", ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"])

    h, w = gray_img.shape[:2]
    radius_px = max(4, int(b_radius_norm * w))
    global_mean = float(gray_img.mean())
    cols = max(1, min(12, num_digits))
    num_rows = len(row_digits)
    col_pitch_px = max(1, int(digit_gap * w))
    row_pitch_px = max(1, int(row_gap * h))

    # Paper is bright on ink_gray; filled bubbles are darker than the page mean.
    def sample_fill_at(cx, cy):
        x0 = max(0, int(cx) - radius_px)
        y0 = max(0, int(cy) - radius_px)
        x1 = min(w, int(cx) + radius_px + 1)
        y1 = min(h, int(cy) + radius_px + 1)
        if x1 <= x0 or y1 <= y0:
            return 0.0
        yy, xx = np.ogrid[y0:y1, x0:x1]
        mask = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius_px ** 2
        vals = gray_img[y0:y1, x0:x1][mask]
        if vals.size == 0:
            return 0.0
        mean_val = float(vals.mean())
        return max(0.0, (global_mean - mean_val) / max(1.0, global_mean))

    def read_grid(xs, ys, col_gap_px, row_gap_px):
        sid = ""
        total_fill = 0.0
        margin_sum = 0.0
        col_debug = []
        half = max(1, radius_px // 2)
        for col in range(cols):
            cx = xs + col * col_gap_px
            best_f = 0.0
            second_f = 0.0
            best_row = -1
            for row_i in range(num_rows):
                nom_y = ys + row_i * row_gap_px
                peak = 0.0
                for dy in (-half, 0, half):
                    for dx in (-half, 0, half):
                        peak = max(peak, sample_fill_at(cx + dx, nom_y + dy))
                if peak > best_f:
                    second_f = best_f
                    best_f = peak
                    best_row = row_i
                elif peak > second_f:
                    second_f = peak
            confident = (
                best_f >= fill_thresh
                and best_row >= 0
                and (second_f < fill_thresh or best_f >= second_f * 1.3)
            )
            digit = row_digits[best_row] if confident else "_"
            sid += digit
            total_fill += best_f
            margin_sum += max(0.0, best_f - second_f)
            col_debug.append({
                "col": col,
                "nom_x": int(cx),
                "best_row": best_row,
                "best_digit": digit,
                "best_fill": round(best_f, 3),
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
        for x_sh in range(-4, 5):
            for y_sh in range(-5, 6):
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
                for y_off in range(-3, 4):
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
                    })
    except Exception:
        pass

    if not candidates:
        return "_" * cols, {"blanks": cols, "method": "none"}

    candidates.sort(key=lambda c: c["score"])
    best = candidates[0]
    debug_info = {
        "method": best["method"],
        "blanks": best["blanks"],
        "fillThresh": fill_thresh,
        "globalMean": round(global_mean, 1),
        "blobCount": blob_count,
        "totalFill": round(best.get("total_fill", 0), 3),
        "cols": best.get("cols", []),
        "xShift": best.get("x_shift"),
        "yShift": best.get("y_shift"),
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
# Main grading function
# ---------------------------------------------------------------------------

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

    # Phase 1: Perspective correction
    warped, warp_conf, warp_applied, anchor_debug = perspective_warp(cv2, np, image, config)

    # Phase 2: Preprocessing
    binary = preprocess(cv2, np, warped)
    darkness = ink_darkness_map(cv2, np, warped)

    # Phase 3: Bubble analysis
    answers, details, answer_debug = analyze_answer_grid(darkness, np, config)

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
            located = locate_student_id_grid(cv2, gray, np, num_digits)
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
    resized = cv2.resize(image, (config.get("warpWidth", 1000), config.get("warpHeight", 1414)))
    raw_resize, sid_debug_resize, darkness_resize = read_student_id_from(resized)

    def sid_rank(raw, debug):
        blanks = int((debug or {}).get("blanks", raw.count("_") if raw else num_digits))
        fill = float((debug or {}).get("totalFill", 0.0))
        return (blanks, -fill)

    if sid_rank(raw_resize, sid_debug_resize) < sid_rank(raw_student_id, sid_debug):
        raw_student_id = raw_resize
        sid_debug = {**(sid_debug_resize or {}), "source": "resize_fallback"}
        # Prefer the geometry that produced the better ID for answer bubbles too.
        if warp_applied:
            warped = resized
            darkness = darkness_resize
            binary = preprocess(cv2, np, warped)
            answers, details, answer_debug = analyze_answer_grid(darkness, np, config)
            warp_applied = False
            anchor_debug = {**anchor_debug, "idFallback": "resize_better_student_id"}
    else:
        sid_debug = {**(sid_debug or {}), "source": "warped"}
        # Re-analyse answers on the chosen darkness map (already done above).
    # Return null only when every digit is blank; partial IDs are still useful
    detected_student_id = None if re.fullmatch(r'_+', raw_student_id) else (raw_student_id or None)

    # Phase 5: Paper-version marker
    detected_version, version_debug = decode_version_code(binary, config)

    # Phase 6: Assessment code (ASM######) printed above the Name header.
    warp_gray = (
        cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
        if len(warped.shape) == 3
        else warped
    )
    detected_assessment_code, assessment_code_debug = detect_assessment_code(
        cv2, warp_gray, np
    )
    name_section = detect_name_and_section(cv2, warp_gray, np)

    answered = sum(1 for d in details if d["status"] == "answered")
    total = max(1, len(details))
    bubble_conf = answered / total

    confidence = round(warp_conf * 0.4 + bubble_conf * 0.6, 3)

    return {
        "answers": answers,
        "confidence": confidence,
        "decodedFormId": detected_version,
        "questionDetails": details,
        "detectedStudentId": detected_student_id,
        "detectedAssessmentCode": detected_assessment_code,
        "detectedStudentName": name_section.get("detectedStudentName"),
        "detectedStudentSection": name_section.get("detectedStudentSection"),
        "debug": {
            "warpConfidence": round(warp_conf, 3),
            "warpApplied": warp_applied,
            "bubbleConfidence": round(bubble_conf, 3),
            "answeredCount": answered,
            "totalQuestions": total,
            "imageShape": list(warped.shape),
            "rawStudentId": raw_student_id,
            "anchors": anchor_debug,
            "studentIdDebug": sid_debug,
            "versionCode": version_debug,
            "assessmentCode": assessment_code_debug,
            "nameSection": {
                "rawName": name_section.get("rawName"),
                "rawSection": name_section.get("rawSection"),
            },
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
