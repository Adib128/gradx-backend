#!/usr/bin/env python3
import json
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"confidence": 0.0, "decodedFormId": None, "answers": {}, "debug": {"error": "missing_image"}})
        return

    image_path = sys.argv[1]

    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except Exception as exc:
        emit(
            {
                "confidence": 0.0,
                "decodedFormId": None,
                "answers": {},
                "debug": {"error": "opencv_not_available", "details": str(exc)},
            }
        )
        return

    image = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        emit({"confidence": 0.0, "decodedFormId": None, "answers": {}, "debug": {"error": "image_read_failed"}})
        return

    # Basic preprocessing and adaptive threshold to isolate bubble marks.
    blurred = cv2.GaussianBlur(image, (5, 5), 0)
    binary = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 6
    )

    h, w = binary.shape
    marker_crop = binary[int(h * 0.58) : int(h * 0.72), int(w * 0.92) : int(w * 0.97)]
    marker_ratio = float(np.mean(marker_crop) / 255.0) if marker_crop.size else 0.0
    decoded_form_id = int(marker_ratio * 999) % 100 if marker_crop.size else None

    answers = {}
    answer_top = int(h * 0.33)
    answer_bottom = int(h * 0.92)
    answer_left = int(w * 0.53)
    answer_right = int(w * 0.93)

    if answer_bottom > answer_top and answer_right > answer_left:
        answer_roi = binary[answer_top:answer_bottom, answer_left:answer_right]
        rows = 50
        cols = 5
        row_h = max(1, answer_roi.shape[0] // rows)
        col_w = max(1, answer_roi.shape[1] // cols)
        labels = ["A", "B", "C", "D", "E"]

        for row in range(rows):
            y0 = row * row_h
            y1 = min(answer_roi.shape[0], (row + 1) * row_h)
            if y1 <= y0:
                continue
            darkness = []
            for col in range(cols):
                x0 = col * col_w
                x1 = min(answer_roi.shape[1], (col + 1) * col_w)
                if x1 <= x0:
                    darkness.append(0.0)
                    continue
                cell = answer_roi[y0:y1, x0:x1]
                darkness.append(float(np.mean(cell) / 255.0))
            best_idx = int(np.argmax(np.array(darkness)))
            if darkness[best_idx] > 0.18:
                answers[str(row + 1)] = labels[best_idx]

    confidence = min(0.95, 0.4 + (len(answers) / 100.0))
    emit(
        {
            "confidence": confidence,
            "decodedFormId": decoded_form_id,
            "answers": answers,
            "debug": {"detectedAnswers": len(answers)},
        }
    )


if __name__ == "__main__":
    main()
