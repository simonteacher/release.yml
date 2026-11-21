// 다른 학교용 프로그램의 electron-builder 설정을 package.json의 설정에서 만들어 build/generic.config.json에 씀
const fs = require('fs');
const pkg = require('../package.json');
const b = JSON.parse(JSON.stringify(pkg.build));
b.appId = 'kr.school.isu-manager';
b.productName = '최소성취수준이수관리';
b.files = ['main.js', 'preload.js', 'gsetup.js', 'setup.html', 'config.generic.json', 'package.json', 'fonts/**',
  { from: 'webapp/배포판', to: 'server', filter: ['Code.gs', 'Index.html', 'appsscript.json'] },
  { from: 'webapp/배포판', to: '.', filter: ['app.html'] }];
b.directories = Object.assign({}, b.directories, { output: 'dist-generic' });
b.win = Object.assign({}, b.win, { signAndEditExecutable: true });
b.nsis = Object.assign({}, b.nsis, { shortcutName: '최소성취수준 이수관리', artifactName: 'ISU-Manager-Setup.${ext}' });
b.publish = b.publish.map(p => Object.assign({}, p, { channel: 'generic' }));
b.extraMetadata = { productName: '최소성취수준이수관리' };
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/generic.config.json', JSON.stringify(b, null, 2));
console.log('build/generic.config.json written');
