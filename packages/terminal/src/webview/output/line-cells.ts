// 버퍼 한 줄을 텍스트로 읽으면서, 텍스트 위치가 화면의 어느 칸인지도 함께 기록한다.
// 한글·한자·이모지 같은 넓은 글자는 텍스트에서 한 글자지만 화면에서 2칸을 차지하고, 결합 문자는
// 여러 글자가 한 칸에 들어간다. 그래서 텍스트 위치를 칸 번호로 그대로 쓰면 어긋난다. 칸의 폭은
// 에뮬레이터 버퍼가 기록한 값을 쓴다 — 화면이 그 값대로 그려지기 때문이다.

/** 버퍼 줄의 한 칸. 넓은 글자는 앞 칸에 글자와 폭(2)이 있고, 뒤 칸은 폭 0 이다. */
export interface LineCell {
  readonly chars: string;
  readonly width: number;
}

/** 칸 구간 — 1부터 센 칸 번호이고 끝 칸을 포함한다(에뮬레이터 링크 범위의 단위). */
export interface ColumnRange {
  readonly startColumn: number;
  readonly endColumn: number;
}

export interface CellMappedLine {
  readonly text: string;
  /** 텍스트 구간 [startIndex, startIndex + length) 이 화면에서 차지하는 칸 구간. length 는 1 이상이다. */
  columnRangeOf(startIndex: number, length: number): ColumnRange;
}

/** cells 는 칸 번호 순서의 줄 전체다 — 배열 위치가 곧 칸 번호(0부터)다. */
export function mapLineCells(cells: readonly LineCell[]): CellMappedLine {
  let text = "";
  // 텍스트의 코드 유닛마다, 그 글자가 놓인 칸 구간의 첫 칸·끝 칸.
  const firstColumns: number[] = [];
  const lastColumns: number[] = [];
  cells.forEach((cell, columnIndex) => {
    // 넓은 글자의 뒤 칸이다 — 앞 칸에서 이미 읽었다.
    if (cell.width === 0) return;
    // 빈 칸은 공백으로 읽는다. 에뮬레이터의 줄 텍스트 변환과 같다.
    const chars = cell.chars.length === 0 ? " " : cell.chars;
    for (let unitIndex = 0; unitIndex < chars.length; unitIndex++) {
      firstColumns.push(columnIndex + 1);
      lastColumns.push(columnIndex + cell.width);
    }
    text += chars;
  });
  return {
    text,
    columnRangeOf: (startIndex, length) => ({
      startColumn: firstColumns[startIndex],
      endColumn: lastColumns[startIndex + length - 1],
    }),
  };
}
