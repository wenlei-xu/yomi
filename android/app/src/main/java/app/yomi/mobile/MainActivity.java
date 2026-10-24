package app.yomi.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private final android.os.Handler updateWatchdog = new android.os.Handler(android.os.Looper.getMainLooper());
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureVaultPlugin.class);
        registerPlugin(ProactivePlugin.class);
        registerPlugin(YomiUpdaterPlugin.class);
        WebUpdates.prepare(this);
        super.onCreate(savedInstanceState);
        if (WebUpdates.needsConfirmation(this)) updateWatchdog.postDelayed(() -> {
            if (!WebUpdates.needsConfirmation(this) || getBridge() == null) return;
            try {
                WebUpdates.failPending(this);
                String previous = WebUpdates.committedPath(this);
                if (previous.isEmpty()) getBridge().setServerAssetPath("public");
                else getBridge().setServerBasePath(previous);
            } catch (Exception ignored) { /* Next cold start retries the rollback. */ }
        }, 90000);
    }
    @Override public void onDestroy() {
        updateWatchdog.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}

