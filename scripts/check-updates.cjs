const {buildSync}=require('esbuild')
const assert=require('node:assert/strict'),path=require('node:path')
const bundled=buildSync({stdin:{contents:"export * from './src/update/manifest'",resolveDir:path.resolve(__dirname,'..')},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
const mod={exports:{}};new Function('require','module','exports',bundled)(require,mod,mod.exports)
const {parseRelease,isNewer}=mod.exports
const release={format:'yomi-release',applicationId:'app.yomi.mobile',versionCode:3,versionName:'1.0.2',minSdk:24,
 url:'https://stoneapi.me/releases/yomi-1.0.2-3.apk',sha256:'a'.repeat(64),size:123456,publishedAt:'2026-10-24T00:00:00Z',notes:'Update'}
assert.deepEqual(parseRelease(release),release)
for(const patch of [
 {url:'http://stoneapi.me/releases/test.apk'}, {url:'https://elsewhere.invalid/releases/test.apk'},
 {url:'https://stoneapi.me@elsewhere.invalid/releases/test.apk'}, {url:'https://stoneapi.me/releases/../test.apk'},
 {url:'https://stoneapi.me/releases/test.apk?redirect=1'}, {url:'https://stoneapi.me/releases/test.apk#fragment'},
 {url:'https://stoneapi.me/releases/test.html'}, {sha256:'invalid'}, {size:201*1024*1024},
 {size:0}, {versionCode:'3'}, {versionCode:1.5}, {applicationId:'another.app'}, {publishedAt:'invalid'},
 {notes:'x'.repeat(5001)}, {versionName:'not-a-version'}, {minSdk:23}
]) assert.throws(()=>parseRelease({...release,...patch}))
assert.equal(isNewer(release,{versionCode:2,sdk:35}),true)
assert.equal(isNewer(release,{versionCode:3,sdk:35}),false)
assert.equal(isNewer(release,{versionCode:4,sdk:35}),false)
assert.equal(isNewer({...release,minSdk:36},{versionCode:2,sdk:35}),false)
console.log('PASS release schema, trusted HTTPS URL, size/hash validation, version ordering and Android compatibility')
