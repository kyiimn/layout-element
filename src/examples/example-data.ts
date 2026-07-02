import { BoxData } from "@/types";

const title = '서금원, 李정부 국정과제 추진…사회적기업';
const body = `서민금융진흥원(서금원)이 이재명 정부 국정과제 중 하나인 '사회연대경제 성장 지원'을 위해 사회적기업 관련 대출 규모를 늘린다. 이와 함께 정부에서 강조하고 있는 포용금융 강화를 위해 비금융 대안정보를 활용한 평가모형 개발에도 나선다.
9일 국회 정무위원회 소속 이정문 더불어민주당 의원실에 따르면 서금원은 이 같은 내용을 담은 '2026년 업무계획'을 금융위원회에 제출했다. 올해 서금원은 사회적금융 활성화를 위해 사회적기업 대출 규모를 기존 60억원에서 150억원으로 확대한다. 대출사업 수행기관 등 민간사업수행기관 신규 발굴 및 선정도 추진한다.
서금원은 미소금융 기업이나 은행재단 등 사업수행기관을 통해 2018년부터 사회적기업이나 사회적협동조합에 자금을 대출하고 있다. 미소금융이란 담보나 신용이 없어 제도권 금융을 이용하기 어려운 취약계층을 대상으로 창업 및 운영자금 등을 지원하는 소액대출사업을 말한다. 서금원이 취급하는 미소금융 사회연대금융 대출의 경우 연 매출 5억원 이하의 사회적기업이나 협동조합이 대상이며 대출한도는 최대 1억원, 금리는 연 4.5% 이내다.
비금융 대안정보를 활용한 평가모형 개발에도 나선다. 비금융 서민 대안 신용평가모형(가칭)을 개발해 서금원이 취급하는 상품의 대출심사에 활용한다는 계획이다. 평가모형에는 최저신용자나 플랫폼 노동자의 성실 상환 여부, 금융교육 이수 여부, 서금원 컨설팅 이용 여부 등을 반영한다.
또 비금융 대안정보를 활용한 상환능력 평가도 개선한다. 기존에는 통합 신용평가모형에 대안정보로 산출한 점수를 가점하는 방식이었으나, 개선안에서는 보증이 거절된 소비자를 추가로 선별하는 데 대안정보를 활용한다. 이를 통해 저신용자 지원은 강화하고 고액자산가의 대출 한도는 축소해 도덕적 해이를 최소화하겠다는 설명이다.
청년과 자영업자를 위한 컨설팅도 확대한다. 청년도약계좌 이용자를 위한 청년금융 컨설팅 기능을 '청년 모두를 위한 재무상담'으로 확대 및 개편한다. 예를 들어 서금원 통합지원센터를 기반으로 한 재무상담과 위촉 컨설턴트를 통해 찾아가는 컨설팅을 제공할 예정이다. 자영업자의 경우 '서금원 자영업 지원센터'를 구축해 세무·노무·법무·자영업 진단 컨설팅 등 비대면 컨설팅을 지원할 수 있는 환경을 마련할 계획이다. 군장병·초임장교·신용사면자 등 신용관리가 취약할 수 있는 계층을 대상으로 한 신용·부채관리 컨설팅도 검토하고 있다.
휴면예금 찾아주기 서비스도 강화한다. 금융소비자는 서금원에 출연된 휴면예금을 돌려받을 수 있는데, 소액의 경우 간편결제 서비스의 페이머니로 전환해 지급하는 방안을 추진한다.
한편 서금원은 올해 정책서민금융 공급액을 지난해와 동일한 6조8100억원으로 책정했다. 지난해와 다르게 햇살론 일반보증 공급액 1조원을 줄이는 대신 특례보증 공급액을 1조원 늘린 것이 특징이다.
`;

const block1: BoxData = {
  type: 'box',
  left: 0, top: 0,
  width: 3,
  height: 20,
  borderBottomWidth: .5,
  borderColor: 'black',
  paddingLeft: 15,
  children: [{
    type: 'box',
    left: 0, top: 0,
    width: 3,
    height: 4,
    children: [
      {
        type: 'text',
        content: title,
        textStyle: { fontSize: 10 },
        paragraphStyle: { textAlign: 'center', verticalAlign: 'center' }
      }]
  }, {
    type: 'box',
    left: 0, top: 4,
    width: 3,
    height: 16,
    children: [{
      type: 'paragraph',
      content: body,
      column: 3,
      gap: 5,
    }]
  }]
};

const block2: BoxData = {
  type: 'box',
  left: 3, top: 0,
  width: 2,
  height: 42,
  borderColor: 'black',
  borderTopWidth: .1,
  borderRightWidth: .1,
  borderBottomWidth: .1,
  borderLeftWidth: .1,
  paddingTop: 4,
  paddingRight: 4,
  paddingBottom: 4,
  paddingLeft: 4,
  children: [{
    type: 'box',
    left: 0, top: 0,
    width: 2,
    height: 5,
    children: [
      {
        type: 'text',
        content: '제목제목제목1',
        textStyle: { fontSize: 12 },
        paragraphStyle: { textAlign: 'center', verticalAlign: 'center' }
      }]
  }, {
    type: 'box',
    left: 0, top: 5,
    width: 2,
    height: 37,
    children: [
      { type: 'paragraph', content: body },
    ]
  }, {
    type: 'box',
    left: 40, top: 29,
    width: 55,
    height: 35,
    position: 'absolute',
    zIndex: 1,
    children: [{
      type: 'image',
      url: 'test/g10506uf.png',
      dpi: 72,
      x: 0, y: 0,
      width: 80.08,
      height: 47.98
    }]
  }
  ]
};

const block3: BoxData = {
  type: 'box',
  left: 1, top: 20,
  width: 2,
  height: 22,
  borderBottomWidth: .5,
  borderColor: 'black',
  children: [{
    type: 'box',
    left: 0, top: 0,
    width: 6,
    height: 7,
    children: [
      {
        type: 'text',
        content: title,
        textStyle: { fontSize: 12 },
        paragraphStyle: { textAlign: 'center', verticalAlign: 'center' }
      }]
  }, {
    type: 'box',
    left: 0, top: 7,
    width: 4,
    height: 15,
    children: [
      {
        type: 'box',
        left: 28.3, top: 18,
        width: 56.6,
        height: 14.3,
        zIndex: 1,
        position: "absolute",
        children: [{
          type: 'text', content: '파고드는 텍스트',
          textStyle: {
            fontSize: 5,
            fontWeight: 600
          },
          paragraphStyle: {
            textAlign: "center",
            verticalAlign: "center"
          }
        }]
      },
      { type: 'paragraph', content: body }
    ]
  }]
};

const block4: BoxData = {
  type: 'box',
  left: 1, top: 42,
  width: 4,
  height: 23,
  borderBottomWidth: .5,
  borderColor: 'black',
  children: [{
    type: 'box',
    left: 0, top: 0,
    width: 4,
    height: 4,
    children: [
      {
        type: 'text',
        content: title,
        textStyle: { fontSize: 12 },
        paragraphStyle: { textAlign: 'center', verticalAlign: 'center' }
      }]
  }, {
    type: 'box',
    left: 0, top: 4,
    width: 4,
    height: 19,
    children: [
      { type: 'paragraph', content: body },
      {
        type: 'box',
        borderTopWidth: .5,
        borderLeftWidth: .5,
        borderRightWidth: .5,
        borderBottomWidth: .5,
        borderColor: 'black',
        left: 1, top: 0,
        width: 2,
        height: 14,
        zIndex: 1,
        children: [{
          type: 'image',
          url: 'test/g1051501.png',
          dpi: 200,
          x: 0, y: 0,
          width: 300,
          height: 186
        }]
      }
    ]
  }]
};

const block5: BoxData = {
  type: 'box',
  left: 0, top: 20,
  width: 1,
  height: 45,
  borderBottomWidth: .5,
  borderColor: 'black',
  children: [{
    type: 'box',
    left: 0, top: 0,
    width: 1,
    height: 4,
    children: [
      {
        type: 'text',
        content: '제목제목',
        textStyle: { fontSize: 6, fontWeight: 600 },
        paragraphStyle: { textAlign: 'center', verticalAlign: 'center' }
      }]
  }, {
    type: 'box',
    left: 0, top: 4,
    width: 1,
    height: 41,
    children: [
      {
        type: 'box',
        left: 145, top: 0,
        width: 55,
        height: 33,
        zIndex: 1,
        position: "absolute",
      },
      { type: 'paragraph', content: body }
    ]
  }]
};

const ad: BoxData = {
  type: 'box',
  borderTopWidth: .5,
  borderLeftWidth: .5,
  borderRightWidth: .5,
  borderBottomWidth: .5,
  borderColor: 'black',
  left: 0, top: 66,
  width: 5,
  height: 26,
  children: [{
    type: 'image',
    url: 'test/k11099q7.png',
    dpi: 300,
    x: 0, y: 0,
    width: 71.62,
    height: 37.9,
  }]
};

export const exampleData = {
  width: 323,
  height: 470,
  paddingTop: 14,
  paddingRight: 10,
  paddingBottom: 14,
  paddingLeft: 10,

  columns: 5,
  gap: 5,

  textStyle: {
    color: 'black',
    fontFamily: 'Myoungjo',
    fontSize: 4,
    letterSpacing: -0.2,
    widthRatio: 0.8,
  },
  paragraphStyle: {
    lineGap: 1.2,
  },

  children: [
    block1,
    block2,
    block3,
    block4,
    block5,
    ad,
  ]
};