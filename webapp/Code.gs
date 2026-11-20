/**
 * 최소 성취수준 보장지도 – 서버 (Google Apps Script)
 *
 * 설치: 구글 시트 → 확장 프로그램 → Apps Script 에 이 파일(Code.gs)과 Index.html 을 붙여넣고
 *       배포 → 새 배포 → 웹 앱 (실행: 나, 액세스: 모든 사용자)
 * 데이터: 이 스크립트가 붙은 구글 시트에 저장됩니다. 선생님들은 시트를 직접 열지 않고 웹앱으로만 접근합니다.
 */

var APP_TITLE = '최소 성취수준 보장지도';
var SHEET_NAMES = { accounts: '계정', courses: '과목', settings: '설정', log: '기록' };
var HEADERS = {
  accounts: ['아이디', '이름', '역할', 'salt', 'hash', '사용', '비밀번호변경필요', '마지막로그인', '만든시각'],
  courses: ['id', '학년도', '학기', '과목', '학년', '담당아이디', '담당교사', '버전', '수정시각', '수정자', '데이터'],
  settings: ['키', '값'],
  log: ['시각', '아이디', '동작', '대상']
};
var CHUNK = 40000;          // 셀 한 칸 최대 5만 자 → 4만 자씩 나눠 저장
var TOKEN_TTL = 21600;      // 로그인 유지 6시간 (사용할 때마다 연장)
var MAX_FAIL = 5;           // 비밀번호 5번 틀리면
var LOCK_SEC = 600;         // 10분 잠금
var HASH_ROUNDS = 200;

/* ───────────────────────── 웹 페이지 ───────────────────────── */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ───────────────────────── API 진입점 ───────────────────────── */
/** 화면에서 google.script.run.api(token, action, payload) 로 호출 */
function api(token, action, payload) {
  payload = payload || {};
  try {
    var pub = { status: apiStatus_, setup: apiSetup_, login: apiLogin_ };
    if (pub[action]) return ok_(pub[action](payload));
    var user = auth_(token);
    if (!user) return { ok: false, error: 'AUTH', message: '로그인이 필요합니다.' };
    var fn = {
      logout: apiLogout_, bootstrap: apiBootstrap_, lists: apiLists_,
      saveCourse: apiSaveCourse_, deleteCourse: apiDeleteCourse_, changePassword: apiChangePassword_,
      accounts: adminOnly_(apiAccounts_), saveAccount: adminOnly_(apiSaveAccount_),
      resetPassword: adminOnly_(apiResetPassword_), saveSettings: adminOnly_(apiSaveSettings_),
      exportResults: adminOnly_(apiExportResults_), log: adminOnly_(apiLog_)
    }[action];
    if (!fn) return { ok: false, error: 'UNKNOWN', message: '알 수 없는 요청입니다: ' + action };
    return ok_(fn(user, payload, token));
  } catch (e) {
    if (e && e.code) return { ok: false, error: e.code, message: e.message, data: e.data };
    return { ok: false, error: 'SERVER', message: String(e && e.message || e) };
  }
}
function ok_(r) { r = r || {}; r.ok = true; return r; }
function fail_(code, message, data) { var e = new Error(message); e.code = code; e.data = data; throw e; }
function adminOnly_(fn) { return function (user, p, t) { if (user.role !== 'admin') fail_('FORBIDDEN', '관리자만 할 수 있습니다.'); return fn(user, p, t); }; }

/* ───────────────────────── 시트 도우미 ───────────────────────── */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(key) {
  var sh = ss_().getSheetByName(SHEET_NAMES[key]);
  if (!sh) {
    sh = ss_().insertSheet(SHEET_NAMES[key]);
    sh.getRange(1, 1, 1, HEADERS[key].length).setValues([HEADERS[key]]);
    sh.setFrozenRows(1);
  }
  return sh;
}
function rows_(key) {
  var sh = sheet_(key), n = sh.getLastRow();
  if (n < 2) return [];
  var w = Math.max(sh.getLastColumn(), HEADERS[key].length);
  return sh.getRange(2, 1, n - 1, w).getValues();
}
function writeRow_(key, rowNo, values) {          // rowNo: 시트 행 번호(2부터). 0이면 맨 아래 추가
  var sh = sheet_(key);
  if (!rowNo) rowNo = sh.getLastRow() + 1;
  var w = Math.max(values.length, sh.getLastColumn());
  var v = values.slice(); while (v.length < w) v.push('');
  sh.getRange(rowNo, 1, 1, w).setValues([v]);
  return rowNo;
}
function deleteRow_(key, rowNo) { sheet_(key).deleteRow(rowNo); }
/** 텍스트를 시트에 안전하게: 숫자·날짜·수식으로 바뀌지 않도록 접두어를 붙임 */
function txt_(s) { s = String(s == null ? '' : s); return /^[=+\-@]/.test(s) ? "'" + s : s; }
function pack_(obj) {
  var json = JSON.stringify(obj), parts = [];
  for (var i = 0; i < json.length; i += CHUNK) parts.push('J:' + json.slice(i, i + CHUNK));
  return parts.length ? parts : ['J:null'];
}
function unpack_(row, start) {
  var s = '';
  for (var i = start; i < row.length; i++) {
    var v = row[i];
    if (v === '' || v == null) break;
    v = String(v);
    s += v.indexOf('J:') === 0 ? v.slice(2) : v;
  }
  return s ? JSON.parse(s) : null;
}
function now_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'); }
function log_(user, action, target) {
  try { writeRow_('log', 0, [now_(), user ? user.id : '', action, txt_(target || '')]); } catch (e) {}
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ───────────────────────── 계정·인증 ───────────────────────── */
function hash_(pw, salt) {
  var A = Utilities.DigestAlgorithm.SHA_256, U = Utilities.Charset.UTF_8;
  var s = Utilities.base64Encode(Utilities.computeDigest(A, salt + '|' + pw, U));
  for (var i = 0; i < HASH_ROUNDS; i++) s = Utilities.base64Encode(Utilities.computeDigest(A, s + salt, U));
  return s;
}
function newSalt_() { return Utilities.getUuid().replace(/-/g, ''); }
function accounts_() {
  return rows_('accounts').map(function (r, i) {
    return { row: i + 2, id: String(r[0]).trim(), name: String(r[1]), role: String(r[2]) === 'admin' ? 'admin' : 'teacher',
      salt: String(r[3]).replace(/^h:/, ''), hash: String(r[4]).replace(/^h:/, ''),
      active: r[5] !== false && String(r[5]).toUpperCase() !== 'FALSE' && String(r[5]) !== 'N',
      mustChange: r[6] === true || String(r[6]).toUpperCase() === 'TRUE', lastLogin: String(r[7] || ''), created: String(r[8] || '') };
  }).filter(function (a) { return a.id; });
}
function findAccount_(id) {
  id = String(id || '').trim().toLowerCase();
  return accounts_().filter(function (a) { return a.id.toLowerCase() === id; })[0] || null;
}
function writeAccount_(a) {
  return writeRow_('accounts', a.row || 0, [txt_(a.id), txt_(a.name), a.role, 'h:' + a.salt, 'h:' + a.hash,
    a.active ? 'TRUE' : 'FALSE', a.mustChange ? 'TRUE' : 'FALSE', a.lastLogin || '', a.created || now_()]);
}
function checkPassword_(pw) {
  pw = String(pw || '');
  if (pw.length < 6) fail_('INVALID', '비밀번호는 6자 이상으로 정해 주세요.');
  return pw;
}
function checkId_(id) {
  id = String(id || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{1,29}$/.test(id)) fail_('INVALID', '아이디는 영문으로 시작하는 영문·숫자 2~30자로 정해 주세요(예: kim01).');
  return id;
}
function publicUser_(a) { return { id: a.id, name: a.name, role: a.role, mustChange: !!a.mustChange }; }

function newToken_(a) {
  var t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('t_' + t, JSON.stringify({ id: a.id, name: a.name, role: a.role }), TOKEN_TTL);
  return t;
}
function auth_(token) {
  if (!token) return null;
  var c = CacheService.getScriptCache(), v = c.get('t_' + token);
  if (!v) return null;
  c.put('t_' + token, v, TOKEN_TTL);              // 사용할 때마다 연장
  var u = JSON.parse(v);
  var a = findAccount_(u.id);                      // 사용 중지·역할 변경을 바로 반영
  if (!a || !a.active) { c.remove('t_' + token); return null; }
  return { id: a.id, name: a.name, role: a.role };
}

function apiStatus_() {
  return { needsSetup: accounts_().length === 0, school: settings_().school || '' };
}
function apiSetup_(p) {
  return withLock_(function () {
    if (accounts_().length) fail_('FORBIDDEN', '이미 관리자 계정이 있습니다.');
    var id = checkId_(p.id), pw = checkPassword_(p.password), name = String(p.name || '').trim() || '관리자';
    var salt = newSalt_();
    var a = { id: id, name: name, role: 'admin', salt: salt, hash: hash_(pw, salt), active: true, mustChange: false, lastLogin: now_(), created: now_() };
    a.row = writeAccount_(a);
    if (p.school) saveSetting_('school', String(p.school).trim());
    ensureListTabs_();
    log_(a, '최초 관리자 설정', id);
    return { token: newToken_(a), user: publicUser_(a) };
  });
}
function apiLogin_(p) {
  var id = String(p.id || '').trim(), cache = CacheService.getScriptCache(), fk = 'f_' + id.toLowerCase();
  var fails = Number(cache.get(fk) || 0);
  if (fails >= MAX_FAIL) fail_('LOCKED', '비밀번호를 여러 번 틀려 10분 동안 로그인할 수 없습니다. 잠시 뒤 다시 시도하거나 담당 선생님께 비밀번호 초기화를 요청하세요.');
  var a = findAccount_(id);
  if (!a || !a.active || hash_(String(p.password || ''), a.salt) !== a.hash) {
    cache.put(fk, String(fails + 1), LOCK_SEC);
    fail_('LOGIN', '아이디 또는 비밀번호가 맞지 않습니다.' + (fails + 1 >= 3 ? ' (' + (MAX_FAIL - fails - 1) + '번 더 틀리면 10분 잠금)' : ''));
  }
  cache.remove(fk);
  a.lastLogin = now_(); writeAccount_(a);
  log_(a, '로그인', '');
  return { token: newToken_(a), user: publicUser_(a) };
}
function apiLogout_(user, p, token) { CacheService.getScriptCache().remove('t_' + token); return {}; }
function apiChangePassword_(user, p) {
  return withLock_(function () {
    var a = findAccount_(user.id);
    if (!a.mustChange && hash_(String(p.old || ''), a.salt) !== a.hash) fail_('LOGIN', '지금 비밀번호가 맞지 않습니다.');
    var pw = checkPassword_(p.password);
    a.salt = newSalt_(); a.hash = hash_(pw, a.salt); a.mustChange = false;
    writeAccount_(a); log_(user, '비밀번호 변경', '');
    return { user: publicUser_(a) };
  });
}

/* ───────────────────────── 관리자: 계정 ───────────────────────── */
function apiAccounts_() {
  return { accounts: accounts_().map(function (a) { return { id: a.id, name: a.name, role: a.role, active: a.active, mustChange: a.mustChange, lastLogin: a.lastLogin, created: a.created }; }) };
}
function apiSaveAccount_(user, p) {
  return withLock_(function () {
    var all = accounts_(), a = findAccount_(p.id), isNew = !a;
    var role = p.role === 'admin' ? 'admin' : 'teacher', active = p.active !== false;
    if (isNew) {
      var id = checkId_(p.id), pw = checkPassword_(p.password), salt = newSalt_();
      a = { id: id, name: String(p.name || '').trim() || id, role: role, salt: salt, hash: hash_(pw, salt), active: active, mustChange: true, created: now_() };
    } else {
      var admins = all.filter(function (x) { return x.role === 'admin' && x.active; });
      var losingAdmin = a.role === 'admin' && a.active && (role !== 'admin' || !active);
      if (losingAdmin && admins.length <= 1) fail_('INVALID', '관리자가 최소 한 명은 있어야 합니다.');
      if (a.id === user.id && !active) fail_('INVALID', '자기 계정은 사용 중지할 수 없습니다.');
      a.name = String(p.name || '').trim() || a.name; a.role = role; a.active = active;
    }
    writeAccount_(a);
    log_(user, isNew ? '계정 추가' : '계정 수정', a.id + ' ' + a.name + ' ' + a.role + (a.active ? '' : ' 사용중지'));
    // 담당 과목의 교사 이름도 맞춰 줌
    if (!isNew) rows_('courses').forEach(function (r, i) {
      if (String(r[5]) === a.id && String(r[6]) !== a.name) {
        var c = unpack_(r, 10); if (c) { c.teacher = a.name; r[6] = txt_(a.name); writeRow_('courses', i + 2, r.slice(0, 10).concat(pack_(c))); }
      }
    });
    return apiAccounts_();
  });
}
function apiResetPassword_(user, p) {
  return withLock_(function () {
    var a = findAccount_(p.id); if (!a) fail_('INVALID', '없는 계정입니다.');
    var pw = checkPassword_(p.password);
    a.salt = newSalt_(); a.hash = hash_(pw, a.salt); a.mustChange = true;
    writeAccount_(a); CacheService.getScriptCache().remove('f_' + a.id.toLowerCase());
    log_(user, '비밀번호 초기화', a.id);
    return {};
  });
}

/* ───────────────────────── 설정 ───────────────────────── */
function settings_() {
  var o = {};
  rows_('settings').forEach(function (r) { if (r[0] !== '') o[String(r[0])] = r[1] === '' ? '' : (function (v) { try { return JSON.parse(String(v).replace(/^J:/, '')); } catch (e) { return v; } })(r[1]); });
  return o;
}
function saveSetting_(k, v) {
  var rs = rows_('settings'), idx = -1;
  rs.forEach(function (r, i) { if (String(r[0]) === k) idx = i; });
  writeRow_('settings', idx >= 0 ? idx + 2 : 0, [k, 'J:' + JSON.stringify(v)]);
}
function apiSaveSettings_(user, p) {
  return withLock_(function () {
    var allowed = ['school', 'capMode', 'chooCustom'];
    Object.keys(p.settings || {}).forEach(function (k) { if (allowed.indexOf(k) >= 0) saveSetting_(k, p.settings[k]); });
    log_(user, '설정 변경', Object.keys(p.settings || {}).join(','));
    return { settings: settings_() };
  });
}

/* ───────────────────────── 과목 ───────────────────────── */
function courseRows_() {
  return rows_('courses').map(function (r, i) {
    return { row: i + 2, id: String(r[0]), owner: String(r[5]), version: Number(r[7]) || 0, raw: r };
  }).filter(function (x) { return x.id; });
}
function courseOf_(x) { var c = unpack_(x.raw, 10); if (c) { c.version = x.version; c.owner = x.owner; } return c; }
function visibleCourses_(user) {
  return courseRows_().filter(function (x) { return user.role === 'admin' || x.owner === user.id; }).map(courseOf_).filter(Boolean);
}
function apiSaveCourse_(user, p) {
  return withLock_(function () {
    var c = p.course; if (!c || !c.id) fail_('INVALID', '과목 정보가 없습니다.');
    var cur = courseRows_().filter(function (x) { return x.id === String(c.id); })[0];
    if (cur && user.role !== 'admin' && cur.owner !== user.id) fail_('FORBIDDEN', '다른 선생님의 과목은 고칠 수 없습니다.');
    if (cur && Number(p.baseVersion || 0) !== cur.version) fail_('CONFLICT', '다른 곳에서 먼저 고쳤습니다. 최신 내용으로 바꿉니다.', { course: courseOf_(cur) });
    var owner = user.id, teacher = user.name;
    if (user.role === 'admin') {
      owner = String(c.owner || (cur && cur.owner) || user.id);
      var oa = findAccount_(owner); if (!oa) fail_('INVALID', '담당 교사 계정을 찾을 수 없습니다: ' + owner);
      teacher = oa.name;
    }
    var version = (cur ? cur.version : 0) + 1;
    c.owner = owner; c.teacher = teacher; c.version = version;
    var fixed = [txt_(c.id), Number(c.year) || '', String(c.sem || ''), txt_(c.subject || ''), Number(c.grade) || '', txt_(owner), txt_(teacher), version, now_(), user.id];
    writeRow_('courses', cur ? cur.row : 0, fixed.concat(pack_(c)));
    if (!cur) log_(user, '과목 추가', c.subject + ' (' + teacher + ')');
    return { version: version, owner: owner, teacher: teacher };
  });
}
function apiDeleteCourse_(user, p) {
  return withLock_(function () {
    var cur = courseRows_().filter(function (x) { return x.id === String(p.id); })[0];
    if (!cur) return {};
    if (user.role !== 'admin' && cur.owner !== user.id) fail_('FORBIDDEN', '다른 선생님의 과목은 지울 수 없습니다.');
    var c = courseOf_(cur);
    deleteRow_('courses', cur.row);
    log_(user, '과목 삭제', (c && c.subject) + ' (' + (c && c.teacher) + ')');
    return {};
  });
}

/* ───────────────────────── 선정 명단 (구글 시트 탭에서 자동 연동) ─────────────────────────
 * 담당자가 아래 세 탭에 명단을 붙여넣으면 프로그램이 읽어 갑니다.
 *  - 가로형(기존 엑셀 양식): 학년 | 반 | 번호 | 이름 | 공통국어1 | 공통수학1 | … 과목 칸에 ○(또는 O, 1, ✓, 체크박스)
 *  - 세로형(한 줄에 한 과목): 학년 | 반 | 번호 | 이름 | 과목      (나이스 자료처럼)
 * 머리글 위에 제목 줄이 있어도 됩니다(위 15줄 안에서 '반·번호·이름' 머리글을 찾음). */
var LIST_TABS = { prev: '예방지도 명단', boch: '보충지도 명단', choo: '추가학습 명단' };
var BASE_SUBJ = ['공통국어1', '공통수학1', '공통영어1', '통합사회1', '통합과학1', '과학탐구실험1', '한국사1'];
var SUBJ_ALIAS = {
  '국어1':'공통국어1','수학1':'공통수학1','영어1':'공통영어1','사회1':'통합사회1','과학1':'통합과학1',
  '과탐실1':'과학탐구실험1','과탐1':'과학탐구실험1','과학탐구실험':'과학탐구실험1','과탐실':'과학탐구실험1','한국사':'한국사1',
  '국어2':'공통국어2','수학2':'공통수학2','영어2':'공통영어2','사회2':'통합사회2','과학2':'통합과학2',
  '과탐실2':'과학탐구실험2','과탐2':'과학탐구실험2','음악':'음악1','미술':'미술1','체육':'체육1'
};
var NOT_SUBJECT = /^(학년|반|번호|이름|성명|학번|연번|순번|과목수|합계|비고|학적변동|편제|학점|학점당시수|구분|학생구분)$|출석률|성취|시수|기준|여부|사유/;
function normSubj_(raw) {
  var s = String(raw == null ? '' : raw).replace(/_x000D_/g, '').replace(/\s+/g, '');
  if (!s) return '';
  return SUBJ_ALIAS[s] || s;
}
function isMark_(v) { return /^(○|◯|●|o|y|1|v|✓|✔|√|true)$/i.test(String(v == null ? '' : v).trim()); }
function ensureListTabs_() {
  Object.keys(LIST_TABS).forEach(function (app) {
    if (ss_().getSheetByName(LIST_TABS[app])) return;
    var sh = ss_().insertSheet(LIST_TABS[app]);
    var h = ['학년', '반', '번호', '이름'].concat(BASE_SUBJ).concat(app === 'choo' ? ['음악1', '미술1', '체육1'] : []);
    sh.getRange(1, 1, 1, h.length).setValues([h]);
    sh.setFrozenRows(1);
  });
}
function parseListTab_(app) {
  var name = LIST_TABS[app], sh = ss_().getSheetByName(name);
  var res = { sem: '1', filename: '구글 시트 · ' + name, savedAt: now_(), students: [], problems: [], subjects: [] };
  if (!sh) { res.problems.push('‘' + name + '’ 탭이 없습니다.'); return res; }
  var n = sh.getLastRow(), w = sh.getLastColumn();
  if (n < 2 || w < 1) return res;              // 머리글만 있거나 비어 있음
  var v = sh.getRange(1, 1, n, w).getDisplayValues();
  var hr = -1, col = {};
  for (var r = 0; r < Math.min(v.length, 15) && hr < 0; r++) {
    var row = v[r].map(function (x) { return String(x).replace(/\s+/g, ''); });
    if (row.indexOf('반') >= 0 && row.indexOf('번호') >= 0 && (row.indexOf('이름') >= 0 || row.indexOf('성명') >= 0)) {
      hr = r; col = { subj: {} };
      row.forEach(function (h, i) {
        if (h === '학년') col.grade = i; else if (h === '반') col.cls = i; else if (h === '번호') col.num = i;
        else if (h === '이름' || h === '성명') col.name = i; else if (h === '과목') col.long = i;
        else if (h && !NOT_SUBJECT.test(h)) col.subj[i] = normSubj_(h);
      });
    }
  }
  if (hr < 0) { res.problems.push('‘' + name + '’ 탭에서 반·번호·이름 머리글을 찾지 못했습니다. 첫 줄에 학년 | 반 | 번호 | 이름 | 과목… 을 적어 주세요.'); return res; }
  var by = {}, order = [], skipped = 0, noGrade = col.grade === undefined, clash = 0, lastCls = '', lastGrade = '', subjSeen = {};
  Object.keys(col.subj).forEach(function (i) { subjSeen[col.subj[i]] = 1; });
  for (var k = hr + 1; k < v.length; k++) {
    var x = v[k], nm = String(x[col.name] || '').trim();
    var clsRaw = String(x[col.cls] || '').trim(); if (clsRaw) lastCls = clsRaw; else if (nm) clsRaw = lastCls;     // 병합된 반 칸
    var gRaw = col.grade !== undefined ? String(x[col.grade] || '').trim() : ''; if (gRaw) lastGrade = gRaw; else if (nm && col.grade !== undefined) gRaw = lastGrade;
    if (!nm || nm === '이름' || nm === '성명') { if (String(x.join('')).trim()) skipped++; continue; }
    var g = parseInt(gRaw.replace(/\D/g, ''), 10), cTxt = clsRaw.replace(/반$/, '').replace(/\s/g, ''), c, nmb = parseInt(String(x[col.num] || '').replace(/\D/g, ''), 10);
    if (/^\d+-\d+$/.test(cTxt)) { if (!g) g = parseInt(cTxt.split('-')[0], 10); c = parseInt(cTxt.split('-')[1], 10); }
    else c = parseInt(cTxt.replace(/\D/g, ''), 10);
    if (!g) g = 1;
    if (!c || !nmb) { skipped++; continue; }
    var key = g + '-' + c + '-' + nmb, st = by[key];
    if (!st) { st = by[key] = { grade: g, cls: c, num: nmb, name: nm, subjects: {} }; order.push(key); }
    else if (st.name !== nm) clash++;
    if (col.long !== undefined) {
      var sj = normSubj_(x[col.long]); if (sj) { st.subjects[sj] = true; subjSeen[sj] = 1; }
    } else Object.keys(col.subj).forEach(function (i) {
      var sj2 = col.subj[i];
      if (isMark_(x[i])) st.subjects[sj2] = true; else if (!(sj2 in st.subjects)) st.subjects[sj2] = false;
    });
  }
  res.students = order.map(function (k2) { return by[k2]; }).sort(function (a, b) { return a.grade - b.grade || a.cls - b.cls || a.num - b.num; });
  res.subjects = Object.keys(subjSeen);
  var two = res.subjects.filter(function (s) { return /2$/.test(s); }).length, one = res.subjects.filter(function (s) { return /1$/.test(s); }).length;
  res.sem = two > one ? '2' : '1';
  if (noGrade && res.students.length && !res.students.some(function (s) { return s.cls >= 100; })) res.problems.push('‘' + name + '’ 탭에 학년 열이 없어 모두 1학년으로 처리했습니다(반 칸에 2-3처럼 적으면 학년도 인식합니다).');
  if (skipped) res.problems.push('‘' + name + '’ 탭에서 반·번호가 비었거나 숫자가 아닌 ' + skipped + '줄은 건너뛰었습니다.');
  if (clash) res.problems.push('‘' + name + '’ 탭에 같은 학년·반·번호인데 이름이 다른 줄이 ' + clash + '개 있습니다. 확인해 주세요.');
  return res;
}
function allLists_() {
  ensureListTabs_();
  var o = {};
  Object.keys(LIST_TABS).forEach(function (app) { o[app] = parseListTab_(app); });
  return o;
}
/** 교사에게는 자기 과목에 해당하는 학생·과목만 보냄 */
function listsFor_(user) {
  var lists = allLists_();
  if (user.role === 'admin') return lists;
  var subj = {};
  visibleCourses_(user).forEach(function (c) { if (c.subject) subj[c.subject] = 1; });
  var out = {};
  Object.keys(lists).forEach(function (app) {
    var rec = lists[app];
    var st = (rec.students || []).map(function (s) {
      var sub = {}, any = false;
      Object.keys(s.subjects || {}).forEach(function (k) { if (subj[k] && s.subjects[k]) { sub[k] = true; any = true; } });
      return any ? { grade: s.grade, cls: s.cls, num: s.num, name: s.name, subjects: sub } : null;
    }).filter(Boolean);
    out[app] = { sem: rec.sem, filename: rec.filename, savedAt: rec.savedAt, students: st, subjects: (rec.subjects || []).filter(function (k) { return subj[k]; }) };
  });
  return out;
}
function apiLists_(user) { return { lists: listsFor_(user) }; }

/* ───────────────────────── 시작 데이터 ───────────────────────── */
function apiBootstrap_(user) {
  var a = findAccount_(user.id);
  var teachers = accounts_().filter(function (x) { return x.active; }).map(function (x) { return { id: x.id, name: x.name, role: x.role }; });
  if (user.role !== 'admin') teachers = teachers.filter(function (x) { return x.id === user.id; });
  return { user: publicUser_(a), settings: settings_(), courses: visibleCourses_(user), lists: listsFor_(user), teachers: teachers,
           sheetUrl: user.role === 'admin' ? ss_().getUrl() : '' };
}

/* ───────────────────────── 관리자: 결과 시트·기록 ───────────────────────── */
function apiExportResults_(user, p) {
  var rows = p.rows || [];
  var name = '이수결과(' + (p.label || '전체') + ')';
  var sh = ss_().getSheetByName(name) || ss_().insertSheet(name);
  sh.clearContents();
  if (rows.length) {
    var w = rows[0].length;
    sh.getRange(1, 1, rows.length, w).setValues(rows.map(function (r) { var v = r.map(txt_); while (v.length < w) v.push(''); return v.slice(0, w); }));
    sh.setFrozenRows(1);
  }
  log_(user, '이수결과 시트 만들기', name + ' ' + Math.max(0, rows.length - 1) + '행');
  return { sheet: name, url: ss_().getUrl() + '#gid=' + sh.getSheetId() };
}
function apiLog_() {
  var r = rows_('log'); r = r.slice(Math.max(0, r.length - 200)).reverse();
  return { log: r.map(function (x) { return { at: String(x[0]), id: String(x[1]), action: String(x[2]), target: String(x[3]) }; }) };
}
