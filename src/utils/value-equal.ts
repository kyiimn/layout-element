/**
 * 두 값이 의미적으로 같은지 비교한다.
 * `number`와 `number[]` 타입에 대해 깊은 동등성 검사를 수행하며,
 * 참조가 같거나 원시값이 같으면 즉시 `true`를 반환한다.
 *
 * @param a - 비교할 첫 번째 값. `number`, `number[]`, 또는 `undefined`
 * @param b - 비교할 두 번째 값. `number`, `number[]`, 또는 `undefined`
 * @returns 두 값이 의미적으로 같으면 `true`, 다르면 `false`
 *
 * @example
 * valueEqual(3, 3)              // true
 * valueEqual([1, 2], [1, 2])    // true (배열 내용이 같음)
 * valueEqual([1, 2], [1, 3])    // false
 * valueEqual(undefined, 0)      // false
 * valueEqual(3, undefined)      // false
 */
export function valueEqual(
  a: number | number[] | undefined,
  b: number | number[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return false;
}