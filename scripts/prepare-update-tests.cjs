const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os')
const {spawnSync}=require('node:child_process'),{zipSync}=require('fflate')
const root=path.resolve(__dirname,'..'),version=require('../version.json')
const debugKey=path.join(os.homedir(),'.android','debug.keystore')
if(!fs.existsSync(debugKey))throw new Error('Build a debug APK first to initialize the Android debug keystore')
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'yomi-update-tests-'))
const properties=path.join(temporary,'debug.properties')
fs.writeFileSync(properties,`storeFile=${debugKey.replace(/\\/g,'/')}\nstorePassword=android\nkeyAlias=androiddebugkey\nkeyPassword=android\n`)
const output=path.join(root,'android/app/src/androidTest/assets/update-fixtures');fs.mkdirSync(output,{recursive:true})
const java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java'
for(const [name,webVersion,schema,entries] of [
 ['good2',2,version.schemaVersion,{'index.html':'<html>healthy fixture</html>'}],
 ['good3',3,version.schemaVersion,{'index.html':'<html>next fixture</html>'}],
 ['traversal',2,version.schemaVersion,{'../escape.html':'unsafe','index.html':'fixture'}],
 ['schema',2,version.schemaVersion+1,{'index.html':'incompatible'}]]){
 const archive=Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name,value])=>[name,new TextEncoder().encode(value)]))))
 const payload=Buffer.from(JSON.stringify({format:'yomi-web-release',nativeVersionCode:version.versionCode,webVersion,schemaVersion:schema,url:`https://stoneapi.me/releases/web-test-${name}.zip`,size:archive.length,sha256:crypto.createHash('sha256').update(archive).digest('hex')}))
 const payloadFile=path.join(temporary,'payload.json');fs.writeFileSync(payloadFile,payload)
 const signed=spawnSync(java,[path.join(root,'scripts/SignWebUpdate.java'),properties,payloadFile],{encoding:'utf8',windowsHide:true})
 if(signed.status!==0)throw new Error('Unable to sign update test fixtures')
 fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify({payload:payload.toString('base64'),signature:signed.stdout}))
 fs.writeFileSync(path.join(output,name+'.zip'),archive)
}
// These exact files were created above; no recursive cleanup or user files are involved.
fs.unlinkSync(properties);fs.unlinkSync(path.join(temporary,'payload.json'));fs.rmdirSync(temporary)
console.log('Prepared offline signed web-update instrumentation fixtures')
