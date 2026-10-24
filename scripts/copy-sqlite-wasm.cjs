const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const source = require.resolve('sql.js/dist/sql-wasm.wasm', {
  paths: [path.join(root, 'node_modules/jeep-sqlite')]
})
const target = path.join(root, 'public/assets/sql-wasm.wasm')

if (!fs.existsSync(source)) throw new Error('Missing sql.js WebAssembly binary; run npm install first')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.copyFileSync(source, target)
