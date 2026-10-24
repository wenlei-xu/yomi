package app.yomi.mobile;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "YomiUpdater")
public class YomiUpdaterPlugin extends Plugin {
    private static final String ORIGIN = "https://stoneapi.me";
    private static final long MAX_APK = 200L * 1024 * 1024;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile Transfer transfer;

    @PluginMethod public void webStatus(PluginCall call) {
        try { call.resolve(JSObject.fromJSONObject(WebUpdates.status(getContext()))); }
        catch (Exception error) { call.reject("无法读取热更新状态"); }
    }
    @PluginMethod public void confirmWeb(PluginCall call) {
        try { WebUpdates.confirm(getContext()); call.resolve(); }
        catch (Exception error) { call.reject("无法确认新版本启动"); }
    }
    @PluginMethod public void syncWeb(PluginCall call) {
        executor.execute(() -> {
            try { call.resolve(JSObject.fromJSONObject(WebUpdates.sync(getContext()))); }
            catch (Exception error) { call.reject("热更新未完成，继续使用当前版本，稍后会重试"); }
        });
    }
    @PluginMethod public void rollbackWeb(PluginCall call) {
        try { WebUpdates.rollback(getContext()); call.resolve(); }
        catch (Exception error) { call.reject("无法设置资源回退"); }
    }

    @PluginMethod public void info(PluginCall call) {
        try {
            PackageInfo info = currentPackage();
            JSObject result = new JSObject();
            result.put("versionName", info.versionName);
            result.put("versionCode", version(info));
            result.put("sdk", Build.VERSION.SDK_INT);
            result.put("debug", (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
            call.resolve(result);
        } catch (Exception error) { call.reject("无法读取应用版本"); }
    }

    @PluginMethod public void check(PluginCall call) {
        executor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = open(ORIGIN + "/releases/latest.json");
                requireSuccess(connection);
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                try (InputStream input = connection.getInputStream()) {
                    byte[] buffer = new byte[4096]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > 65536) throw new Exception("更新信息超过大小限制");
                        output.write(buffer, 0, count);
                    }
                }
                JSObject result = new JSObject();
                result.put("body", output.toString(StandardCharsets.UTF_8.name()));
                call.resolve(result);
            } catch (Exception error) { call.reject(message(error, "检查更新失败，请检查网络后重试")); }
            finally { if (connection != null) connection.disconnect(); }
        });
    }

    @PluginMethod public synchronized void download(PluginCall call) {
        if (transfer != null) { call.reject("已有安装包正在下载"); return; }
        try {
            String requestId = call.getString("requestId");
            UUID.fromString(requestId);
            JSObject release = call.getObject("release");
            validateRelease(release);
            Transfer active = new Transfer(requestId);
            transfer = active;
            executor.execute(() -> fetchApk(call, release, active));
        } catch (Exception error) { call.reject(message(error, "更新信息无效")); }
    }

    private void fetchApk(PluginCall call, JSONObject release, Transfer active) {
        HttpURLConnection connection = null;
        File partial = new File(folder(), "payload.part");
        try {
            if (active.cancelled) throw new Exception("下载已取消");
            connection = open(release.getString("url"));
            connection.setReadTimeout(30000);
            active.connection = connection;
            if (active.cancelled) throw new Exception("下载已取消");
            requireSuccess(connection);
            long expected = release.getLong("size");
            long length = connection.getContentLengthLong();
            if (length > 0 && length != expected) throw new Exception("安装包大小与发布信息不一致");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long total = 0, last = 0, started = System.nanoTime();
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (active.cancelled) throw new Exception("下载已取消");
                    if (System.nanoTime() - started > 15L * 60 * 1_000_000_000) throw new Exception("下载超时，请重试");
                    total += count;
                    if (total > expected || total > MAX_APK) throw new Exception("安装包超过预期大小");
                    digest.update(buffer, 0, count); output.write(buffer, 0, count);
                    long now = android.os.SystemClock.elapsedRealtime();
                    if (now - last >= 250 || total == expected) {
                        last = now;
                        JSObject progress = new JSObject();
                        progress.put("requestId", active.id); progress.put("bytes", total); progress.put("total", expected);
                        notifyListeners("progress", progress);
                    }
                }
                output.getFD().sync();
            }
            if (active.cancelled) throw new Exception("下载已取消");
            if (total != expected || !hex(digest.digest()).equals(release.getString("sha256"))) {
                throw new Exception("安装包校验失败，请重新下载");
            }
            // Android authenticates the final APK again during installation. Reject wrong packages earlier.
            verifyPackage(partial, release);
            if (active.cancelled) throw new Exception("下载已取消");
            File apk = apkFile(release);
            if (apk.exists() && !apk.delete()) throw new Exception("无法替换缓存安装包");
            if (!partial.renameTo(apk)) throw new Exception("无法保存安装包");
            File metadata = new File(folder(), "ready.json");
            File temp = new File(folder(), "ready.tmp");
            try (FileOutputStream output = new FileOutputStream(temp)) {
                output.write(release.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
            }
            if (metadata.exists() && !metadata.delete()) throw new Exception("无法保存下载记录");
            if (!temp.renameTo(metadata)) throw new Exception("无法保存下载记录");
            call.resolve();
        } catch (Exception error) {
            call.reject(active.cancelled ? "下载已取消" : message(error, "下载失败，请检查网络后重试"));
        } finally {
            if (connection != null) connection.disconnect();
            partial.delete();
            synchronized (this) { if (transfer == active) transfer = null; }
        }
    }

    @PluginMethod public void cancel(PluginCall call) {
        Transfer active = transfer;
        if (active != null && active.id.equals(call.getString("requestId"))) {
            active.cancelled = true;
            if (active.connection != null) active.connection.disconnect();
        }
        call.resolve();
    }

    @PluginMethod public void ready(PluginCall call) {
        executor.execute(() -> {
            JSObject result = new JSObject();
            try {
                JSONObject release = readReady();
                validateRelease(release);
                if (apkFile(release).isFile() && apkFile(release).length() == release.getLong("size") &&
                    release.getLong("versionCode") > version(currentPackage())) result.put("release", release);
            } catch (Exception ignored) { /* Cache eviction and an installed update are normal. */ }
            call.resolve(result);
        });
    }

    @PluginMethod public void install(PluginCall call) {
        if (transfer != null) { call.reject("请等待下载完成"); return; }
        executor.execute(() -> {
            try {
                JSONObject release = readReady(); validateRelease(release);
                File apk = apkFile(release);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (InputStream input = new FileInputStream(apk)) {
                    byte[] buffer = new byte[32768]; int count;
                    while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
                }
                if (apk.length() != release.getLong("size") || !hex(digest.digest()).equals(release.getString("sha256"))) {
                    throw new Exception("缓存安装包已失效，请重新下载");
                }
                verifyPackage(apk, release);
                getActivity().runOnUiThread(() -> {
                    try {
                        JSObject result = new JSObject();
                        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                            getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getContext().getPackageName())));
                            result.put("permissionRequired", true);
                        } else {
                            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive");
                            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            getActivity().startActivity(intent);
                            result.put("permissionRequired", false);
                        }
                        call.resolve(result);
                    } catch (Exception error) { call.reject("无法打开系统安装界面，请检查系统设置"); }
                });
            } catch (Exception error) { call.reject(message(error, "安装包不可用，请重新下载")); }
        });
    }

    private JSONObject readReady() throws Exception {
        File metadata = new File(folder(), "ready.json");
        if (metadata.length() > 65536) throw new Exception("下载记录无效");
        try (InputStream input = new FileInputStream(metadata); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        }
    }

    private void validateRelease(JSONObject release) throws Exception {
        if (release == null || !"yomi-release".equals(release.getString("format")) ||
            !getContext().getPackageName().equals(release.getString("applicationId")) ||
            release.getLong("versionCode") <= version(currentPackage()) ||
            release.getInt("minSdk") > Build.VERSION.SDK_INT ||
            release.getLong("size") < 1 || release.getLong("size") > MAX_APK ||
            !release.getString("sha256").matches("[a-f0-9]{64}")) throw new Exception("更新信息无效或不适用于当前设备");
        URL url = new URL(release.getString("url"));
        if (!"https".equals(url.getProtocol()) || !"stoneapi.me".equals(url.getHost()) ||
            (url.getPort() != -1 && url.getPort() != 443) || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null ||
            !url.getPath().matches("/releases/[a-zA-Z0-9._-]+\\.apk")) throw new Exception("安装包下载地址无效");
    }

    private void verifyPackage(File file, JSONObject release) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), flags);
        if (archive == null || !installed.packageName.equals(archive.packageName) ||
            version(archive) != release.getLong("versionCode") || version(archive) <= version(installed) ||
            !release.getString("versionName").equals(archive.versionName) ||
            archive.applicationInfo == null || archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT) {
            throw new Exception("安装包身份、版本或设备兼容性校验失败");
        }
        Set<String> expected = signatures(installed), actual = signatures(archive);
        if (expected.isEmpty() || !expected.equals(actual)) {
            throw new Exception("安装包签名与当前应用不一致。测试版迁移正式版须先导出备份，不能直接覆盖安装。");
        }
    }

    private static Set<String> signatures(PackageInfo info) {
        Signature[] values = Build.VERSION.SDK_INT >= 28
            ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        Set<String> result = new HashSet<>();
        if (values != null) for (Signature value : values) result.add(Base64.encodeToString(value.toByteArray(), Base64.NO_WRAP));
        return result;
    }

    private File folder() { File folder = new File(getContext().getCacheDir(), "yomi-updates"); folder.mkdirs(); return folder; }
    private File apkFile(JSONObject release) throws Exception { return new File(folder(), release.getString("sha256") + ".apk"); }
    private PackageInfo currentPackage() throws Exception { return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0); }
    private static long version(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte value : bytes) out.append(String.format("%02x", value & 255)); return out.toString(); }
    private static String message(Exception error, String fallback) {
        return error.getClass() == Exception.class && error.getMessage() != null ? error.getMessage() : fallback;
    }
    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000); connection.setReadTimeout(15000);
        connection.setInstanceFollowRedirects(false); connection.setRequestProperty("Cache-Control", "no-cache");
        connection.setRequestProperty("Accept-Encoding", "identity");
        return connection;
    }
    private static void requireSuccess(HttpURLConnection connection) throws Exception {
        int status = connection.getResponseCode();
        if (status == 403 || status == 404) throw new Exception("更新文件尚未发布或未开放读取，请稍后重试");
        if (status != 200) throw new Exception("更新服务暂不可用（" + status + "）");
    }
    private static class Transfer { final String id; volatile boolean cancelled; volatile HttpURLConnection connection; Transfer(String id) { this.id = id; } }
}
