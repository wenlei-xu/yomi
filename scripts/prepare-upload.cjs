const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict')
const {spawnSync}=require('node:child_process')
const root=path.resolve(__dirname,'..'),v=require('../version.json')
const nativeFolder=path.join(root,'release-output',`v${v.versionName}-${v.versionCode}`,'releases')
const webFolder=path.join(root,'release-output',`web-${v.versionCode}-${v.webVersion}`,'releases')
const manifest=JSON.parse(fs.readFileSync(path.join(nativeFolder,'latest.json'),'utf8'))
const apkName=path.basename(new URL(manifest.url).pathname),apk=fs.readFileSync(path.join(nativeFolder,apkName))
assert.equal(crypto.createHash('sha256').update(apk).digest('hex'),manifest.sha256)
assert.equal(apk.length,manifest.size)
const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT
if(!sdk)throw new Error('ANDROID_HOME is required')
const tools=fs.readdirSync(path.join(sdk,'build-tools')).filter(name=>/^\d+\.\d+\.\d+$/.test(name)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))[0]
const verified=spawnSync(path.join(sdk,'build-tools',tools,process.platform==='win32'?'apksigner.bat':'apksigner'),['verify','--print-certs-pem',path.join(nativeFolder,apkName)],{encoding:'utf8',windowsHide:true,shell:process.platform==='win32'})
if(verified.status!==0)throw new Error('Release APK signature check failed')
const certificate=verified.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)
if(!certificate)throw new Error('Missing APK signer certificate')
const descriptorName=`latest-web-${v.versionCode}.json`
const envelope=JSON.parse(fs.readFileSync(path.join(webFolder,descriptorName),'utf8'))
const payload=Buffer.from(envelope.payload,'base64')
assert.equal(crypto.verify('RSA-SHA256',payload,new crypto.X509Certificate(certificate[0]).publicKey,Buffer.from(envelope.signature,'base64')),true)
const web=JSON.parse(payload),zipName=path.basename(new URL(web.url).pathname),zip=fs.readFileSync(path.join(webFolder,zipName))
assert.equal(crypto.createHash('sha256').update(zip).digest('hex'),web.sha256);assert.equal(zip.length,web.size)
assert.equal(web.nativeVersionCode,v.versionCode);assert.equal(web.schemaVersion,v.schemaVersion)
const output=path.join(root,'release-output',`upload-${v.versionName}-${v.versionCode}`),releases=path.join(output,'releases')
fs.mkdirSync(releases,{recursive:true})
for(const [folder,name] of [[nativeFolder,apkName],[nativeFolder,'latest.json'],[webFolder,zipName],[webFolder,descriptorName]]){
 const bytes=fs.readFileSync(path.join(folder,name)),target=path.join(releases,name)
 if(fs.existsSync(target))assert.deepEqual(fs.readFileSync(target),bytes,'Existing upload file differs; do not overwrite a published release')
 else fs.writeFileSync(target,bytes,{flag:'wx'})
}
fs.writeFileSync(path.join(output,'UPLOAD-GUIDE.md'),`# Yomi 上传说明

本目录已验证 APK 签名、文件大小和 SHA-256；网页描述签名与 APK 的发布签名公钥一致。

## 上传

首次使用先运行 npm run oss:configure，按提示输入 OSS RAM 用户的 AccessKey ID 和 Secret。Secret 会用当前 Windows 用户的 DPAPI 加密保存，不会写入项目目录。

确认 OSS RAM 用户仅有 yomi-xu/releases/* 的 oss:PutObject 和 oss:PutObjectAcl 权限后，运行 npm run release:upload。工具会重新校验发布文件，按 APK、ZIP、网页描述、latest.json 的顺序上传，并通过公网域名核对文件大小和 SHA-256。

只把这四个对象设为公共读，Bucket 继续保持私有。不要上传整个项目或签名目录。JSON 使用 application/json 和 no-cache, max-age=0, must-revalidate；APK 与 ZIP 使用一年不可变缓存。

## 完成后验证

- APK 下载：https://stoneapi.me/releases/${apkName}
- 版本信息：https://stoneapi.me/releases/latest.json
- 热更新入口：https://stoneapi.me/releases/${descriptorName}

首次安装这个正式签名 APK 需要确认。以后兼容的页面改动可以通过签名网页包无感更新；原生功能仍通过 APK 更新。

已有 debug 测试版的用户必须先导出备份，再自行迁移到正式签名版；不要未备份就卸载。

此目录不包含发布私钥或 OSS 凭据。上传命令仅发布本次准备好的四个文件。
`)
console.log(`Verified four public release files: ${releases}`)
console.log('APK and web bundle use the same publishing identity. No credentials included.')
