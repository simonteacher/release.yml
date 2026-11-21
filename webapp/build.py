"""index.html → webapp/Index.html (Apps Script용)
- 내장된 SheetJS(약 64만 자)를 CDN 주소로 바꿔 Apps Script 편집기에 붙여넣기 쉽게 함
- 글꼴도 CDN에서 불러옴
- 다른 학교용 배포판(webapp/배포판/)도 함께 만듦: 학교 정보를 비운 Index.html + Code.gs + appsscript.json
실행: python3 webapp/build.py   (GitHub에 올리면 자동으로 실행됩니다)"""
import pathlib, re, sys
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / 'index.html').read_text(encoding='utf-8')
start = src.index('<script>/*! xlsx.js')
end = src.index('</script>', start) + len('</script>')
cdn = '<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>'
out = src[:start] + cdn + src[end:]
font_local = "url('fonts/PretendardVariable.woff2')"
font_cdn = "url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/woff2/PretendardVariable.woff2')"
assert out.count(font_local) == 2, out.count(font_local)
out = out.replace(font_local, font_cdn)
note = '<!-- 자동 생성 파일: index.html을 고친 뒤 webapp/build.py가 만듭니다. 이 파일을 직접 고치지 마세요. -->\n'
out = out.replace('<!DOCTYPE html>\n', '<!DOCTYPE html>\n' + note, 1)
dst = root / 'webapp' / 'Index.html'
old = dst.read_text(encoding='utf-8') if dst.exists() else ''
if old != out:
    dst.write_text(out, encoding='utf-8')
    print('updated', dst, len(out))
else:
    print('unchanged')

# ── 다른 학교용 배포판 ──
import re as _re, shutil
gen = out
m = _re.search(r"var SCHOOL_INFO = \{[^\n]*\};", gen)
assert m, 'SCHOOL_INFO not found'
gen = gen.replace(m.group(0), "var SCHOOL_INFO = { name: '', url: '', dept: '교육과정부', phone: '', phoneBC: '', prevDate: '' };")
gen = gen.replace(note, '<!-- 최소 성취수준 보장지도 이수 관리 · 다른 학교용 배포판 (빈 구글 시트의 Apps Script에 붙여넣어 사용) -->\n')
leak = [w for w in ('광주', '경신', 'gshin', '605-4815') if w in gen]
assert not leak, leak
gdir = root / 'webapp' / '배포판'; gdir.mkdir(exist_ok=True)
changed = []
for name, body in (('Index.html', gen), ('Code.gs', (root / 'webapp' / 'Code.gs').read_text(encoding='utf-8')),
                   ('appsscript.json', (root / 'webapp' / 'appsscript.json').read_text(encoding='utf-8'))):
    f = gdir / name
    if not f.exists() or f.read_text(encoding='utf-8') != body:
        f.write_text(body, encoding='utf-8'); changed.append(name)
print('배포판', changed or 'unchanged')

# ── 다른 학교용 PC 프로그램의 ‘이 PC에서만 쓰기’ 화면 (학교 정보를 비운 index.html) ──
# 커밋하지 않고 빌드할 때만 만듦(.gitignore)
local = src.replace(m.group(0), "var SCHOOL_INFO = { name: '', url: '', dept: '교육과정부', phone: '', phoneBC: '', prevDate: '' };")
assert local != src and not [w for w in ('광주', '경신', 'gshin', '605-4815') if w in local]
(gdir / 'app.html').write_text(local, encoding='utf-8')
print('app.html', len(local))
