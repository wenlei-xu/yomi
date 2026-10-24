package app.yomi.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;

/** Signed, same-native-version web bundles. Activation happens only at a cold start. */
final class WebUpdates {
    private static final int MAX_ZIP = 20 * 1024 * 1024;
    private static final int MAX_EXPANDED = 80 * 1024 * 1024;
    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("yomi_web_updates", Context.MODE_PRIVATE); }
    private static long nativeVersion(Context c) throws Exception {
        PackageInfo info = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }
    private static File root(Context c) { File f = new File(c.getFilesDir(), "yomi-web"); f.mkdirs(); return f; }
    private static File bundle(Context c, String name) { return new File(root(c), name); }
    private static boolean validFolder(Context c, String name) {
        return name.matches("b[0-9]+-[a-f0-9]{64}") && new File(bundle(c, name), "index.html").isFile();
    }
    private static void requireCommit(boolean success) throws Exception { if (!success) throw new Exception("Unable to persist web update state"); }

    static void prepare(Context activity) {
        SharedPreferences p = prefs(activity);
        try {
            long nativeCode = nativeVersion(activity);
            if (p.getLong("native", -1) != nativeCode) {
                requireCommit(p.edit().clear().putLong("native", nativeCode).commit());
            }
            if (p.getBoolean("bootPending", false)) {
                requireCommit(p.edit().putLong("blocked", p.getLong("pendingVersion", 0))
                    .remove("pending").remove("pendingVersion").putBoolean("bootPending", false).putBoolean("rolledBack", true).commit());
            }
            String active = p.getString("active", "");
            String pending = p.getString("pending", "");
            String selected = validFolder(activity, pending) ? pending : active;
            if (selected.equals(pending) && !pending.isEmpty()) requireCommit(p.edit().putBoolean("bootPending", true).commit());
            SharedPreferences.Editor bridge = activity.getSharedPreferences("CapWebViewSettings", Context.MODE_PRIVATE).edit();
            if (validFolder(activity, selected)) bridge.putString("serverBasePath", bundle(activity, selected).getAbsolutePath());
            else bridge.remove("serverBasePath");
            requireCommit(bridge.commit());
        } catch (Exception error) {
            activity.getSharedPreferences("CapWebViewSettings", Context.MODE_PRIVATE).edit().remove("serverBasePath").commit();
        }
    }

    static synchronized void confirm(Context c) throws Exception {
        SharedPreferences p = prefs(c);
        if (!p.getBoolean("bootPending", false)) return;
        String pending = p.getString("pending", "");
        if (!validFolder(c, pending)) throw new Exception("Web update is missing");
        requireCommit(p.edit().putString("previous", p.getString("active", ""))
            .putLong("previousVersion", p.getLong("activeVersion", BuildConfig.WEB_VERSION))
            .putString("active", pending).putLong("activeVersion", p.getLong("pendingVersion", 0))
            .remove("pending").remove("pendingVersion").putBoolean("bootPending", false).putBoolean("rolledBack", false).commit());
    }

    static synchronized void failPending(Context c) throws Exception {
        SharedPreferences p = prefs(c);
        requireCommit(p.edit().putLong("blocked", Math.max(p.getLong("blocked", 0), p.getLong("pendingVersion", 0)))
            .remove("pending").remove("pendingVersion").putBoolean("bootPending", false).putBoolean("rolledBack", true).commit());
    }
    static String committedPath(Context c) {
        String active = prefs(c).getString("active", "");
        return validFolder(c, active) ? bundle(c, active).getAbsolutePath() : "";
    }

    static boolean needsConfirmation(Context c) { return prefs(c).getBoolean("bootPending", false); }

    static synchronized void rollback(Context c) throws Exception {
        SharedPreferences p = prefs(c);
        long blocked = Math.max(p.getLong("activeVersion", BuildConfig.WEB_VERSION), p.getLong("pendingVersion", 0));
        String previous = p.getString("previous", "");
        requireCommit(p.edit().putString("active", validFolder(c, previous) ? previous : "")
            .putLong("activeVersion", validFolder(c, previous) ? p.getLong("previousVersion", BuildConfig.WEB_VERSION) : BuildConfig.WEB_VERSION)
            .putLong("blocked", Math.max(blocked, p.getLong("blocked", 0))).remove("previous").remove("previousVersion")
            .remove("pending").remove("pendingVersion").putBoolean("bootPending", false).putBoolean("rolledBack", true).commit());
    }

    static JSONObject status(Context c) throws Exception {
        SharedPreferences p = prefs(c);
        JSONObject status = new JSONObject();
        status.put("activeVersion", p.getLong("activeVersion", BuildConfig.WEB_VERSION));
        status.put("pendingVersion", p.getLong("pendingVersion", 0));
        status.put("rolledBack", p.getBoolean("rolledBack", false));
        return status;
    }

    static synchronized JSONObject sync(Context c) throws Exception {
        // Avoid unrequested cellular downloads. A later foreground launch retries on Wi-Fi.
        android.net.ConnectivityManager connectivity = (android.net.ConnectivityManager)c.getSystemService(Context.CONNECTIVITY_SERVICE);
        android.net.NetworkCapabilities network = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
        if (network == null || !network.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) || connectivity.isActiveNetworkMetered()) {
            JSONObject skipped = status(c); skipped.put("skippedNetwork", true); return skipped;
        }
        SharedPreferences p = prefs(c);
        if (p.getBoolean("bootPending", false)) return status(c);
        byte[] descriptor = get("https://stoneapi.me/releases/latest-web-" + nativeVersion(c) + ".json", 65536, true);
        if (descriptor == null) return status(c);
        JSONObject envelope = new JSONObject(new String(descriptor, StandardCharsets.UTF_8));
        JSONObject release = verifiedRelease(c, envelope);
        long next = release.getLong("webVersion");
        if (next <= Math.max(Math.max(p.getLong("activeVersion", BuildConfig.WEB_VERSION), p.getLong("pendingVersion", 0)), p.getLong("blocked", 0))) return status(c);
        byte[] archive = get(release.getString("url"), release.getInt("size"), false);
        return stageBundle(c, envelope, archive);
    }

    private static JSONObject verifiedRelease(Context c, JSONObject envelope) throws Exception {
        byte[] payload = android.util.Base64.decode(envelope.getString("payload"), android.util.Base64.DEFAULT);
        byte[] signature = android.util.Base64.decode(envelope.getString("signature"), android.util.Base64.DEFAULT);
        PackageManager pm = c.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo installed = pm.getPackageInfo(c.getPackageName(), flags);
        android.content.pm.Signature[] signers = Build.VERSION.SDK_INT >= 28 ? installed.signingInfo.getApkContentsSigners() : installed.signatures;
        if (signers.length != 1) throw new Exception("Unexpected app signing identity");
        java.security.cert.Certificate cert = CertificateFactory.getInstance("X.509").generateCertificate(new java.io.ByteArrayInputStream(signers[0].toByteArray()));
        java.security.Signature verifier = java.security.Signature.getInstance("SHA256withRSA");
        verifier.initVerify(cert.getPublicKey()); verifier.update(payload);
        if (!verifier.verify(signature)) throw new Exception("Web update signature mismatch");
        JSONObject release = new JSONObject(new String(payload, StandardCharsets.UTF_8));
        long next = release.getLong("webVersion");
        if (!"yomi-web-release".equals(release.getString("format")) || release.getLong("nativeVersionCode") != nativeVersion(c) ||
            release.getInt("schemaVersion") != BuildConfig.WEB_SCHEMA || next < 1) throw new Exception("Incompatible web update");
        String hash = release.getString("sha256"), url = release.getString("url");
        long size = release.getLong("size");
        if (!hash.matches("[a-f0-9]{64}") || size < 1 || size > MAX_ZIP ||
            !url.matches("https://stoneapi\\.me/releases/web-[a-zA-Z0-9._-]+\\.zip")) throw new Exception("Invalid web update metadata");
        return release;
    }

    static synchronized JSONObject stageBundle(Context c, JSONObject envelope, byte[] archive) throws Exception {
        JSONObject release = verifiedRelease(c, envelope);
        SharedPreferences p = prefs(c);
        long next = release.getLong("webVersion");
        if (next <= Math.max(Math.max(p.getLong("activeVersion", BuildConfig.WEB_VERSION), p.getLong("pendingVersion", 0)), p.getLong("blocked", 0))) return status(c);
        String hash = release.getString("sha256");
        long size = release.getLong("size");
        if (archive.length != size || !hex(MessageDigest.getInstance("SHA-256").digest(archive)).equals(hash)) throw new Exception("Web bundle checksum mismatch");
        String name = "b" + next + "-" + hash;
        File destination = bundle(c, name);
        if (destination.exists()) deleteTree(destination, root(c));
        destination.mkdirs();
        try {
            int count = 0, total = 0;
            SetNames names = new SetNames();
            try (ZipInputStream zip = new ZipInputStream(new java.io.ByteArrayInputStream(archive))) {
                ZipEntry entry;
                byte[] buffer = new byte[32768];
                while ((entry = zip.getNextEntry()) != null) {
                    String relative = entry.getName();
                    if (++count > 2000 || relative.isEmpty() || relative.contains("\\") || relative.startsWith("/") || relative.contains(":")) throw new Exception("Unsafe web bundle path");
                    File target = new File(destination, relative);
                    if (!target.getCanonicalPath().startsWith(destination.getCanonicalPath() + File.separator) || !names.add(relative)) throw new Exception("Unsafe or duplicate web bundle entry");
                    if (entry.isDirectory()) { target.mkdirs(); continue; }
                    target.getParentFile().mkdirs();
                    try (FileOutputStream output = new FileOutputStream(target)) {
                        int read;
                        while ((read = zip.read(buffer)) != -1) {
                            total += read;
                            if (total > MAX_EXPANDED) throw new Exception("Expanded web bundle too large");
                            output.write(buffer, 0, read);
                        }
                    }
                }
            }
            if (!new File(destination, "index.html").isFile()) throw new Exception("Missing web entry point");
            requireCommit(p.edit().putString("pending", name).putLong("pendingVersion", next).commit());
        } catch (Exception error) { deleteTree(destination, root(c)); throw error; }
        return status(c);
    }

    private static class SetNames extends java.util.HashSet<String> { }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte value:bytes) out.append(String.format("%02x",value&255)); return out.toString(); }
    private static byte[] get(String url, int max, boolean optional) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URL(url).openConnection();
        connection.setConnectTimeout(15000); connection.setReadTimeout(30000); connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Cache-Control", "no-cache"); connection.setRequestProperty("Accept-Encoding", "identity");
        try {
            int status = connection.getResponseCode();
            if (optional && (status == 403 || status == 404)) return null;
            if (status != 200) throw new Exception("Web update service unavailable");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > max) throw new Exception("Web update download too large");
                    output.write(buffer, 0, count);
                }
                return output.toByteArray();
            }
        } finally { connection.disconnect(); }
    }

    private static void deleteTree(File target, File allowedRoot) throws Exception {
        if (!target.getCanonicalPath().startsWith(allowedRoot.getCanonicalPath() + File.separator)) throw new Exception("Unsafe cleanup path");
        File[] children = target.listFiles();
        if (children != null) for (File child:children) deleteTree(child, allowedRoot);
        if (target.exists() && !target.delete()) throw new Exception("Unable to remove old web bundle");
    }
}
