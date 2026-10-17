// Copies the three.js browser build next to index.html so the app works offline and packages small.
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, '..', 'vendor'); fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.min.js'), path.join(out, 'three.min.js'));
console.log('vendor: three.min.js ready');
