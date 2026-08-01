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
    # (mark TL corner + 2.25mm half-size, divided by 210 or 297)
    "inputAnchors": {
        "topLeft":     {"x": 0.0964, "y": 0.0480},
        "topRight":    {"x": 0.9012, "y": 0.0480},
        "bottomLeft":  {"x": 0.0964, "y": 0.7349},
        "bottomRight": {"x": 0.9012, "y": 0.7349},
    },
    "anchorSearchHalf": 0.12,
    # Warp target: A4 ratio 1000 × 1414
    "warpWidth":  1000,
    "warpHeight": 1414,
    # Warp DESTINATION of each anchor in the output image
    # (same normalised coords × output size)
    "anchorDst": {
        "topLeft":     {"x": 0.0964, "y": 0.0480},
        "topRight":    {"x": 0.9012, "y": 0.0480},
        "bottomLeft":  {"x": 0.0964, "y": 0.7349},
        "bottomRight": {"x": 0.9012, "y": 0.7349},
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
        "centerX": 0.13333,       # 28 / 210
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

def find_corner_anchor(gray, np, x0, y0, x1, y1):
    """Find the centre of the darkest square-ish blob in the given ROI."""
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

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 12 or area > roi_area * 0.6:
            continue
        rx, ry, rw, rh = cv2.boundingRect(cnt)
        if rw == 0 or rh == 0:
            continue
        aspect = max(rw, rh) / min(rw, rh)
        if aspect > 3.5:
            continue
        squareness = 1.0 - abs(rw - rh) / max(rw, rh)
        fill_in_rect = area / (rw * rh) if rw * rh > 0 else 0
        conf = squareness * 0.5 + fill_in_rect * 0.5
        if conf > best_conf:
            best_conf = conf
            best_centre = (x0 + rx + rw // 2, y0 + ry + rh // 2)

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
    #   Top marks    (18/187 mm, 12 mm)   → y ≈  4.8 %  → top strip  [0,   20%] ✓
    #   Bottom marks (18/187 mm, 216 mm)  → y ≈ 72.7 %  → MUST search from 60 %
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

    anchor_debug = {}
    for name in corner_names:
        x0, y0, x1, y1 = corner_search_boxes[name]

        fx, fy, conf = find_corner_anchor(gray, np, x0, y0, x1, y1)
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

    # Geometric sanity check: the detected quadrilateral must not be degenerate.
    # We verify that top anchors are above bottom anchors and left anchors are
    # left of right anchors — regardless of how far they are from A4-normalised
    # expected positions (which will be wrong for non-A4 images).
    tl, tr, bl, br = found_src
    quad_valid = (
        tl[1] < bl[1] and tr[1] < br[1] and  # tops above bottoms
        tl[0] < tr[0] and bl[0] < br[0] and  # lefts left of rights
        warp_conf > 0.05                        # at least marginal confidence
    )

    if quad_valid:
        M = cv2.getPerspectiveTransform(np.float32(found_src), np.float32(found_dst))
        warped = cv2.warpPerspective(image, M, (out_w, out_h))
        warp_applied = True
    else:
        # Last-resort fallback: plain resize.  This will have wrong y-scale for
        # non-A4 images but is better than crashing.
        warped = cv2.resize(image, (out_w, out_h))
        warp_conf = 0.10
        warp_applied = False

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


# ---------------------------------------------------------------------------
# Bubble analysis
# ---------------------------------------------------------------------------

def sample_bubble(binary, np, bx, by, radius_px):
    """Return fill ratio (dark pixels / total) for a circular bubble ROI."""
    h, w = binary.shape
    x0 = max(0, bx - radius_px)
    y0 = max(0, by - radius_px)
    x1 = min(w, bx + radius_px + 1)
    y1 = min(h, by + radius_px + 1)

    r2 = radius_px ** 2
    dark = 0
    total = 0
    for py in range(y0, y1):
        dy2 = (py - by) ** 2
        for px in range(x0, x1):
            if (px - bx) ** 2 + dy2 <= r2:
                total += 1
                if binary[py, px] > 0:
                    dark += 1

    return dark / max(1, total)


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


def analyze_answer_grid(binary, np, config):
    h, w = binary.shape
    grid = config.get("answerGrid", DEFAULT_CONFIG["answerGrid"])
    options = grid.get("options", ["A", "B", "C", "D", "E"])
    x_step = grid.get("bubbleXStep", 0.03254)
    y_step = grid.get("rowYStep", 0.03676)
    b_radius_norm = grid.get("bubbleRadius", 0.01302)
    fill_thresh = grid.get("fillThreshold", 0.18)
    diff_factor = grid.get("darknessDifferential", 1.6)

    radius_px = max(4, int(b_radius_norm * w))

    answers = {}
    details = []

    for col in grid.get("columns", []):
        start_q = col["startQuestion"]
        count = col["count"]
        bubble_ax = col["bubbleAX"]
        row_y_start = col["rowYStart"]

        for row_i in range(count):
            q_num = start_q + row_i
            row_y_px = int((row_y_start + row_i * y_step) * h)

            fills = []
            for opt_i in range(len(options)):
                bx = int((bubble_ax + opt_i * x_step) * w)
                by = row_y_px
                fill = sample_bubble(binary, np, bx, by, radius_px)
                fills.append(fill)

            max_fill = max(fills) if fills else 0.0

            if max_fill < fill_thresh:
                answers[str(q_num)] = ""
                details.append({
                    "question": q_num,
                    "detected": None,
                    "status": "blank",
                    "fills": {opt: round(fills[i], 3) for i, opt in enumerate(options)},
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

            detected = options[best_idx]
            status = "multiple" if heavy else "answered"

            answers[str(q_num)] = detected
            details.append({
                "question": q_num,
                "detected": detected,
                "status": status,
                "fills": {opt: round(fills[i], 3) for i, opt in enumerate(options)},
            })

    return answers, details


# ---------------------------------------------------------------------------
# Student ID detection
# ---------------------------------------------------------------------------

def find_student_id_blobs(cv2, gray_img):
    """Locate filled bubble blobs in the student-ID region of a warped sheet."""
    h, w = gray_img.shape[:2]
    # Left edge starts right of the version-code strip (ends at 0.143 w) so its
    # solid squares are never mistaken for filled ID bubbles.
    x0, y0 = int(0.17 * w), int(0.08 * h)
    x1, y1 = int(0.32 * w), int(0.36 * h)
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


def detect_student_id(gray_img, np, config, num_digits):
    """
    Detect the student ID from the bubble grid.

    Strategy (in order of preference):
      1. Blob-calibrated grid — find actual ink marks, estimate column/row pitch.
      2. 2-D shift search — sweep x/y offsets around the nominal PDF layout.
      3. Per-column absolute-max fill (no row-mean subtraction).

    Returns (student_id_str, debug_dict).
    """
    sid_cfg = config.get("studentIdGrid", DEFAULT_CONFIG.get("studentIdGrid", {}))
    digit_start_x = sid_cfg.get("digitStartX", 43.2 / 210)
    grid_top_y    = sid_cfg.get("gridTopY",    59   / 297)
    digit_gap     = sid_cfg.get("digitGap",    4.8  / 210)
    row_gap       = sid_cfg.get("rowGap",      6.2  / 297)
    b_radius_norm = sid_cfg.get("bubbleRadius", (2.0 / 210) * 1.2)
    fill_thresh   = sid_cfg.get("fillThreshold", 0.15)
    row_digits    = sid_cfg.get("rowDigits", ["1","2","3","4","5","6","7","8","9","0"])

    h, w = gray_img.shape[:2]
    radius_px = max(4, int(b_radius_norm * w))
    global_mean = float(gray_img.mean())

    cols = max(1, min(12, num_digits))
    num_rows = len(row_digits)

    col_pitch_px = max(1, int(digit_gap * w))
    row_pitch_px = max(1, int(row_gap   * h))
    half_x = max(2, int(col_pitch_px * 0.5))
    half_y = max(2, int(row_pitch_px * 0.5))
    step   = max(2, radius_px // 2)

    def sample_fill_at(cx, cy):
        x0 = max(0, cx - radius_px); y0 = max(0, cy - radius_px)
        x1 = min(w, cx + radius_px + 1); y1 = min(h, cy + radius_px + 1)
        r2 = radius_px ** 2
        s, t = 0, 0
        for py in range(y0, y1):
            dy2 = (py - cy) ** 2
            for px in range(x0, x1):
                if (px - cx) ** 2 + dy2 <= r2:
                    s += int(gray_img[py, px]); t += 1
        mean_val = s / max(1, t)
        return max(0.0, (global_mean - mean_val) / max(1.0, global_mean))

    def read_grid(xs, ys, col_gap_px, row_gap_px):
        """Read one digit per column via peak neighbourhood fill."""
        sid = ""
        total_fill = 0.0
        col_debug = []
        for col in range(cols):
            cx = int(xs + col * col_gap_px)
            best_f = 0.0
            second_f = 0.0
            best_row = -1
            row_fills = []
            for row_i in range(num_rows):
                nom_y = int(ys + row_i * row_gap_px)
                peak = 0.0
                for dy in range(-half_y, half_y + 1, step):
                    for dx in range(-half_x, half_x + 1, step):
                        px, py = cx + dx, nom_y + dy
                        if px < radius_px or py < radius_px or px >= w - radius_px or py >= h - radius_px:
                            continue
                        f = sample_fill_at(px, py)
                        if f > peak:
                            peak = f
                row_fills.append(peak)
                if peak > best_f:
                    second_f = best_f
                    best_f = peak
                    best_row = row_i
                elif peak > second_f:
                    second_f = peak
            differential = 1.3
            confident = (
                best_f >= fill_thresh
                and best_row >= 0
                and (second_f < fill_thresh or best_f >= second_f * differential)
            )
            digit = row_digits[best_row] if confident else "_"
            sid += digit
            total_fill += best_f
            col_debug.append({
                "col": col,
                "nom_x": cx,
                "best_row": best_row,
                "best_digit": digit,
                "best_fill": round(best_f, 3),
            })
        return sid, sid.count("_"), total_fill, col_debug

    def score_sid(sid):
        blanks = sid.count("_")
        filled = cols - blanks
        return (blanks, -filled, -sum(1 for i, c in enumerate(sid) if c == row_digits[i]))

    candidates = []
    blob_count = 0

    # --- Method 1: blob-calibrated grid ---
    try:
        import cv2  # type: ignore
        blobs = find_student_id_blobs(cv2, gray_img)
        blob_count = len(blobs)
        if len(blobs) >= 2:
            dxs = [blobs[i + 1][0] - blobs[i][0] for i in range(len(blobs) - 1)]
            dys = [blobs[i + 1][1] - blobs[i][1] for i in range(len(blobs) - 1)]
            good_dxs = [d for d in dxs if 15 <= d <= 42]
            good_dys = [d for d in dys if 18 <= d <= 72]
            est_col_gap = float(np.median(good_dxs)) if good_dxs else float(col_pitch_px)
            est_row_gap = float(np.median(good_dys)) if good_dys else float(row_pitch_px)

            for start_idx in range(min(3, len(blobs))):
                bx, by = blobs[start_idx][0], blobs[start_idx][1]
                for col0 in range(3):
                    for row0 in range(3):
                        xs = bx - col0 * est_col_gap
                        ys = by - row0 * est_row_gap
                        if xs < 40 or ys < 60:
                            continue
                        sid, blanks, total, col_dbg = read_grid(xs, ys, est_col_gap, est_row_gap)
                        candidates.append({
                            "sid": sid,
                            "blanks": blanks,
                            "score": score_sid(sid),
                            "method": "blob",
                            "xs": round(xs, 1),
                            "ys": round(ys, 1),
                            "col_gap": round(est_col_gap, 1),
                            "row_gap": round(est_row_gap, 1),
                            "cols": col_dbg,
                        })
    except Exception:
        blobs = []

    # --- Method 2: 2-D shift search (skip if blob method found all digits) ---
    blob_perfect = any(c["blanks"] == 0 for c in candidates if c["method"] == "blob")
    if not blob_perfect:
        nom_xs = digit_start_x * w
        nom_ys = grid_top_y * h
        for x_sh in range(-5, 2):
            for y_sh in range(-6, 2):
                xs = nom_xs + x_sh * col_pitch_px
                ys = nom_ys + y_sh * row_pitch_px
                if xs < 40 or ys < 60:
                    continue
                sid, blanks, total, col_dbg = read_grid(xs, ys, col_pitch_px, row_pitch_px)
                candidates.append({
                    "sid": sid,
                    "blanks": blanks,
                    "score": score_sid(sid),
                    "method": "grid",
                    "x_shift": x_sh,
                    "y_shift": y_sh,
                    "cols": col_dbg,
                })

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
        "cols": best.get("cols", []),
    }
    if best["method"] == "blob":
        debug_info.update({
            "xs": best.get("xs"),
            "ys": best.get("ys"),
            "colGapPx": best.get("col_gap"),
            "rowGapPx": best.get("row_gap"),
        })
    else:
        debug_info.update({
            "xShift": best.get("x_shift"),
            "yShift": best.get("y_shift"),
        })

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

    # Phase 3: Bubble analysis
    answers, details = analyze_answer_grid(binary, np, config)

    # Phase 4: Student ID detection (uses grayscale for relative-darkness approach)
    gray_warped = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) if len(warped.shape) == 3 else warped
    num_digits = int(config.get("numIdDigits", 5))
    raw_student_id, sid_debug = detect_student_id(gray_warped, np, config, num_digits)
    # Return null only when every digit is blank; partial IDs are still useful
    detected_student_id = None if re.fullmatch(r'_+', raw_student_id) else (raw_student_id or None)

    # Phase 5: Paper-version marker
    detected_version, version_debug = decode_version_code(binary, config)

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
