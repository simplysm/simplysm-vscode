# README GIF 합성 — readme-media.spec.ts 가 만든 타임스탬프 프레임(PNG)을 GIF 로 묶는다.
# 사용: python scripts/build-readme-gif.py <frames_dir> <out.gif> [width] [crop_height]
# crop_height: 리사이즈 전 원본 기준 상단 크롭 높이 (webview 하단 빈 영역 제거용)
import json
import sys
from pathlib import Path

from PIL import Image

TAIL_HOLD_MS = 1500  # 마지막 프레임 유지 — 루프 경계가 뚝 끊겨 보이지 않게


def build(frames_dir: str, out_path: str, width: int = 800, crop_height: int = 0) -> None:
    frame_paths = sorted(Path(frames_dir).glob("*.png"), key=lambda p: int(p.stem))
    if len(frame_paths) < 2:
        raise SystemExit(f"프레임이 부족합니다: {frames_dir}")

    # screencast 프레임은 창 전체 — clip.json 이 있으면 그 영역만 잘라낸다 (배율 보정 포함)
    clip_path = Path(frames_dir) / "clip.json"
    clip = json.loads(clip_path.read_text()) if clip_path.exists() else None

    times = [int(p.stem) for p in frame_paths]
    durations = [b - a for a, b in zip(times, times[1:])] + [TAIL_HOLD_MS]

    images = []
    for p in frame_paths:
        im = Image.open(p).convert("RGB")
        if clip is not None:
            scale = im.width / clip["viewportWidth"]
            im = im.crop((
                round(clip["x"] * scale),
                round(clip["y"] * scale),
                round((clip["x"] + clip["width"]) * scale),
                round((clip["y"] + clip["height"]) * scale),
            ))
            if 0 < crop_height * scale < im.height:
                im = im.crop((0, 0, im.width, round(crop_height * scale)))
        elif 0 < crop_height < im.height:
            im = im.crop((0, 0, im.width, crop_height))
        if im.width > width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        images.append(im)

    images[0].save(
        out_path,
        save_all=True,
        append_images=images[1:],
        duration=durations,
        loop=0,
        optimize=True,
    )
    size_kb = Path(out_path).stat().st_size / 1024
    print(f"{out_path}: {len(images)} frames, {size_kb:.0f} KB")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    build(
        sys.argv[1],
        sys.argv[2],
        int(sys.argv[3]) if len(sys.argv) > 3 else 800,
        int(sys.argv[4]) if len(sys.argv) > 4 else 0,
    )
