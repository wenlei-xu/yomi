package app.yomi.mobile;

import android.Manifest;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.lang.ref.WeakReference;

@CapacitorPlugin(name = "Proactive", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class ProactivePlugin extends Plugin {
    private static WeakReference<ProactivePlugin> instance = new WeakReference<>(null);
    @Override public void load() { instance = new WeakReference<>(this); }
    static boolean tick() {
        ProactivePlugin plugin = instance.get();
        if (plugin == null) return false;
        plugin.notifyListeners("tick", new JSObject());
        return true;
    }
    static void stopped() {
        ProactivePlugin plugin = instance.get();
        if (plugin != null) plugin.notifyListeners("stopped", new JSObject());
    }
    @PluginMethod public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermission");
        } else begin(call);
    }
    @PermissionCallback private void notificationPermission(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("请允许通知后开启后台互动"); return;
        }
        begin(call);
    }
    private void begin(PluginCall call) {
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), ProactiveService.class));
            call.resolve();
        } catch (Exception error) { call.reject("无法启动后台互动，请在应用前台重试"); }
    }
    @PluginMethod public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ProactiveService.class));
        call.resolve();
    }
    @PluginMethod public void status(PluginCall call) {
        JSObject result = new JSObject(); result.put("running", ProactiveService.running); call.resolve(result);
    }
    @PluginMethod public void notifyMessage(PluginCall call) {
        if (!ProactiveService.running) { call.resolve(); return; }
        Intent open = new Intent(getContext(), MainActivity.class);
        PendingIntent launch = PendingIntent.getActivity(getContext(), 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        getContext().getSystemService(NotificationManager.class).notify(1802,
            new NotificationCompat.Builder(getContext(), "yomi_messages")
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(call.getString("title", "Yomi"))
                .setContentText("收到一条角色消息").setContentIntent(launch).setAutoCancel(true).build());
        call.resolve();
    }
    @Override protected void handleOnDestroy() {
        getContext().stopService(new Intent(getContext(), ProactiveService.class));
        instance.clear();
    }
}
