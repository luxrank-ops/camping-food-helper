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

  /* 메인 화면 퀵 픽 — 추천을 돌리기 전에도 바로 눌러 볼 수 있는 카테고리 4종.
   * 칩 하나가 파트너스 검색 딥링크 하나로 이어진다(키워드는 쿠팡 검색어, key 는 subId 꼬리표). */
  var QUICK_PICKS = [
    { key: 'bbq', emoji: '🍖', label: '바베큐·버너', keywords: '캠핑 바베큐 그리들 버너' },
    { key: 'tent', emoji: '⛺', label: '텐트·타프', keywords: '캠핑 텐트 타프' },
    { key: 'chair', emoji: '🪑', label: '의자·테이블', keywords: '캠핑 의자 테이블' },
    { key: 'cooler', emoji: '❄️', label: '쿨러·아이스박스', keywords: '캠핑 아이스박스 쿨러' }
  ];

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

  /* 카테고리 칩용 파트너스 검색 딥링크.
   * coupa.ng 검색 위젯이 실제로 쓰는 주소(link.coupang.com/re/AFFSRP)를 같은 규칙으로 만든다 —
   * pageKey=검색어, lptag=파트너스 추적 코드, subid=어느 자리에서 눌렀는지.
   * subId 접두사는 기존 검색 위젯과 같은 'camping-food-helper-...' 로 맞춘다. */
  function searchUrl(keywords, part) {
    return 'https://link.coupang.com/re/AFFSRP?pageKey=' + encodeURIComponent(keywords)
      + '&lptag=' + encodeURIComponent(CFG.partnerId)
      + '&subid=' + encodeURIComponent('camping-food-helper' + (part ? '-' + part : ''));
  }

  function noteHtml() {
    return '<p class="cp-note"><b>안내</b> · ' + esc(DISCLOSURE) + '</p>';
  }

  var STYLE_ID = 'camp-coupang-style';
  var CSS = [
    '.cp-card .cp-lead{margin:0 0 10px;font-size:14px;color:var(--muted,#6b7280);line-height:1.55}',
    '.cp-card .cp-widget{width:100%;max-width:680px;height:75px;border:0;display:block;margin:0 0 10px}',
    '.cp-card .cp-banner{width:100%;max-width:680px;height:140px;border:0;display:block;margin:0 auto}',
    '.cp-card .cp-note{margin:10px 0 0;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.04);',
    'font-size:12px;line-height:1.5;color:var(--muted,#6b7280)}',
    '.cp-card .cp-note b{font-weight:800}',
    /* 퀵 픽 — 첫 화면에서는 한 줄에 4칩, 좁은 화면에서는 2×2 */
    '.cp-quick .cp-quick-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:2px}',
    '.cp-quick .cp-quick-head h2{margin:0}',
    '.cp-quick .cp-quick-sub{font-size:12px;font-weight:700;color:var(--muted,#6b7280)}',
    '.cp-chips{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0 12px}',
    '@media(min-width:440px){.cp-chips{grid-template-columns:repeat(4,minmax(0,1fr))}}',
    '.cp-chip{display:flex;align-items:center;justify-content:center;gap:5px;min-height:46px;padding:8px 6px;',
    'border-radius:12px;border:1px solid var(--line,#e5e7eb);background:var(--surface,#fff);color:inherit;',
    'text-decoration:none;font-size:12.5px;font-weight:800;line-height:1.25;text-align:center;word-break:keep-all}',
    '.cp-chip:active{transform:scale(.98)}',
    /* 추천 결과 직후 블록 */
    '.cp-picks{display:flex;flex-direction:column;gap:8px;margin:0 0 12px}',
    '.cp-pick{display:block;padding:11px 12px;border-radius:12px;font-size:13.5px;font-weight:800;line-height:1.35;',
    'color:inherit;text-decoration:none;word-break:keep-all}',
    '.cp-pick.dish{background:linear-gradient(135deg,rgba(18,73,58,.1),rgba(224,93,56,.12));border:1px solid rgba(18,73,58,.22)}',
    '.cp-pick.alt{background:var(--surface,#fff);border:1px solid var(--line,#e5e7eb);font-weight:700}'
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
      + noteHtml()
      + '</section>';
  }

  /* 메인 화면 상단 퀵 픽 — 카테고리 칩 4종 + 검색 위젯 + 공정위 문구.
   * recView() 안에서 그대로 문자열로 붙는다(따로 마운트할 필요 없음). */
  function quickPickHtml() {
    if (!CFG.enabled) return '';
    ensureStyle();
    var chips = QUICK_PICKS.map(function (p) {
      return '<a class="cp-chip" data-a="cp-quick" data-cat="' + esc(p.key) + '"'
        + ' href="' + esc(searchUrl(p.keywords, 'quick-' + p.key)) + '"'
        + ' target="_blank" rel="sponsored noopener">'
        + '<span aria-hidden="true">' + p.emoji + '</span>' + esc(p.label) + '</a>';
    }).join('');
    return '<section class="card cp-card cp-quick" aria-labelledby="cpQuickTitle">'
      + '<div class="cp-quick-head"><h2 id="cpQuickTitle">🛒 이번 주말 인기 캠핑 템</h2>'
      + '<span class="cp-quick-sub">추천 돌리기 전에 미리 보기</span></div>'
      + '<div class="cp-chips">' + chips + '</div>'
      + '<p class="cp-lead">칩을 누르면 쿠팡에서 그 카테고리 상품이 바로 나와요. 직접 찾고 싶으면 아래 검색창에 적어 주세요.</p>'
      + '<iframe class="cp-widget" title="쿠팡 상품 검색" loading="lazy" referrerpolicy="unsafe-url"'
      + ' src="' + esc(widgetUrl()) + '"></iframe>'
      + noteHtml()
      + '</section>';
  }

  /* 추천 결과 직후 — 지금 추천한 메뉴 이름으로 바로 장보기.
   * opts.dishes: 추천 메뉴 이름 배열(최대 3개) */
  function resultHtml(opts) {
    if (!CFG.enabled) return '';
    ensureStyle();
    var dishes = ((opts && opts.dishes) || []).filter(function (d) { return d && String(d).trim(); }).slice(0, 3);
    var picks = dishes.map(function (name) {
      return '<a class="cp-pick dish" data-a="cp-pick" data-cat="dish"'
        + ' href="' + esc(searchUrl(name + ' 재료', 'rec-dish')) + '" target="_blank" rel="sponsored noopener">'
        + '🍲 「' + esc(name) + '」 재료 쿠팡에서 보기 →</a>';
    }).join('');
    picks += '<a class="cp-pick alt" data-a="cp-pick" data-cat="staples"'
      + ' href="' + esc(searchUrl('캠핑 식재료 양념', 'rec-staples')) + '" target="_blank" rel="sponsored noopener">'
      + '🧂 캠핑 식재료·양념 한 번에 보기 →</a>';
    return '<section class="card cp-card cp-rec" aria-labelledby="cpRecTitle">'
      + '<h2 id="cpRecTitle">🧺 이 캠핑 준비물, 쿠팡에서 바로 챙기기</h2>'
      + '<p class="cp-lead">추천한 메뉴의 재료와 장비를 쿠팡에서 찾아볼 수 있어요. 마음에 드는 메뉴부터 눌러 보세요.</p>'
      + '<div class="cp-picks">' + picks + '</div>'
      + '<iframe class="cp-banner" title="쿠팡 캠핑·레저 베스트" loading="lazy" referrerpolicy="unsafe-url"'
      + ' src="' + esc(bannerUrl()) + '"></iframe>'
      + noteHtml()
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
    quickPicks: QUICK_PICKS,
    searchUrl: searchUrl,
    quickPickHtml: quickPickHtml,
    resultHtml: resultHtml,
    mountAll: mountAll,
    html: html
  };
})();
