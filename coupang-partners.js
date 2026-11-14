/* 캠핑 푸드 헬퍼 — 쿠팡 파트너스 장보기 블록
 *
 * 쿠팡 파트너스(partners.coupang.com) 설정값은 이 파일의 CONFIG 한 곳에 모아 둔다.
 * 배포 환경에서 값을 바꾸려면 index.html 의 이 스크립트보다 앞에서
 * window.CAMP_COUPANG = { partnerId: '...' } 처럼 덮어쓰면 된다.
 *
 *   partnerId    : 파트너스 추적 코드(AF...) — 파트너스 > 내 정보
 *   bannerId     : 다이나믹 배너 id — 링크 생성 > 다이나믹 배너 (스포츠/레저 = 캠핑·아웃도어)
 *   searchWidget : 검색 위젯 iframe 주소 — 링크 생성 > 검색 위젯
 *
 * 쿠팡 파트너스 활동에는 공정위(표시·광고의 공정화에 관한 법률)가 정한 대가성 문구를 반드시 표시해야 한다.
 * 문구는 DISCLOSURE 한 곳에서만 쓰고, 화면에서 숨기지 않는다.
 */
(function () {
  'use strict';

  var CONFIG = {
    enabled: true,
    partnerId: 'AF8608843',
    bannerId: '1050151',
    bannerWidth: 680,
    bannerHeight: 140,
    searchWidget: 'https://coupa.ng/cqX8jD'
  };
  var DISCLOSURE = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';

  var override = window.CAMP_COUPANG || null;
  var CFG = {};
  for (var k in CONFIG) CFG[k] = CONFIG[k];
  if (override) for (var k2 in override) if (override[k2] !== undefined && override[k2] !== null) CFG[k2] = override[k2];

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function widgetUrl() {
    return CFG.searchWidget + (CFG.searchWidget.indexOf('?') > -1 ? '&' : '?') + 'subId=camping-food-helper';
  }

  function bannerUrl() {
    return 'https://ads-partners.coupang.com/widgets.html?id=' + encodeURIComponent(CFG.bannerId)
      + '&template=carousel&trackingCode=' + encodeURIComponent(CFG.partnerId)
      + '&subId=&width=' + encodeURIComponent(CFG.bannerWidth) + '&height=' + encodeURIComponent(CFG.bannerHeight) + '&tsource=';
  }

  var STYLE_ID = 'camp-coupang-style';
  var CSS = [
    '.cp-card .cp-lead{margin:0 0 10px;font-size:14px;color:var(--muted,#6b7280);line-height:1.55}',
    '.cp-card .cp-widget{width:100%;max-width:680px;height:75px;border:0;display:block;margin:0 0 10px}',
    '.cp-card .cp-banner{width:100%;max-width:680px;height:140px;border:0;display:block;margin:0 auto}',
    '.cp-card .cp-note{margin:10px 0 0;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.04);',
    'font-size:12px;line-height:1.5;color:var(--muted,#6b7280)}',
    '.cp-card .cp-note b{font-weight:800}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function html() {
    return '<section class="card cp-card" aria-labelledby="cpTitle">'
      + '<h2 id="cpTitle" style="margin-bottom:6px">🛒 장보기 · 장비 준비</h2>'
      + '<p class="cp-lead">목록에 있는 재료와 장비를 쿠팡에서 바로 찾아볼 수 있어요. '
      + '아래 검색창에 품목을 적으면 쿠팡 상품이 나오고, 그 아래는 캠핑·레저 인기 상품이에요.</p>'
      + '<iframe class="cp-widget" title="쿠팡 상품 검색" loading="lazy" referrerpolicy="unsafe-url" '
      + 'src="' + esc(widgetUrl()) + '"></iframe>'
      + '<iframe class="cp-banner" title="쿠팡 캠핑·레저 베스트" loading="lazy" referrerpolicy="unsafe-url" '
      + 'src="' + esc(bannerUrl()) + '"></iframe>'
      + '<p class="cp-note"><b>안내</b> · ' + esc(DISCLOSURE) + '</p>'
      + '</section>';
  }

  function mountAll(root) {
    if (!CFG.enabled) return;
    var scope = root || document;
    var slots = scope.querySelectorAll('.cp-slot');
    if (!slots.length) return;
    ensureStyle();
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (slot.getAttribute('data-cp-mounted') === '1') continue;
      slot.innerHTML = html();
      slot.setAttribute('data-cp-mounted', '1');
    }
  }

  window.CampCoupang = {
    config: CFG,
    disclosure: DISCLOSURE,
    mountAll: mountAll,
    html: html
  };
})();
