/**
 * Place Gun으로 장전할 컨텐츠의 종류.
 *
 * - `'text'`: 텍스트 단락. 클릭 위치의 paragraph 요소에 텍스트를 주입한다.
 * - `'image'`: 이미지. 클릭 위치의 image 요소에 이미지 URL을 주입한다.
 *
 * @readonly
 */
export type PlaceGunContentType = 'text' | 'image';

/**
 * Place Gun 항목의 세부 종류. 이미지/광고의 URL 패턴을 결정한다.
 *
 * - `'article'`: 기사. `contentType === 'text'`와 함께 사용.
 * - `'image'`: 이미지. `contentType === 'image'`와 함께 사용.
 * - `'ad'`: 광고. `contentType === 'image'`와 함께 사용.
 *
 * @readonly
 */
export type PlaceGunSubType = 'article' | 'image' | 'ad';

/**
 * 기사 컨텐츠의 본문 데이터.
 */
export type ArticleContent = {
  /** 기사 고유 식별자. */
  uid: string;
  /** 기사 제목. */
  title: string;
  /** 기사 본문 텍스트. */
  body: string;
};

/**
 * 이미지/광고 컨텐츠의 본문 데이터.
 */
export type ImageContent = {
  /** 이미지/광고 고유 식별자. */
  uid: string;
  /** 이미지/광고 설명 (캡션). */
  caption: string;
  /** 이미지/광고 접근 URL. */
  url: string;
  /** 원본 이미지 너비 (픽셀). */
  width: number;
  /** 원본 이미지 높이 (픽셀). */
  height: number;
  /** 이미지 해상도 (DPI). */
  dpi: number;
};

/**
 * Place Gun에 장전된 단일 컨텐츠 항목.
 *
 * InDesign의 Place Gun 개념을 차용하여, 메모리에 순차적으로 장전된
 * 컨텐츠를 문서 위에서 클릭할 때마다 하나씩 배치한다.
 * 리스트의 맨 앞(index 0)이 "다음으로 쏠 항목"이다.
 *
 * @example
 * ```ts
 * const articleItem: PlaceGunItem = {
 *   contentType: 'text',
 *   subType: 'article',
 *   title: '기사 제목',
 *   sourceId: 'article-123',
 *   content: { uid: 'article-123', title: '기사 제목', body: '오늘의 뉴스...' },
 * };
 *
 * const imageItem: PlaceGunItem = {
 *   contentType: 'image',
 *   subType: 'image',
 *   title: '사진 제목',
 *   sourceId: 'img-456',
 *   content: { uid: 'img-456', caption: '캡션 설명', url: '/storage/image/img-456?variant=work' },
 * };
 * ```
 */
export type PlaceGunItem = {
  /** 컨텐츠 종류 (text 또는 image). */
  contentType: PlaceGunContentType;
  /** 세부 종류. URL 패턴 결정에 사용. */
  subType: PlaceGunSubType;
  /** 패널에 표시할 항목 제목. */
  title: string;
  /** 원본 컨텐츠의 고유 식별자 (API ID, 파일 경로 등). */
  sourceId: string;
  /**
   * 컨텐츠 본문 데이터.
   * - `contentType === 'text'`: {@link ArticleContent} (uid, title, body).
   * - `contentType === 'image'`: {@link ImageContent} (uid, caption).
   */
  content: ArticleContent | ImageContent;
};

/**
 * Place Gun 상태 변경 이벤트의 상세 정보.
 *
 * `placeGunChange` 이벤트 리스너로 전달되며, 항목 리스트나 일시정지
 * 상태가 변경되었을 때 디스패치된다.
 */
export type PlaceGunChangeEventDetail = {
  /** 변경 후 장전된 항목 리스트 (얕은 복사). */
  items: PlaceGunItem[];
  /** 변경 후 일시정지 여부. */
  paused: boolean;
};

/**
 * `placeGunBefore` 이벤트의 상세 정보.
 *
 * Place Gun 항목이 box에 주입되기 **직전**에 디스패치된다.
 * 호스트 프로그램은 이 이벤트를 수신하여 주입 전 사전 작업(로그 기록,
 * 검증, UI 피드백 등)을 수행할 수 있다.
 *
 * @example
 * ```ts
 * manager.addEventListener('placeGunBefore', (event) => {
 *   const detail = event.placeGunBeforeDetail!;
 *   console.log('주입 예정:', detail.item.title, '→ box:', detail.box.id);
 * });
 * ```
 */
export type PlaceGunBeforeEventDetail = {
  /** 주입할 Place Gun 항목. */
  item: PlaceGunItem;
  /** 주입 대상 box 요소. */
  box: HTMLElement;
};

/**
 * `placeGunAfter` 이벤트의 상세 정보.
 *
 * Place Gun 항목이 box에 주입된 **직후**에 디스패치된다.
 * 주입 성공 여부와 주입된 항목/box 정보를 포함한다.
 *
 * @example
 * ```ts
 * manager.addEventListener('placeGunAfter', (event) => {
 *   const detail = event.placeGunAfterDetail!;
 *   console.log('주입 완료:', detail.item.title, '→ box:', detail.box.id, '성공:', detail.success);
 * });
 * ```
 */
export type PlaceGunAfterEventDetail = {
  /** 주입된 Place Gun 항목. */
  item: PlaceGunItem;
  /** 주입 대상 box 요소. */
  box: HTMLElement;
  /** 주입 성공 여부. 매칭 실패 시 `false`. */
  success: boolean;
};