package app.yomi.mobile;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class WebUpdatesTest {
    private Context context;
    @Before public void setup() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.getSharedPreferences("yomi_web_updates",0).edit().clear().commit();
        WebUpdates.prepare(context);
    }
    @After public void cleanup() {
        context.getSharedPreferences("yomi_web_updates",0).edit().clear().commit();
        context.getSharedPreferences("CapWebViewSettings",0).edit().remove("serverBasePath").commit();
    }
    private byte[] asset(String name) throws Exception {
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("update-fixtures/"+name);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while((count=input.read(buffer))!=-1) output.write(buffer,0,count);
            return output.toByteArray();
        }
    }
    private JSONObject envelope(String name) throws Exception { return new JSONObject(new String(asset(name+".json"),StandardCharsets.UTF_8)); }
    private void stage(String name) throws Exception { WebUpdates.stageBundle(context,envelope(name),asset(name+".zip")); }
    @Test public void signedBundleStagesWithoutSwitchingAndCommitsOnlyAfterHealthyBoot() throws Exception {
        stage("good2");
        assertEquals(2,WebUpdates.status(context).getLong("pendingVersion"));
        assertFalse(WebUpdates.needsConfirmation(context));
        WebUpdates.prepare(context);
        assertTrue(WebUpdates.needsConfirmation(context));
        assertFalse(context.getSharedPreferences("CapWebViewSettings",0).getString("serverBasePath","").isEmpty());
        WebUpdates.confirm(context);
        assertEquals(2,WebUpdates.status(context).getLong("activeVersion"));
        assertFalse(WebUpdates.needsConfirmation(context));
    }
    @Test public void failedBootRollsBackAndBlockedVersionDoesNotReinstall() throws Exception {
        stage("good2");WebUpdates.prepare(context);WebUpdates.confirm(context);
        stage("good3");WebUpdates.prepare(context);
        assertTrue(WebUpdates.needsConfirmation(context));
        WebUpdates.prepare(context);
        assertFalse(WebUpdates.needsConfirmation(context));
        assertEquals(2,WebUpdates.status(context).getLong("activeVersion"));
        assertTrue(WebUpdates.status(context).getBoolean("rolledBack"));
        stage("good3");assertEquals(0,WebUpdates.status(context).getLong("pendingVersion"));
    }
    @Test public void alteredDescriptorAndZipAreRejected() throws Exception {
        JSONObject altered=envelope("good2");
        byte[] payload=android.util.Base64.decode(altered.getString("payload"),android.util.Base64.DEFAULT);
        payload[10]^=1;altered.put("payload",android.util.Base64.encodeToString(payload,android.util.Base64.NO_WRAP));
        try {WebUpdates.stageBundle(context,altered,asset("good2.zip"));fail("tampered signature accepted");}catch(Exception expected){assertTrue(expected.getMessage().contains("signature"));}
        byte[] bytes=asset("good2.zip");bytes[5]^=1;
        try {WebUpdates.stageBundle(context,envelope("good2"),bytes);fail("tampered zip accepted");}catch(Exception expected){assertTrue(expected.getMessage().contains("checksum"));}
        assertEquals(0,WebUpdates.status(context).getLong("pendingVersion"));
    }
    @Test public void signedTraversalAndSchemaChangesAreRejected() throws Exception {
        try {stage("traversal");fail("zip traversal accepted");}catch(Exception expected){assertNotNull(expected.getMessage());}
        assertFalse(new java.io.File(context.getFilesDir(),"yomi-web/escape.html").exists());
        try {stage("schema");fail("schema change accepted");}catch(Exception expected){assertTrue(expected.getMessage().contains("Incompatible"));}
        assertEquals(0,WebUpdates.status(context).getLong("pendingVersion"));
    }
    @Test public void userCanReturnToBuiltInResourcesOnNextStart() throws Exception {
        stage("good2");WebUpdates.prepare(context);WebUpdates.confirm(context);
        WebUpdates.rollback(context);WebUpdates.prepare(context);
        assertEquals(BuildConfig.WEB_VERSION,WebUpdates.status(context).getLong("activeVersion"));
        assertEquals("",context.getSharedPreferences("CapWebViewSettings",0).getString("serverBasePath",""));
    }
}
