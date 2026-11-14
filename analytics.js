/* 오늘 캠핑 — GA4 측정·전환 추적 (익명, 동의 기반)
 *
 * 왜 파일을 따로 두나:
 *  - index.html 한 곳에 gtag 스니펫을 박으면 앱 코드와 섞여 손보기 어렵고, 측정 ID를 바꿀 때
 *    앱 전체를 다시 봐야 한다. 여기 한 파일에 ID·이벤트 이름·동의 규칙을 모아 둔다.
 *  - index.html 에는 <script src="/analytics.js" defer></script> 한 줄만 들어간다.
 *
 * 원칙:
 *  1) 사용자가 '허용'을 고르기 전에는 GA4 로 아무 것도 보내지 않는다(쿠키도 만들지 않는다).
 *  2) 보내는 값은 페이지 이름·기능 이름 같은 익명 값만. 입력한 재료·메모·위치는 보내지 않는다.
 *  3) 앱을 가리지 않는다 — 스크립트가 실패해도 앱은 그대로 동작해야 하므로 전부 try/catch.
 */
(function () {
  'use strict';

  // GA4 속성 '캠핑 푸드 헬퍼 (camping-food-helper)' — 스트림 '캠핑 푸드 헬퍼 웹'(16339040678)
  var GA_ID = 'G-KWRL68QXR4';
  var CONSENT_KEY = 'camping-food-helper.analytics.v1';
  var GA_ID_RE = /^G-[A-Z0-9]{4,}$/;

  // data-a 값 → GA4 이벤트 이름. 여기 없는 동작은 보내지 않는다(수집 범위를 좁게 유지).
  var ACTION_EVENTS = {
    recs: 'recommend_request',        // 조건으로 메뉴 추천받기 — 핵심 전환
    more: 'recommend_more',           // 다른 요리로 추천받기
    'cooler-ai-rec': 'recommend_request',
    'camp-intro-ai': 'camp_dish_request',
    'plan-generate': 'plan_generate', // 식단표 생성
    'camp-detail': 'camp_detail_view',// 캠핑장 상세 열기
    'camp-pick-go': 'camp_pick',
    'garden-reg-open': 'garden_register_open',
    'garden-detail-open': 'garden_detail_view',
    'copy-checklist': 'checklist_copy',
    copylist: 'checklist_copy',
    copyunchecked: 'checklist_copy'
  };

  function readConsent() {
    try {
      var v = window.localStorage && window.localStorage.getItem(CONSENT_KEY);
      if (v === 'allow') return true;
      if (v === 'deny') return false;
    } catch (e) {}
    return null;
  }

  function writeConsent(allow) {
    try {
      if (window.localStorage) window.localStorage.setItem(CONSENT_KEY, allow ? 'allow' : 'deny');
    } catch (e) {}
  }

  var loaded = false;
  function loadGA() {
    if (loaded || !GA_ID_RE.test(GA_ID)) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, { anonymize_ip: true, send_page_view: false });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
    document.head.appendChild(s);
  }

  function track(name, params) {
    if (!name || readConsent() !== true) return;
    loadGA();
    try {
      window.gtag('event', name, params || {});
    } catch (e) {}
  }

  // 해시 라우팅(#/rec, #/camp ...)을 페이지 조회로 센다. 값은 해시의 첫 구간만 쓴다.
  function pageName() {
    var h = String(window.location.hash || '').replace(/^#\/?/, '').split(/[/?]/)[0];
    return /^[a-z0-9_-]{1,32}$/.test(h) ? h : 'home';
  }

  var lastPage = '';
  function trackPage() {
    var p = pageName();
    if (p === lastPage) return;
    lastPage = p;
    track('page_view', { page_title: p, page_path: '/' + (p === 'home' ? '' : '#' + p) });
  }

  var banner = null;
  function showBanner() {
    if (banner || document.getElementById('cfh-consent')) return;
    banner = document.createElement('div');
    banner.id = 'cfh-consent';
    banner.setAttribute('role', 'dialog');
    banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;max-width:560px;margin:0 auto;z-index:3100;' +
      'background:#F6F4DA;color:#16291F;border-radius:14px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.28);' +
      'font:14px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif';
    banner.innerHTML = '<div style="font-weight:800;margin-bottom:4px">📊 익명 사용 통계</div>' +
      '<div style="color:#4D6257;margin-bottom:10px">어떤 기능을 많이 쓰는지 익명으로만 봅니다. 거부해도 모든 기능을 그대로 쓸 수 있어요.</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button type="button" data-cfh-consent="deny" style="min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid #DCD8B3;background:transparent;color:#16291F;font-weight:700">거부</button>' +
      '<button type="button" data-cfh-consent="allow" style="min-height:40px;padding:8px 14px;border-radius:10px;border:0;background:#F4735A;color:#2A0E06;font-weight:800">허용</button>' +
      '</div>';
    document.body.appendChild(banner);
  }

  function hideBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-a],[data-cfh-consent]') : null;
    if (!t) return;
    var consent = t.getAttribute('data-cfh-consent');
    if (consent) {
      var allow = consent === 'allow';
      writeConsent(allow);
      hideBanner();
      if (allow) { loadGA(); lastPage = ''; trackPage(); }
      return;
    }
    var a = t.getAttribute('data-a');
    if (a === 'tab') {
      var v = t.getAttribute('data-v');
      if (v && /^[a-z0-9_-]{1,32}$/.test(v)) track('tab_view', { tab: v });
      return;
    }
    var name = ACTION_EVENTS[a];
    if (name) track(name, { action: a });
  }

  function init() {
    if (readConsent() === true) loadGA();
    document.addEventListener('click', onClick, true);
    window.addEventListener('hashchange', trackPage);
    trackPage();
    if (readConsent() === null) setTimeout(showBanner, 1200);   // 첫 화면을 가리지 않도록 잠깐 뒤에
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.CFHAnalytics = { GA_ID: GA_ID, track: track, readConsent: readConsent, writeConsent: writeConsent };
})();
