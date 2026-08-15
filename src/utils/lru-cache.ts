/**
 * Generic LRU (Least Recently Used) cache.
 *
 * Maintains insertion-order eviction via a `Map` (iterates in insertion order):
 * when capacity is exceeded, the oldest entry is removed. Accessing a key
 * (via `get`) promotes it to the end (most-recently-used).
 *
 * @template K - Key type
 * @template V - Value type
 *
 * @example
 * ```ts
 * const cache = new LRU<string, number>(3);
 * cache.set('a', 1);
 * cache.set('b', 2);
 * cache.set('c', 3);
 * cache.get('a');        // 1 — promotes 'a' to most-recently-used
 * cache.set('d', 4);     // evicts 'b' (least recently used)
 * cache.has('b');        // false
 * cache.size;            // 3
 * ```
 */
export class LRU<K, V> {
  private readonly _map: Map<K, V> = new Map();
  private readonly _capacity: number;

  /**
   * @param capacity - 최대 항목 수. 초과 시 가장 오래 사용되지 않은 항목부터 제거.
   * @throws {RangeError} capacity가 0 이하인 경우
   */
  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new RangeError('LRU capacity must be a positive integer');
    }
    this._capacity = capacity;
  }

  /**
   * 키에 해당하는 값을 반환하고, 해당 항목을 최근 사용 위치로 이동한다.
   * @param key - 조회할 키
   * @returns 값. 키가 없으면 `undefined`.
   */
  get(key: K): V | undefined {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key)!;
    // Delete + re-insert to promote to end (most-recently-used)
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  /**
   * 키 존재 여부를 확인한다. `get`과 달리 사용 순서를 변경하지 않는다.
   * @param key - 확인할 키
   * @returns 키가 존재하면 `true`, 아니면 `false`.
   */
  has(key: K): boolean {
    return this._map.has(key);
  }

  /**
   * 키-값 쌍을 저장한다. 용량 초과 시 가장 오래 사용되지 않은 항목을 제거한다.
   * @param key - 키
   * @param value - 값
   */
  set(key: K, value: V): void {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._capacity) {
      // Evict oldest (first entry in iteration order)
      const oldest = this._map.keys().next();
      if (!oldest.done) {
        this._map.delete(oldest.value);
      }
    }
    this._map.set(key, value);
  }

  /**
   * 키를 삭제한다.
   * @param key - 삭제할 키
   * @returns 삭제 성공 시 `true`, 키가 없으면 `false`.
   */
  delete(key: K): boolean {
    return this._map.delete(key);
  }

  /** 현재 항목 수를 반환한다. */
  get size(): number {
    return this._map.size;
  }

  /** 모든 항목을 제거한다. */
  clear(): void {
    this._map.clear();
  }
}