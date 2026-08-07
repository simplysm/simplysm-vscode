// tab 에 보일 이름의 해석. 확정 값 정리와 셸 이름 뽑기만 하고 화면은 건드리지 않는다.

/** 지정 이름의 길이 상한. 넘는 값이 들어와도 tab 줄의 다른 요소가 밖으로 밀리지 않게 자른다. */
export const assignedNameMaxLength = 100;

/**
 * 사용자가 확정한 이름을 보관할 값으로 정리한다. 개행·제어문자를 없애 한 줄로 만들고 앞뒤
 * 공백을 자르며, 남는 것이 없으면 지정 해제로 본다 (없음을 빈 문자열로 대신하지 않는다).
 */
export function normalizeAssignedName(raw: string): string | undefined {
  const singleLine = raw.replaceAll(/[\p{Cc}\p{Cf}]/gu, "");
  const trimmed = singleLine.trim().slice(0, assignedNameMaxLength).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 세션을 띄운 실행 파일 이름. 내장 터미널이 Windows 에서 보이는 것과 같게 확장자는 뗀다. */
export function shellDisplayName(shellPath: string): string {
  const fileName = shellPath.split(/[\\/]/).at(-1) ?? "";
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  return withoutExtension.length === 0 ? fileName : withoutExtension;
}
