package tv.subcult.tadooer;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

/**
 * The one activity of the Android shell (ADR 0049). Capacitor's
 * {@link BridgeActivity} owns the WebView; {@link TadooerShellPlugin} holds
 * the shell's rules. This class registers the plugin and handles Back.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(TadooerShellPlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher()
            .addCallback(
                this,
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        // Back walks the web app's own history. At its start
                        // the app goes to the background; the page is kept.
                        TadooerShellPlugin shell = shell();
                        if (shell == null || !shell.goBack()) moveTaskToBack(true);
                    }
                }
            );
    }

    private TadooerShellPlugin shell() {
        if (bridge == null) return null;
        PluginHandle handle = bridge.getPlugin(TadooerShellPlugin.NAME);
        return handle == null ? null : (TadooerShellPlugin) handle.getInstance();
    }
}
