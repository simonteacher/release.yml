"""index.html → webapp/Index.html (Apps Script용)
- 내장된 SheetJS(약 64만 자)를 CDN 주소로 바꿔 Apps Script 편집기에 붙여넣기 쉽게 함
- 글꼴도 CDN에서 불러옴
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
