/**
 * 자동 체인 분할 (감사 §6.7.5 옵션 B — 기사 단위 정책).
 *
 * 신문 텍스트 흐름은 무한 체인이 아니라 기사(article) 단위다. 이 모듈은
 * 엔진 트리에서 `role === 'group-article'` 박스를 감지해 소속 body 박스의
 * 문단(스레드 프레임)을 기사별 체인(`ThreadData`)으로 조립하는 **순수 함수**를
 * 제공한다. 체인의 story(`content`)는 발명하지 않는다 — `content: undefined`로
 * 두고 `ThreadEngine`의 `thread.content ?? head.textContent` 폴백
 * (thread-engine.ts step-1)이 head 프레임이 소유한 텍스트를 story로 쓰게 한다.
 *
 * 감지 근거 (단일 소스):
 * - `BoxData.role === 'group-article'` — 기사 그룹 컨테이너 (box.type.ts).
 * - `BoxData.contentUid` — 기사 UID. Place Gun 기사 주입이 body/title box에
 *   기록한다 (EDITING_PLACE_GUN.md §4.3 케이스 1). 페이지 경계를 가로지르는
 *   동일 기사 흐름의 그룹핑 키다.
 * - 소속 group-article 박스 id — contentUid가 없는 박스들의 폴백 키.
 *
 * 그룹핑은 **engine 데이터의 문서 순서**(페이지 순서 → 박스 트리 선순회)를
 * 따른다. id 충돌·이중 소속은 `ThreadEngine.validate`의 first-claim-wins가
 * 방어하되, 이 모듈은 claimed 프레임을 애초에 수집하지 않는다 (RULES §1.10).
 *
 * 순수 함수 계약: 어떤 엔진 상태도 변이하지 않는다 — 반환 배열은 소비자가
 * `DocumentEngine.data.threads`에 합쳐 넣는다. DOM을 참조하지 않는다
 * (Node.js 호환 — verify-engine-node 방어, RULES.md §3).
 *
 * @file src/engine/auto-thread-splitter.ts
 */

import type { ThreadData } from "@/types";
import { BoxEngine } from "./box-engine";
import type { PageEngine } from "./page-engine";
import { ParagraphEngine } from "./paragraph-engine";
import { TableEngine } from "./table-engine";

/**
 * 자동 체인 후보 프레임의 소속 판정 정보.
 *
 * `collectAutoThreadChains` 내부에서만 소비되는 중간 구조다.
 */
interface BodyFrameRef {
  /** 프레임 문단 id (프레임 엔진의 id — 없으면 수집 단계에서 제외) */
  id: string;
  /** 그룹핑 키 — body 박스의 contentUid(기사 UID) 우선, 없으면 소속 group-article 박스 id */
  groupKey: string;
}

/**
 * 박스 엔진 트리에서 body 박스(프레임 소유 후보)를 선순회하며 수집한다.
 *
 * 순회는 `findBoxEnginesByRole`와 동일한 전위(depth-first, 선언 순서) 방식이며,
 * 테이블 셀 내부 박스도 관통한다. group-article 박스는 groupKey 결정을 위해
 * id가 필요하므로 수집 중 함께 전달한다.
 *
 * @param box - 순회 대상 박스 엔진
 * @param ownerGroupArticleId - 조상 중 가장 가까운 group-article 박스 id (없으면 undefined)
 * @param out - 수집 결과 누적 버퍼 (변이 대상 — 재귀 공유)
 * @param visited - 방문한 group-article 박스 집합 (같은 박스 재방문 방지)
 */
function collectBodyBoxes(
  box: BoxEngine,
  ownerGroupArticleId: string | undefined,
  out: BodyFrameRef[],
  visited: Set<BoxEngine>,
): void {
  const isGroupArticle = box.role === 'group-article';
  const groupArticleId = isGroupArticle ? box.data.id : ownerGroupArticleId;

  if (box.role === 'body') {
    // 그룹핑 키: 기사 UID(contentUid) 우선 — 페이지 경계를 넘는 동일 기사 흐름을
    // 하나의 체인으로 묶는 단일 소스. 없으면 소속 group-article 박스 id로 폴백.
    const groupKey = box.data.contentUid ?? (groupArticleId ?? '');
    const para = findFirstParagraphEngine(box);
    if (para && para.id && groupKey !== '') {
      out.push({ id: para.id, groupKey });
    }
    // body 박스 자체가 contentUid를 가지면 하위 박스는 같은 기사로 귀속될 수
    // 없다(문단은 body당 1개 게이트) — 더 깊이 수집하지 않는다.
    return;
  }

  for (const child of box.childEngines) {
    if (child instanceof BoxEngine) {
      collectBodyBoxes(child, groupArticleId, out, visited);
    } else if (child instanceof TableEngine) {
      for (const rowEngine of child.rowEngines) {
        for (const cellEngine of rowEngine.cellEngines) {
          const cellBox = cellEngine.boxEngine;
          if (cellBox) collectBodyBoxes(cellBox, groupArticleId, out, visited);
        }
      }
    }
  }
}

/**
 * 박스가 소유한 첫 번째 ParagraphEngine을 찾는다 (트리 선순회).
 *
 * @param box - 검색 대상 박스
 * @returns 첫 번째 문단 엔진. 없으면 undefined.
 */
function findFirstParagraphEngine(box: BoxEngine): ParagraphEngine | undefined {
  for (const child of box.childEngines) {
    if (child instanceof ParagraphEngine) return child;
  }
  for (const child of box.childEngines) {
    if (child instanceof BoxEngine) {
      const found = findFirstParagraphEngine(child);
      if (found) return found;
    } else if (child instanceof TableEngine) {
      for (const rowEngine of child.rowEngines) {
        for (const cellEngine of rowEngine.cellEngines) {
          const cellBox = cellEngine.boxEngine;
          if (!cellBox) continue;
          const found = findFirstParagraphEngine(cellBox);
          if (found) return found;
        }
      }
    }
  }
  return undefined;
}

/**
 * group-article 박스들을 문서 트리에서 선순회 수집한다.
 *
 * @param page - 페이지 엔진
 * @returns group-article 박스 배열 (문서 순서)
 */
function collectGroupArticles(page: PageEngine): BoxEngine[] {
  return page.findBoxEnginesByRole('group-article');
}

/**
 * 엔진 트리에서 기사별 자동 스레드 체인을 수집한다.
 *
 * 알고리즘 (감사 §6.7.5 분할 알고리즘):
 * 1. 전 페이지의 group-article 박스를 문서 순서로 수집.
 * 2. 각 group-article 내 body 박스(트리 선순회·테이블 셀 관통)의 첫 문단을
 *    그룹핑 키별로 수집 — 키는 body.contentUid(기사 UID) 우선, 없으면 소속
 *    group-article 박스 id.
 * 3. 문서 순서로 이어 붙여 체인 1개를 만든다 (기사가 페이지를 넘나들면
 *    페이지 순서가 곧 흐름 순서다).
 *
 * 보수 게이트 (오동작 방지 — 기존 문서 영향 0):
 * - `existingParagraphIds`에 이미 소속된 프레임은 수집하지 않는다 (first-claim-wins,
 *   이중 소속 금지 — RULES §1.10).
 * - 이미 스레드 프레임(`isThreadFrame`)이거나 story 전체를 소유한 문단은
 *   "이전 분할의 결과"이므로 재수집한다 — 다만 **이전 분할 head가 아닌** 문단
 *   (story 일부 slice만 소유)이 body의 첫 문단 자리에 있고 비어 있지 않으면
 *   수집하지 않는다 (사용자가 직접 넣은 콘텐츠 보호).
 * - 체인은 프레임 2개 이상일 때만 생성한다 (단일 프레임 체인은 스레딩 이득 0).
 * - 체인 head 이후 프레임이 스레드 프레임이 아니면서 비어 있지 않으면
 *   (호스트가 의미 있는 독립 콘텐츠를 넣어 둔 경우) 그 프레임은 체인에서
 *   제외하고, 남은 프레임으로 체인을 구성한다. 제외 후 1프레임이 되면 생성
 *  하지 않는다.
 * - id 없는 문단은 수집할 수 없다 (체인 키가 id다).
 *
 * @param pages - 페이지 엔진 배열 (문서 순서)
 * @param existingThreads - 데이터에 명시된 기존 스레드 (이중 소속 방지용)
 * @returns 자동 생성된 스레드 배열. 감지 결과가 없으면 빈 배열.
 *   story는 발명하지 않는다 — `content`는 항상 undefined.
 *
 * @example
 * ```ts
 * // group-article A(body 2프레임) + B(body 1프레임) 문서에서:
 * const auto = collectAutoThreadChains(
 *   docEngine.pageEngines,
 *   docEngine.data.threads,
 * );
 * // → [
 * //   { id: 'auto-article-a', paragraphIds: ['p1', 'p2'], content: undefined },
 * //   // B는 1프레임이라 제외
 * // ]
 * ```
 *
 * @example
 * ```ts
 * // 기사가 2페이지에 걸치는 경우 — contentUid가 그룹핑 키라 하나의 체인:
 * // page1 body(contentUid: 'a1') → p1, page2 body(contentUid: 'a1') → p2
 * const auto = collectAutoThreadChains(pages, []);
 * // → [{ id: 'auto-a1', paragraphIds: ['p1', 'p2'], content: undefined }]
 * ```
 *
 * @throws Error 페이지 엔진이 아닌 요소가 포함된 경우는 발생하지 않는다 —
 *   타입 시그니처가 이를 컴파일 타임에 배제한다 (동적 방어 없음).
 */
export function collectAutoThreadChains(
  pages: readonly PageEngine[],
  existingThreads: readonly ThreadData[] | undefined,
): ThreadData[] {
  const claimed = new Set<string>();
  for (const thread of existingThreads ?? []) {
    for (const id of thread.paragraphIds ?? []) {
      if (id) claimed.add(id);
    }
  }

  // 그룹핑 키 → 문서 순서 프레임 id 누적
  const order: string[] = [];
  const framesByGroup = new Map<string, string[]>();
  for (const page of pages) {
    for (const groupArticle of collectGroupArticles(page)) {
      const refs: BodyFrameRef[] = [];
      collectBodyBoxes(groupArticle, undefined, refs, new Set());
      for (const ref of refs) {
        if (claimed.has(ref.id)) continue;
        let list = framesByGroup.get(ref.groupKey);
        if (!list) {
          list = [];
          framesByGroup.set(ref.groupKey, list);
          order.push(ref.groupKey);
        }
        list.push(ref.id);
      }
    }
  }

  const auto: ThreadData[] = [];
  for (const groupKey of order) {
    const ids = framesByGroup.get(groupKey);
    if (!ids || ids.length < 2) continue;

    // head 선규칙: 첫 "내용이 있는" 프레임을 head로. 사용자가 head 후보를
    // 비워 둔 경우(빈 body 먼저 배치) story가 빈 문자열로 고정되는 것을 방지한다.
    // story 폴백(thread.content ?? head.textContent)이 head의 live textContent를
    // 쓰므로, 비어 있는 head는 story를 ''로 소멸시킨다.
    const headIdx = ids.findIndex(id => {
      const pe = findParagraphIn(pages, id);
      return pe !== undefined && pe.plainText.length > 0;
    });
    if (headIdx < 0) continue; // 전 프레임 비어 있음 — story 원천 없음
    if (headIdx > 0) ids.push(...ids.splice(0, headIdx));

    // 보호 게이트: head 이후 프레임이 (a) 스레드 프레임이 아니면서 (b) 비어
    // 있지 않으면, 사용자가 독립 콘텐츠를 넣어 둔 것이라 간주해 체인에서
    // 제외한다. 이전 분할의 결과 프레임은 isThreadFrame이므로 재수집된다.
    const chain: string[] = [ids[0]];
    for (let i = 1; i < ids.length; i++) {
      const pe = findParagraphIn(pages, ids[i]);
      if (pe === undefined) continue;
      if (!pe.isThreadFrame && pe.plainText.length > 0) continue;
      chain.push(ids[i]);
    }
    if (chain.length < 2) continue;

    auto.push({
      id: `auto-thread-${groupKey}`,
      paragraphIds: chain,
      // content: undefined — head 프레임의 live textContent가 story 폴백된다
      // (ThreadEngine step-1: thread.content ?? head.textContent).
    });
  }
  return auto;
}

/**
 * 전 페이지 트리에서 문단 id로 ParagraphEngine을 찾는다.
 *
 * @param pages - 페이지 엔진 배열
 * @param id - 문단 id
 * @returns 일치하는 문단 엔진. 없으면 undefined.
 */
function findParagraphIn(pages: readonly PageEngine[], id: string): ParagraphEngine | undefined {
  for (const page of pages) {
    const found = page.findEngineById(id);
    if (found instanceof ParagraphEngine) return found;
  }
  return undefined;
}