// tab 을 끌어 놓을 자리 판정. DOM 을 보지 않고 사각형과 포인터 좌표만으로 계산한다.

import type { DropPosition } from "../../layout/layout-operations.ts";

interface DropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 가장자리 구역이 차지하는 비율. 안쪽 가운데가 나머지를 차지한다. */
const edgeRatio = 1 / 3;

/**
 * pane 을 다섯 구역으로 나눠 포인터가 어느 쪽에 있는지 돌려준다.
 * 모서리처럼 두 축이 함께 가장자리면 더 가까운 쪽 축을 고른다.
 */
export function resolveDropZone(
  pointerX: number,
  pointerY: number,
  rect: DropRect,
): DropPosition {
  const leftRatio = (pointerX - rect.x) / rect.width;
  const topRatio = (pointerY - rect.y) / rect.height;
  const horizontalEdge = Math.min(leftRatio, 1 - leftRatio);
  const verticalEdge = Math.min(topRatio, 1 - topRatio);

  if (horizontalEdge >= edgeRatio && verticalEdge >= edgeRatio) return "center";
  if (horizontalEdge <= verticalEdge) return leftRatio < 0.5 ? "left" : "right";
  return topRatio < 0.5 ? "top" : "bottom";
}

/**
 * 놓아도 배치가 그대로인 자리인가. 그런 구역은 미리 보기에 표시하지 않는다 —
 * 배치가 한 번 깜빡이고 제자리로 돌아오면 사용자가 실패로 오해한다.
 */
export function isUnchangedDrop(
  sourcePaneId: string,
  sourcePaneTabCount: number,
  targetPaneId: string,
  position: DropPosition,
): boolean {
  if (sourcePaneId !== targetPaneId) return false;
  // 자기 pane 의 가운데는 자리도 순서도 그대로다.
  if (position === "center") return true;
  // tab 이 하나뿐이면 옮긴 tab 을 잃은 원본 pane 이 붕괴해 분할 전과 같아진다.
  return sourcePaneTabCount === 1;
}
