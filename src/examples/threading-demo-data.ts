import { DocumentData } from "@/types";

/**
 * 주제별 기사 본문을 생성한다. 신문 지면 형태의 반복 문장으로
 * 각 스레드가 프레임 체인을 넘을 만큼 충분한 길이를 만든다.
 *
 * @param topic - 기사 주제 키워드
 * @returns 기사 본문 (약 2330자)
 */
function newsBody(topic: string): string {
  const sentences = [
    `${topic} 논의가 활발하다. 관계 부처와 시장 참여자들이 실무 협의를 진행하고 있다.`,
    '이번 조치는 관련 시장의 구조를 실질적으로 개선할 것으로 전망된다. 현장 반응도 주목된다.',
    '세부 실행 방안은 다음 단계 협의를 거쳐 확정된다. 단계별 점검 체계도 함께 마련된다.',
    '전문가들은 제도의 실효성 확보가 관건이라고 진단한다. 이행 속도와 안정성의 균형이 중요하다.',
    '관련 시장의 의견 수렴 절차가 진행 중이다. 이해관계자들의 제안이 다양하게 접수되고 있다.',
    '국제 사례 분석도 병행되고 있다. 국내 시장 특성에 맞는 조정 방안이 검토된다.',
    '실행 과정에서의 모니터링 강화 요구가 커진다. 투명한 점검 체계가 전제 조건으로 꼽힌다.',
    '다음 분기 중 시행 계획이 조정될 가능성도 있다. 후속 발표가 이어질 전망이다.',
  ];
  return sentences.join(' ').repeat(6);
}

const thread1Story = newsBody('스레딩');
const thread2Story = newsBody('정책');
const thread3Story = newsBody('미래');

/**
 * 텍스트 스레딩 데모 문서 데이터.
 *
 * 신문 지면(323×470mm, 6단)에 3개 스레드가 흐른다:
 * - Thread 1 (우측 3단): frame1(14라인) → frame2(14라인) → frame3(12라인)
 * - Thread 2 (좌측 2단): frame1(20라인) → frame2(20라인)
 * - Thread 3 (하단): frame1(4단 10라인) → frame2(6단 10라인) → frame3(6단 10라인)
 *
 * 모든 프레임이 story 전체를 `textContent`로 받고, 엔진이 `contentFrom`
 * (이전 프레임이 소비한 오프셋)부터 배치한다 — head 프레임 데이터만 story를
 * 포함하고 후속 프레임의 `content`는 비워 둔다 (엔진이 채운다).
 *
 * 지면 레이아웃 (단 인덱스 left, 라인 top/height — static 박스):
 *
 * ```text
 * ┌────────────────────────────────────────┐
 * │ [배너]                        (6단×4)   │ top 0
 * ├──────────────────────┬─────────────────┤
 * │ [T2 제목]             │ [T1 제목]       │ top 4
 * │ T2-F1 (2단×20)        │ T1-F1 (3단×14)  │ top 7
 * │                      │ T1-F2 (3단×14)  │ top 21
 * ├──────────────────────┼─────────────────┤
 * │ T2-F2 (2단×20)        │ T1-F3 (3단×12)  │ top 35
 * ├──────────────────────┴─────────────────┤
 * │ [T3 제목]                     (6단×3)   │ top 47
 * │ T3-F1 (4단×10)                          │ top 50
 * │ T3-F2 (6단×10)                          │ top 60
 * │ T3-F3 (6단×10)                          │ top 70
 * └────────────────────────────────────────┘
 * ```
 */
export const threadingDemoData: DocumentData = {
  width: 323,
  height: 470,
  paddingTop: 14,
  paddingRight: 10,
  paddingBottom: 14,
  paddingLeft: 10,

  columns: 6,
  gap: 5,

  textStyle: {
    color: 'black',
    fontFamily: 'Myoungjo',
    fontSize: 4,
    letterSpacing: -0.15,
    widthRatio: 0.8,
    spaceRatio: 0.2,
  },
  paragraphStyle: {
    lineGap: 1.2,
    textAlign: 'justify',
  },

  threads: [
    {
      id: 'thread-1',
      paragraphIds: ['thread1-frame1', 'thread1-frame2', 'thread1-frame3'],
      content: thread1Story,
    },
    {
      id: 'thread-2',
      paragraphIds: ['thread2-frame1', 'thread2-frame2'],
      content: thread2Story,
    },
    {
      id: 'thread-3',
      paragraphIds: ['thread3-frame1', 'thread3-frame2', 'thread3-frame3'],
      content: thread3Story,
    },
  ],

  children: [
    {
      type: 'box', id: 'banner',
      left: 0, top: 0, width: 6, height: 4,
      position: 'static',
      borderBottomWidth: 1,
      borderColor: 'black',
      children: {
        type: 'text',
        content: '텍스트 스레딩 데모 — 3개 스레드가 프레임 체인으로 흐름',
        textStyle: { fontSize: 6, fontWeight: 700 },
        paragraphStyle: { textAlign: 'center', verticalAlign: 'center' },
      },
    },
    {
      type: 'box', id: 't1-title',
      left: 3, top: 4, width: 3, height: 3,
      position: 'static',
      borderTopWidth: 0.5,
      borderColor: 'black',
      children: {
        type: 'text',
        content: '[Thread 1] 우측 기사 · 3프레임',
        textStyle: { fontSize: 4, fontWeight: 700 },
        paragraphStyle: { textAlign: 'center', verticalAlign: 'center' },
      },
    },
    {
      type: 'box', id: 't1-b1',
      left: 3, top: 7, width: 3, height: 14,
      position: 'static',
      children: {
        id: 'thread1-frame1', type: 'paragraph',
        content: thread1Story,
        column: 3, gap: 5,
      },
    },
    {
      type: 'box', id: 't1-b2',
      left: 3, top: 21, width: 3, height: 14,
      position: 'static',
      children: {
        id: 'thread1-frame2', type: 'paragraph',
        content: '',
        column: 3, gap: 5,
      },
    },
    {
      type: 'box', id: 't1-b3',
      left: 3, top: 35, width: 3, height: 12,
      position: 'static',
      children: {
        id: 'thread1-frame3', type: 'paragraph',
        content: '',
        column: 3, gap: 5,
      },
    },
    {
      type: 'box', id: 't2-title',
      left: 0, top: 4, width: 3, height: 3,
      position: 'static',
      borderTopWidth: 0.5,
      borderColor: 'black',
      children: {
        type: 'text',
        content: '[Thread 2] 좌측 기사 · 2프레임',
        textStyle: { fontSize: 4, fontWeight: 700 },
        paragraphStyle: { textAlign: 'center', verticalAlign: 'center' },
      },
    },
    {
      type: 'box', id: 't2-b1',
      left: 0, top: 7, width: 3, height: 20,
      position: 'static',
      children: {
        id: 'thread2-frame1', type: 'paragraph',
        content: thread2Story,
        column: 2, gap: 5,
      },
    },
    {
      type: 'box', id: 't2-b2',
      left: 0, top: 27, width: 3, height: 20,
      position: 'static',
      children: {
        id: 'thread2-frame2', type: 'paragraph',
        content: '',
        column: 2, gap: 5,
      },
    },
    {
      type: 'box', id: 't3-title',
      left: 0, top: 47, width: 6, height: 3,
      position: 'static',
      borderTopWidth: 0.5,
      borderColor: 'black',
      children: {
        type: 'text',
        content: '[Thread 3] 하단 확장 기사 · 3프레임',
        textStyle: { fontSize: 4, fontWeight: 700 },
        paragraphStyle: { textAlign: 'center', verticalAlign: 'center' },
      },
    },
    {
      type: 'box', id: 't3-b1',
      left: 0, top: 50, width: 6, height: 10,
      position: 'static',
      children: {
        id: 'thread3-frame1', type: 'paragraph',
        content: thread3Story,
        column: 4, gap: 5,
      },
    },
    {
      type: 'box', id: 't3-b2',
      left: 0, top: 60, width: 6, height: 10,
      position: 'static',
      children: {
        id: 'thread3-frame2', type: 'paragraph',
        content: '',
        column: 6, gap: 5,
      },
    },
    {
      type: 'box', id: 't3-b3',
      left: 0, top: 70, width: 6, height: 10,
      position: 'static',
      children: {
        id: 'thread3-frame3', type: 'paragraph',
        content: '',
        column: 6, gap: 5,
      },
    },
  ],
};