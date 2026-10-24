package app.yomi.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/** User-started session; a process death never silently restarts a conversation. */
public class ProactiveService extends Service {
    static final String CHANNEL = "yomi_proactive";
    static volatile boolean running = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock lock;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!ProactivePlugin.tick()) { stopSelf(); return; }
            if (lock != null) lock.acquire(65_000);
            handler.postDelayed(this, 30_000);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "角色后台互动", NotificationManager.IMPORTANCE_LOW));
            manager.createNotificationChannel(new NotificationChannel("yomi_messages", "角色新消息", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent launch = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, ProactiveService.class).setAction("stop");
        PendingIntent stopAction = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        startForeground(1801, new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("Yomi 后台互动已开启")
            .setContentText("按已设置的时间检查角色发言；点击停止可结束本次后台运行")
            .setContentIntent(launch).setOngoing(true).addAction(0, "停止", stopAction).build());
        PowerManager power = getSystemService(PowerManager.class);
        lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Yomi:Proactive");
        lock.setReferenceCounted(false);
        lock.acquire(65_000);
        running = true;
        handler.post(tick);
    }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (intent != null && "stop".equals(intent.getAction())) stopSelf();
        return START_NOT_STICKY;
    }
    @Override public void onTaskRemoved(Intent rootIntent) { stopSelf(); }
    @Override public void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        if (lock != null && lock.isHeld()) lock.release();
        ProactivePlugin.stopped();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
