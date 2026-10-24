package app.yomi.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureVault")
public class SecureVaultPlugin extends Plugin {
    private static final String KEY_ALIAS = "yomi.credential.v1";
    private static final String PREFS = "yomi_secure_vault";
    private static final int MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final Map<String, ActiveRequest> activeRequests = new ConcurrentHashMap<>();
    private final Map<String, Long> cancelledRequests = new ConcurrentHashMap<>();

    @PluginMethod
    public void set(PluginCall call) {
        String providerId = call.getString("providerId");
        String secret = call.getString("secret");
        String origin = call.getString("origin");
        if (providerId == null || providerId.isBlank() || secret == null || secret.isBlank() || origin == null) {
            call.reject("providerId, secret and origin are required", "invalid_input");
            return;
        }
        try {
            Uri uri = Uri.parse(origin);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
                call.reject("Only HTTPS model origins are supported", "invalid_origin");
                return;
            }
            String plaintext = secret + "\n" + origin;
            String encrypted = encrypt(plaintext);
            prefs().edit().putString(key(providerId), encrypted).apply();
            JSObject result = new JSObject();
            result.put("stored", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to protect credential", "vault_error");
        }
    }

    /**
     * Capacitor logs all bridge method arguments. Model credentials therefore
     * enter through a one-shot native prompt and are never serialized by JS.
     */
    @PluginMethod
    public void setWithoutSecret(PluginCall call) {
        String providerId = call.getString("providerId");
        String origin = call.getString("origin");
        if (providerId == null || providerId.isBlank() || origin == null) {
            call.reject("providerId and origin are required", "invalid_input");
            return;
        }
        try {
            Uri uri = Uri.parse(origin);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
                call.reject("Only HTTPS model origins are supported", "invalid_origin");
                return;
            }
            getActivity().runOnUiThread(() -> {
                android.widget.EditText input = new android.widget.EditText(getActivity());
                input.setHint("API Key");
                input.setSingleLine(true);
                input.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                    | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
                new android.app.AlertDialog.Builder(getActivity())
                    .setTitle("安全保存 API Key")
                    .setMessage("Key 仅写入 Android Keystore 加密容器，不会传给网页层。")
                    .setView(input)
                    .setNegativeButton("取消", (dialog, which) -> resolvePromptCancellation(call, providerId))
                    .setPositiveButton("保存", (dialog, which) -> {
                        String secret = input.getText().toString().trim();
                        if (secret.isEmpty()) {
                            call.reject("API Key is required", "invalid_input");
                            return;
                        }
                        try {
                            prefs().edit().putString(key(providerId),
                                encrypt(secret + "\n" + origin)).apply();
                            JSObject result = new JSObject();
                            result.put("stored", true);
                            call.resolve(result);
                        } catch (Exception error) {
                            call.reject("Unable to protect credential", "vault_error");
                        }
                    })
                    .setOnCancelListener(dialog -> resolvePromptCancellation(call, providerId))
                    .show();
            });
        } catch (Exception error) {
            call.reject("Unable to open secure input", "vault_error");
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        String providerId = call.getString("providerId");
        if (providerId == null || providerId.isBlank()) {
            call.reject("providerId is required", "invalid_input");
            return;
        }
        JSObject result = new JSObject();
        result.put("stored", prefs().contains(key(providerId)));
        call.resolve(result);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String providerId = call.getString("providerId");
        if (providerId == null || providerId.isBlank()) {
            call.reject("providerId is required", "invalid_input");
            return;
        }
        prefs().edit().remove(key(providerId)).apply();
        JSObject result = new JSObject();
        result.put("removed", true);
        call.resolve(result);
    }

    @PluginMethod
    public void copyCredential(PluginCall call) {
        String sourceId = call.getString("sourceId");
        String providerId = call.getString("providerId");
        String origin = call.getString("origin");
        if (sourceId == null || providerId == null || providerId.isBlank() || origin == null) {
            call.reject("sourceId, providerId and origin are required", "invalid_input");
            return;
        }
        try {
            Credential credential = readCredential(sourceId);
            if (credential == null || !credential.origin.equalsIgnoreCase(origin)) {
                call.reject("Credential is not valid for this origin", "origin_mismatch");
                return;
            }
            prefs().edit().putString(key(providerId), encrypt(credential.secret + "\n" + origin)).apply();
            JSObject result = new JSObject();
            result.put("stored", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to protect credential", "vault_error");
        }
    }

    @PluginMethod
    public void removeDatabaseFile(PluginCall call) {
        String name = call.getString("name");
        if (name == null || !name.matches("^yomi(?:_store_[a-f0-9]{32})?$")) {
            call.reject("Invalid database filename", "invalid_input");
            return;
        }
        String fileName = name + "SQLite.db";
        try {
            boolean exists = getContext().getDatabasePath(fileName).exists();
            if (exists && !getContext().deleteDatabase(fileName)) {
                call.reject("Unable to delete retained database", "file_error");
                return;
            }
            JSObject result = new JSObject();
            result.put("removed", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to delete retained database", "file_error");
        }
    }

    @PluginMethod
    public void request(PluginCall call) {
        String requestId = call.getString("requestId");
        String providerId = call.getString("providerId");
        String urlText = call.getString("url");
        String body = call.getString("body");
        String method = call.getString("method", "POST");
        boolean binary = Boolean.TRUE.equals(call.getBoolean("binary"));
        boolean streaming = Boolean.TRUE.equals(call.getBoolean("stream"));
        if (requestId == null || providerId == null || urlText == null || body == null) {
            call.reject("requestId, providerId, url and body are required", "invalid_input");
            return;
        }
        if (!"POST".equals(method) && !"GET".equals(method)) {
            call.reject("Only GET and POST requests are supported", "invalid_input");
            return;
        }
        ActiveRequest active = new ActiveRequest();
        activeRequests.put(requestId, active);
        if (cancelledRequests.remove(requestId) != null) active.cancelled = true;
        executor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                active.thread = Thread.currentThread();
                if (active.cancelled) throw new VaultException("Request cancelled", "cancelled");
                Credential credential = readCredential(providerId);
                if (credential == null) {
                    throw new VaultException("Credential is missing", "credential_missing");
                }
                URL url = new URL(urlText);
                Uri target = Uri.parse(urlText);
                if (!"https".equalsIgnoreCase(target.getScheme()) || !credential.origin.equalsIgnoreCase(target.getScheme() + "://" + target.getAuthority())) {
                    throw new VaultException("Credential is not valid for this origin", "origin_mismatch");
                }
                connection = (HttpURLConnection) url.openConnection();
                active.connection = connection;
                if (active.cancelled) throw new VaultException("Request cancelled", "cancelled");
                connection.setRequestMethod(method);
                connection.setConnectTimeout(30_000);
                connection.setReadTimeout(180_000);
                connection.setInstanceFollowRedirects(false);
                connection.setDoOutput("POST".equals(method));
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Accept", streaming ? "text/event-stream, application/json" : "application/json");
                connection.setRequestProperty("Authorization", "Bearer " + credential.secret);
                if ("POST".equals(method)) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream output = connection.getOutputStream()) {
                        output.write(bytes);
                    }
                }
                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
                boolean audioResponse = binary && status >= 200 && status < 300;
                String contentType = connection.getContentType();
                if (audioResponse && (contentType == null || !contentType.toLowerCase().startsWith("audio/"))) {
                    throw new VaultException("Speech service did not return audio", "invalid_media");
                }
                String responseBody = audioResponse ? readBase64(stream)
                    : streaming && status >= 200 && status < 300 && contentType != null && contentType.contains("text/event-stream")
                        ? readStreaming(stream, requestId, active) : readBounded(stream);
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", responseBody);
                result.put("binary", binary);
                result.put("contentType", contentType);
                if (active.cancelled) throw new VaultException("Request cancelled", "cancelled");
                call.resolve(result);
            } catch (VaultException error) {
                call.reject(error.getMessage(), error.code);
            } catch (Exception error) {
                if (active.cancelled || Thread.currentThread().isInterrupted()) call.reject("Request cancelled", "cancelled");
                else call.reject("Network request failed", "network_error");
            } finally {
                activeRequests.remove(requestId);
                cancelledRequests.remove(requestId);
                if (connection != null) connection.disconnect();
                Thread.interrupted();
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String requestId = call.getString("requestId");
        long cutoff = android.os.SystemClock.elapsedRealtime() - 300_000;
        cancelledRequests.entrySet().removeIf(entry -> entry.getValue() < cutoff);
        if (requestId != null) cancelledRequests.put(requestId, android.os.SystemClock.elapsedRealtime());
        ActiveRequest active = requestId == null ? null : activeRequests.remove(requestId);
        if (active != null) {
            active.cancelled = true;
            if (active.connection != null) active.connection.disconnect();
            if (active.thread != null) active.thread.interrupt();
        }
        JSObject result = new JSObject();
        result.put("cancelled", active != null);
        call.resolve(result);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void resolvePromptCancellation(PluginCall call, String providerId) {
        JSObject result = new JSObject();
        result.put("stored", prefs().contains(key(providerId)));
        result.put("cancelled", true);
        call.resolve(result);
    }

    private String key(String providerId) {
        return "credential_" + providerId;
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private String encrypt(String plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        byte[] combined = new byte[1 + iv.length + encrypted.length];
        combined[0] = (byte) iv.length;
        System.arraycopy(iv, 0, combined, 1, iv.length);
        System.arraycopy(encrypted, 0, combined, 1 + iv.length, encrypted.length);
        return Base64.encodeToString(combined, Base64.NO_WRAP);
    }

    private Credential readCredential(String providerId) throws Exception {
        String stored = prefs().getString(key(providerId), null);
        if (stored == null) return null;
        byte[] combined = Base64.decode(stored, Base64.NO_WRAP);
        int ivLength = combined[0] & 0xff;
        byte[] iv = new byte[ivLength];
        byte[] encrypted = new byte[combined.length - 1 - ivLength];
        System.arraycopy(combined, 1, iv, 0, ivLength);
        System.arraycopy(combined, 1 + ivLength, encrypted, 0, encrypted.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        String plaintext = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        int separator = plaintext.indexOf('\n');
        if (separator < 1) throw new VaultException("Credential container is invalid", "vault_error");
        return new Credential(plaintext.substring(0, separator), plaintext.substring(separator + 1));
    }

    private String readStreaming(InputStream input, String requestId, ActiveRequest active) throws Exception {
        try (InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
            StringBuilder body = new StringBuilder();
            char[] buffer = new char[2048];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                if (active.cancelled) throw new VaultException("Request cancelled", "cancelled");
                body.append(buffer, 0, count);
                if (body.length() > MAX_RESPONSE_BYTES / 2) throw new VaultException("Response too large", "response_too_large");
                JSObject event = new JSObject();
                event.put("requestId", requestId);
                event.put("chunk", new String(buffer, 0, count));
                notifyListeners("requestChunk", event);
            }
            return body.toString();
        }
    }

    private String readBounded(InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                total += read;
                if (total > MAX_RESPONSE_BYTES) {
                    throw new VaultException("Model response is too large", "response_too_large");
                }
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    /** Binary responses (audio) are base64 encoded so they survive the bridge. */
    private String readBase64(InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                total += read;
                if (total > MAX_RESPONSE_BYTES) {
                    throw new VaultException("Media response is too large", "response_too_large");
                }
                output.write(buffer, 0, read);
            }
            return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        }
    }

    private static final class Credential {
        final String secret;
        final String origin;

        Credential(String secret, String origin) {
            this.secret = secret;
            this.origin = origin;
        }
    }

    private static final class VaultException extends Exception {
        final String code;

        VaultException(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    private static final class ActiveRequest {
        volatile HttpURLConnection connection;
        volatile Thread thread;
        volatile boolean cancelled;
    }
}
