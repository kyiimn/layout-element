/**
 * 엔진 계층 전용 LRU 캐시.
 *
 * `@/utils`의 LRU는 DOM 의존성을 가질 수 있어 엔진 계층(Node.js 호환)에서는
 * 이 최소 구현을 사용한다. `paragraph-engine.ts`에서 분리한 순수 자료구조다.
 *
 * @file src/engine/lru-engine.ts
 */

/**
 * ParagraphEngine 내부 전용 LRU 캐시.
 * `@/utils` DOM 의존성을 피하기 위해 엔진 파일에 최소 구현.
 *
 * @template K - 키 타입
 * @template V - 값 타입
 * @throws RangeError - capacity가 양의 정수가 아닐 때 (생성자)
 */
export class _LRU<K, V> {
  private readonly _map: Map<K, V> = new Map();
  private readonly _capacity: number;

  /**
   * @param capacity - 최대 보관 항목 수 (양의 정수)
   * @throws RangeError - capacity가 양의 정수가 아닐 때
   */
  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new RangeError("LRU capacity must be a positive integer");
    }
    this._capacity = capacity;
  }

  /**
   * 키의 값을 조회하고 최근 사용 순서로 승격한다.
   *
   * @param key - 조회 키
   * @returns 키에 대응하는 값. 없으면 `undefined`
   * @throws 없음
   */
  get(key: K): V | undefined {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key)!;
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  /**
   * 키-값을 저장한다. 용량 초과 시 가장 오래된 항목을 축출한다.
   *
   * @param key - 저장 키
   * @param value - 저장 값
   * @throws 없음
   */
  set(key: K, value: V): void {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._capacity) {
      const oldest = this._map.keys().next();
      if (!oldest.done) {
        this._map.delete(oldest.value);
      }
    }
    this._map.set(key, value);
  }
}