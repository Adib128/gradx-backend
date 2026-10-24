#!/usr/bin/env python3
"""Unit smoke tests for opencv_grader helpers (no Nest required)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import opencv_grader as og  # noqa: E402


class AssessmentCodeTests(unittest.TestCase):
    def test_exact_asm(self):
        self.assertEqual(og._normalize_assessment_code("ASM123456"), "ASM123456")
        self.assertEqual(og._normalize_assessment_code("code ASM998877 here"), "ASM998877")

    def test_fuzzy_prefix(self):
        self.assertEqual(og._normalize_assessment_code("A5M123456"), "ASM123456")
        self.assertEqual(og._normalize_assessment_code("4SM554433"), "ASM554433")
        self.assertEqual(og._normalize_assessment_code("ASH112233"), "ASM112233")

    def test_trim_extra_digit(self):
        self.assertEqual(og._normalize_assessment_code("ASM0000077"), "ASM000007")
        self.assertEqual(og._normalize_assessment_code("ASM000007"), "ASM000007")

    def test_rejects_noise(self):
        self.assertIsNone(og._normalize_assessment_code(""))
        self.assertIsNone(og._normalize_assessment_code("HELLO"))
        self.assertIsNone(og._normalize_assessment_code("ASM12"))


class AlignmentTests(unittest.TestCase):
    def _rect(self, skew=0.0, shrink=0.0):
        # Near-ideal A4 mark span in normalised coords.
        return {
            "topLeft": {"x": 0.05 + shrink, "y": 0.05 + skew},
            "topRight": {"x": 0.95 - shrink, "y": 0.05},
            "bottomLeft": {"x": 0.05 + shrink, "y": 0.75},
            "bottomRight": {"x": 0.95 - shrink, "y": 0.75 - skew},
        }

    def test_good_rectangle(self):
        ok, reason = og.sheet_alignment_ok(self._rect())
        self.assertTrue(ok, reason)

    def test_too_small(self):
        ok, reason = og.sheet_alignment_ok(
            {
                "topLeft": {"x": 0.4, "y": 0.4},
                "topRight": {"x": 0.5, "y": 0.4},
                "bottomLeft": {"x": 0.4, "y": 0.55},
                "bottomRight": {"x": 0.5, "y": 0.55},
            }
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "too_small")

    def test_skewed(self):
        ok, reason = og.sheet_alignment_ok(
            {
                "topLeft": {"x": 0.05, "y": 0.05},
                "topRight": {"x": 0.95, "y": 0.05},
                "bottomLeft": {"x": 0.25, "y": 0.75},
                "bottomRight": {"x": 0.75, "y": 0.75},
            }
        )
        self.assertFalse(ok)
        self.assertIn(reason, ("skew", "aspect", "tilt"))


class HintedWarpTests(unittest.TestCase):
    """Device-measured mark centres drive the warp; middle marks verify it."""

    W, H = 1000, 1414

    def _sheet(self, decoy_bottom_left=False):
        import cv2
        import numpy as np

        img = np.full((self.H, self.W, 3), 235, np.uint8)
        a = og.DEFAULT_CONFIG["anchorDst"]
        mid_y = a["topLeft"]["y"] + (a["bottomLeft"]["y"] - a["topLeft"]["y"]) * 128 / 204
        spots = [
            (a["topLeft"]["x"], a["topLeft"]["y"]),
            (a["topRight"]["x"], a["topRight"]["y"]),
            (a["bottomLeft"]["x"], a["bottomLeft"]["y"]),
            (a["bottomRight"]["x"], a["bottomRight"]["y"]),
            (a["topLeft"]["x"], mid_y),
            (a["topRight"]["x"], mid_y),
        ]
        marks = [(int(x * self.W), int(y * self.H)) for x, y in spots]
        for cx, cy in marks:
            cv2.rectangle(img, (cx - 11, cy - 11), (cx + 11, cy + 11), (25, 25, 25), -1)
        if decoy_bottom_left:
            # A filled answer bubble below-right of the real bottom-left mark.
            cx, cy = marks[2]
            cv2.circle(img, (cx + 70, cy + 40), 12, (25, 25, 25), -1)
        return img, marks

    def _hints(self, marks, jitter=0):
        names = ["topLeft", "topRight", "bottomLeft", "bottomRight"]
        return {
            n: {"x": (marks[i][0] + jitter) / self.W, "y": (marks[i][1] - jitter) / self.H}
            for i, n in enumerate(names)
        }

    def test_hints_are_refined_to_the_marks(self):
        import cv2
        import numpy as np

        img, marks = self._sheet(decoy_bottom_left=True)
        cfg = dict(og.DEFAULT_CONFIG)
        cfg["anchorHints"] = self._hints(marks, jitter=6)
        _warped, conf, applied, debug = og.perspective_warp(cv2, np, img, cfg)
        self.assertTrue(applied)
        for name in ("topLeft", "topRight", "bottomLeft", "bottomRight"):
            self.assertEqual(debug[name]["source"], "hint_refined", name)
        bl = debug["bottomLeft"]["src"]
        self.assertLess(abs(bl[0] - marks[2][0]) + abs(bl[1] - marks[2][1]), 4)
        self.assertEqual(debug["middleMarks"], 2)

    def test_wrong_hints_fall_back_to_auto_detection(self):
        import cv2
        import numpy as np

        img, marks = self._sheet()
        cfg = dict(og.DEFAULT_CONFIG)
        wrong = self._hints(marks)
        # Hints that put the bottom marks far from the printed squares.
        wrong["bottomLeft"] = {"x": 0.30, "y": 0.60}
        wrong["bottomRight"] = {"x": 0.70, "y": 0.62}
        cfg["anchorHints"] = wrong
        _warped, _conf, applied, debug = og.perspective_warp(cv2, np, img, cfg)
        self.assertTrue(applied)
        self.assertEqual(debug.get("warpFrom"), "auto_after_hint_check_failed")
        self.assertEqual(debug["middleMarks"], 2)

    def test_middle_marks_missing_on_a_bad_warp(self):
        import cv2
        import numpy as np

        img, _marks = self._sheet()
        shifted = np.roll(img, 60, axis=0)
        self.assertEqual(og.middle_marks_found(cv2, np, img, og.DEFAULT_CONFIG), 2)
        self.assertEqual(og.middle_marks_found(cv2, np, shifted, og.DEFAULT_CONFIG), 0)


class DiscMeanTests(unittest.TestCase):
    def test_vectorised_disc_mean_matches_reference(self):
        import numpy as np

        rng = np.random.default_rng(7)
        values = rng.random((120, 160)).astype(np.float32)
        for cx, cy, r in ((40, 50, 6), (100, 30, 9), (3, 4, 5), (157, 117, 7)):
            ref = og.mean_in_disc(values, np, cx, cy, r)
            fast = float(og._disc_mean_map(values, np, r)[cy, cx])
            self.assertAlmostEqual(ref, fast, places=4)

    def test_peak_in_disc_finds_the_filled_bubble(self):
        import numpy as np

        values = np.zeros((100, 100), np.float32)
        yy, xx = np.ogrid[:100, :100]
        values[(xx - 52) ** 2 + (yy - 48) ** 2 <= 100] = 1.0
        self.assertGreater(og.peak_in_disc(values, np, 50, 50, 10, search_px=4), 0.9)
        self.assertLess(og.peak_in_disc(values, np, 10, 10, 10, search_px=1), 0.05)


class StudentIdLocateSignatureTests(unittest.TestCase):
    def test_accepts_preferred_position(self):
        # Signature only — no OpenCV image required.
        import inspect

        sig = inspect.signature(og.locate_student_id_grid)
        self.assertIn("preferred_position", sig.parameters)


class CalibrationEquivalenceTests(unittest.TestCase):
    def _reference_offset(self, darkness, np, row_centres, radius_px, search_px):
        """The original per-bubble implementation."""

        def score_at(dx, dy):
            score = 0.0
            for centres in row_centres:
                raw = [
                    og.peak_in_disc(darkness, np, cx + dx, cy + dy, radius_px, search_px=1)
                    for cx, cy in centres
                ]
                if len(raw) < 2:
                    continue
                ordered = sorted(raw, reverse=True)
                score += ordered[0] - ordered[1]
            return score

        best, bdx, bdy = -1.0, 0, 0
        for dy in range(-search_px, search_px + 1, 2):
            for dx in range(-search_px, search_px + 1, 2):
                sc = score_at(dx, dy)
                if sc > best:
                    best, bdx, bdy = sc, dx, dy
        fb, fdx, fdy = best, bdx, bdy
        for dy in range(bdy - 1, bdy + 2):
            for dx in range(bdx - 1, bdx + 2):
                if dx == bdx and dy == bdy:
                    continue
                sc = score_at(dx, dy)
                if sc > fb:
                    fb, fdx, fdy = sc, dx, dy
        return fdx, fdy

    def test_vectorised_offset_matches_reference(self):
        import numpy as np
        import cv2

        h, w = 400, 300
        darkness = np.zeros((h, w), np.float32)
        rows = []
        for r in range(8):
            centres = [(60 + c * 30, 50 + r * 40) for c in range(5 if r % 3 else 2)]
            rows.append(centres)
            # one filled bubble per row, drifted by (+7, -5) from nominal
            cx, cy = centres[r % len(centres)]
            cv2.circle(darkness, (cx + 7, cy - 5), 9, 1.0, -1)
        got = og._calibrate_answer_offset(darkness, np, rows, 12, search_px=18)
        want = self._reference_offset(darkness, np, rows, 12, 18)
        self.assertEqual(got, want)
        self.assertLessEqual(abs(got[0] - 7) + abs(got[1] + 5), 2)


class StudentIdGridTests(unittest.TestCase):
    def _ink(self, digits):
        import cv2
        import numpy as np

        w, h = 1000, 1414
        cfg = og.DEFAULT_CONFIG.get("studentIdGrid", {})
        x0 = cfg.get("digitStartX", 43.2 / 210) * w
        y0 = cfg.get("gridTopY", 59 / 297) * h
        cg = cfg.get("digitGap", 4.8 / 210) * w
        rg = cfg.get("rowGap", 6.2 / 297) * h
        ink = np.full((h, w), 255, np.uint8)
        for col in range(len(digits)):
            for row in range(10):
                cx, cy = int(x0 + col * cg), int(y0 + row * rg)
                cv2.circle(ink, (cx, cy), 9, 150, 1)
                if digits[col] == str(row):
                    cv2.circle(ink, (cx, cy), 8, 20, -1)
        return ink, cfg

    def test_reads_filled_digits(self):
        import numpy as np

        ink, _cfg = self._ink("443206950")
        sid, dbg = og.detect_student_id(ink, np, dict(og.DEFAULT_CONFIG), 9)
        self.assertEqual(sid, "443206950")
        self.assertEqual(dbg["blanks"], 0)
        self.assertEqual(len(dbg["cols"]), 9)
        self.assertIn("second_fill", dbg["cols"][0])


class ScanQualityTests(unittest.TestCase):
    GOOD = {"sharp": 4.2, "contrast": 120.0, "shade": 0.27, "paperLevel": 218.0}
    REG = {"found": 6, "total": 6, "maxDev": 2.0}

    def _assess(self, **over):
        args = dict(
            source_size=(1080, 1440),
            registration=self.REG,
            sharpness=self.GOOD,
            grid_offset=(1, 2),
            id_raw="443206950",
            id_unclear=False,
        )
        args.update(over)
        return og.assess_scan_quality(**args)

    def test_healthy_scan_passes(self):
        q = self._assess()
        self.assertTrue(q["ok"])
        self.assertEqual(q["issues"], [])

    def test_each_blocking_issue(self):
        cases = {
            "low_resolution": dict(source_size=(400, 560)),
            "blurry": dict(sharpness={**self.GOOD, "sharp": 1.8}),
            "low_contrast": dict(sharpness={**self.GOOD, "contrast": 41.0}),
            "too_dark": dict(sharpness={**self.GOOD, "paperLevel": 80.0}),
            "uneven_light": dict(sharpness={**self.GOOD, "shade": 0.7}),
            "page_not_found": dict(registration={**self.REG, "found": 3}),
            "grid_misaligned": dict(grid_offset=(-14, 3)),
        }
        for code, over in cases.items():
            q = self._assess(**over)
            self.assertFalse(q["ok"], code)
            self.assertIn(code, q["blocking"], code)

    def test_id_issues_do_not_block(self):
        q = self._assess(id_raw="4432_6950")
        self.assertTrue(q["ok"])
        self.assertEqual(q["issues"], ["id_incomplete"])
        q = self._assess(id_raw="_" * 9, id_unclear=True)
        self.assertTrue(q["ok"])
        self.assertEqual(q["issues"], ["id_unclear"])

    def test_issues_ordered_by_importance(self):
        q = self._assess(
            registration={**self.REG, "found": 2},
            sharpness={**self.GOOD, "sharp": 1.0},
            grid_offset=(15, 0),
        )
        self.assertEqual(q["blocking"], ["blurry", "page_not_found", "grid_misaligned"])


class RegistrationAndSharpnessTests(unittest.TestCase):
    def _sheet(self):
        import cv2
        import numpy as np

        img = np.full((1414, 1000), 235, np.uint8)
        a = og.DEFAULT_CONFIG["anchorDst"]
        mid_y = a["topLeft"]["y"] + (a["bottomLeft"]["y"] - a["topLeft"]["y"]) * 128 / 204
        for x, y in [
            (a["topLeft"]["x"], a["topLeft"]["y"]),
            (a["topRight"]["x"], a["topRight"]["y"]),
            (a["bottomLeft"]["x"], a["bottomLeft"]["y"]),
            (a["bottomRight"]["x"], a["bottomRight"]["y"]),
            (a["topLeft"]["x"], mid_y),
            (a["topRight"]["x"], mid_y),
        ]:
            cx, cy = int(x * 1000), int(y * 1414)
            cv2.rectangle(img, (cx - 11, cy - 11), (cx + 11, cy + 11), 25, -1)
        for i in range(0, 600, 60):
            cv2.line(img, (200 + i, 300), (200 + i, 900), 30, 2)
        return img

    def test_all_marks_found_on_a_clean_sheet(self):
        import cv2
        import numpy as np

        res = og.registration_marks_check(cv2, np, self._sheet(), og.DEFAULT_CONFIG)
        self.assertEqual(res["found"], 6)

    def test_shifted_page_loses_marks(self):
        import cv2
        import numpy as np

        shifted = np.roll(self._sheet(), 70, axis=0)
        res = og.registration_marks_check(cv2, np, shifted, og.DEFAULT_CONFIG)
        self.assertLess(res["found"], 5)

    def test_blur_lowers_sharpness(self):
        import cv2
        import numpy as np

        sharp = og.sharpness_metrics(cv2, np, self._sheet())
        blurred = og.sharpness_metrics(cv2, np, cv2.GaussianBlur(self._sheet(), (0, 0), 6))
        self.assertGreater(sharp["sharp"], og.MIN_SHARPNESS)
        self.assertLess(blurred["sharp"], og.MIN_SHARPNESS)


class RegistrationMarkSizeTests(unittest.TestCase):
    """6.5 mm squares (new sheets) and 4.5 mm squares (old sheets) both anchor."""

    def _find(self, width, mark_mm):
        import cv2
        import numpy as np

        px_per_mm = width / 210.0
        height = int(width * 297 / 210)
        img = np.full((height, width), 235, np.uint8)
        side = int(round(mark_mm * px_per_mm))
        cx, cy = int(10.25 * px_per_mm), int(14.25 * px_per_mm)
        img[cy - side // 2 : cy + side // 2, cx - side // 2 : cx + side // 2] = 15
        x, y, conf = og.find_corner_anchor(
            img, np, 0, 0, int(0.18 * width), int(0.18 * height), prefer="top",
        )
        return x, y, conf, (cx, cy)

    def test_new_and_old_marks_found_at_phone_resolutions(self):
        for width in (1200, 1600, 2000, 2600):
            for mark_mm in (4.5, 6.5):
                x, y, conf, (cx, cy) = self._find(width, mark_mm)
                self.assertGreaterEqual(conf, 0.45, (width, mark_mm))
                self.assertLessEqual(abs(x - cx) + abs(y - cy), 3, (width, mark_mm))


class CapsuleFieldInkTests(unittest.TestCase):
    """Empty Name / Section boxes must be reported empty (no OCR on blank paper)."""

    def _sheet(self, name_text: bool, section_text: bool):
        import cv2
        import numpy as np

        h, w = 1414, 1000
        img = np.full((h, w), 215, np.uint8)
        # Light paper noise / shading must not count as writing.
        rng = np.random.default_rng(3)
        img = np.clip(img + rng.normal(0, 3, img.shape), 0, 255).astype(np.uint8)
        mm = w / 210.0
        if name_text:
            cv2.putText(img, "Mohamed Ali", (int(60 * mm), int(23 * h / 297)),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.3, 40, 3)
        if section_text:
            cv2.putText(img, "40", (int(162 * mm), int(23 * h / 297)),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.3, 40, 3)
        return cv2, np, img

    def test_empty_fields(self):
        cv2, np, img = self._sheet(False, False)
        self.assertEqual(og.capsule_fields_written(cv2, np, img), (False, False))

    def test_written_fields(self):
        cv2, np, img = self._sheet(True, True)
        self.assertEqual(og.capsule_fields_written(cv2, np, img), (True, True))

    def test_only_one_field_written(self):
        cv2, np, img = self._sheet(True, False)
        self.assertEqual(og.capsule_fields_written(cv2, np, img), (True, False))
        cv2, np, img = self._sheet(False, True)
        self.assertEqual(og.capsule_fields_written(cv2, np, img), (False, True))


class CrossedOutBubbleTests(unittest.TestCase):
    """A bubble crossed out with an X is ignored when reading answers."""

    W, H = 1000, 500
    RADIUS = 13

    def _sheet(self, marks):
        """marks: {row: [(option_idx, 'fill' | 'cross' | 'both')]} on a 5-row grid."""
        import cv2
        import numpy as np

        img = np.full((self.H, self.W, 3), 235, np.uint8)
        grid = {
            "columns": [{"startQuestion": 1, "count": 5, "bubbleAX": 0.3, "rowYStart": 0.2}],
            "options": ["A", "B", "C", "D"],
            "bubbleXStep": 0.0325,
            "rowYStep": 0.1,
            "bubbleRadius": self.RADIUS / self.W,
            "fillThreshold": 0.28,
            "darknessDifferential": 1.5,
        }
        for row in range(5):
            cy = int((0.2 + row * 0.1) * self.H)
            for opt in range(4):
                cx = int((0.3 + opt * 0.0325) * self.W)
                cv2.circle(img, (cx, cy), self.RADIUS, (40, 40, 40), 2)
        for row, items in marks.items():
            cy = int((0.2 + row * 0.1) * self.H)
            for opt, kind in items:
                cx = int((0.3 + opt * 0.0325) * self.W)
                if kind in ("fill", "both"):
                    cv2.circle(img, (cx, cy), self.RADIUS - 2, (120, 20, 20), -1)
                if kind in ("cross", "both"):
                    # Slightly lopsided X whose arms poke out of the ring.
                    r = int(self.RADIUS * 1.7)
                    cv2.line(img, (cx - r, cy - r), (cx + r - 3, cy + r), (120, 20, 20), 3)
                    cv2.line(img, (cx + r, cy - r + 2), (cx - r + 4, cy + r), (120, 20, 20), 3)
        return cv2, np, img, {"answerGrid": grid, "_trustedGeometry": True}

    def _grade(self, marks):
        # Answered rows below anchor the grid calibration like a real sheet.
        marks = {**{r: [(r % 4, "fill")] for r in range(1, 5)}, **marks}
        cv2, np, img, cfg = self._sheet(marks)
        darkness = og.ink_darkness_map(cv2, np, img)
        return og.analyze_answer_grid(darkness, np, cfg, {})

    def test_crossed_bubble_ignored_next_to_real_answer(self):
        answers, details, _ = self._grade({0: [(0, "fill"), (1, "both")]})
        self.assertEqual(answers["1"], "A")
        self.assertEqual(details[0]["status"], "answered")
        self.assertEqual(details[0]["crossedOut"], ["B"])

    def test_crossed_bubble_alone_is_blank(self):
        answers, details, _ = self._grade({0: [(1, "both")]})
        self.assertEqual(answers["1"], "")
        self.assertEqual(details[0]["status"], "blank")

    def test_normal_marks_unaffected(self):
        answers, details, dbg = self._grade({0: [(0, "fill")]})
        self.assertEqual([answers[str(i)] for i in range(1, 6)], ["A", "B", "C", "D", "A"])
        self.assertEqual(dbg["crossedOut"], 0)

    def test_two_plain_marks_still_multiple(self):
        _, details, _ = self._grade({0: [(0, "fill"), (1, "fill")]})
        self.assertEqual(details[0]["status"], "multiple")


if __name__ == "__main__":
    unittest.main(verbosity=2)
