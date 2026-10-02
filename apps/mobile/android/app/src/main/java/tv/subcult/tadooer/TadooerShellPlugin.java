package tv.subcult.tadooer;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.security.NetworkSecurityPolicy;
import android.webkit.WebBackForwardList;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.CookieHandler;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The Android shell's rules (ADR 0049).
 *
 * The WebView shows two things. The bundled setup page lives on Capacitor's
 * local origin and may call the four methods below. The owner's Suite origin
 * is not in Capacitor's allow list, so it gets no Capacitor bridge and no
 * plugin; it gets one origin-bound message channel that carries the word
 * "ready" one way and shared text the other way.
 *
 * Navigation leaves the configured origin only for Google's OAuth consent
 * page, which opens in the system browser. Everything else is refused.
 */
@CapacitorPlugin(name = TadooerShellPlugin.NAME)
public class TadooerShellPlugin extends Plugin {

    static final String NAME = "TadooerShell";
    static final String ACTION_CHANGE_SERVER = "tv.subcult.tadooer.action.CHANGE_SERVER";

    private static final String NATIVE_CHANNEL = "tadooerShellNative";
    private static final String READY_MESSAGE = "ready";
    private static final String BRIDGE_ASSET = "public/page-bridge.js";
    private static final int SHARE_FIELD_LIMIT = 8192;
    private static final long SHARE_LIFETIME_MS = 10 * 60 * 1000;
    private static final long CONNECT_DELAY_MS = 400;
    private static final int FOREIGN_PAGE_LIMIT = 3;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private ShellStore store;
    private String origin;
    private boolean webViewSupported;
    private boolean started;
    private boolean setupRequested;
    private boolean clearHistoryOnLoad;
    private int foreignPages;

    private ScriptHandler bridgeScript;
    private boolean channelInstalled;
    private JavaScriptReplyProxy pageChannel;
    private String pendingShare;
    private long pendingShareAt;

    @Override
    public void load() {
        WebView webView = bridge.getWebView();
        // Capacitor's cookie and HTTP plugins each add a JavaScript interface
        // that every origin and frame could call, and install a process-wide
        // cookie handler that would attach the WebView's cookies to native
        // requests. The shell uses neither; both are removed before any page
        // loads.
        webView.removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        webView.removeJavascriptInterface("CapacitorHttpAndroidInterface");
        CookieHandler.setDefault(null);

        // Without these two WebView features Capacitor falls back to a bridge
        // object that is visible to every origin. The shell then stays on the
        // setup page and never opens a server.
        webViewSupported =
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);

        store = new ShellStore(getContext());
        origin = store.origin();
        installPageBridge();

        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageStarted(WebView view) {
                    // A new document: the previous page's channel is gone.
                    pageChannel = null;
                }

                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    guardPage(view, url);
                }

                @Override
                public void onPageLoaded(WebView view) {
                    if (guardPage(view, view.getUrl())) return;
                    if (origin == null || !ShellPolicy.sameOrigin(view.getUrl(), origin)) return;
                    foreignPages = 0;
                    if (clearHistoryOnLoad) {
                        // Back must not return to the setup page.
                        clearHistoryOnLoad = false;
                        view.clearHistory();
                    }
                }
            }
        );
    }

    // --- Setup page calls ---------------------------------------------------

    @PluginMethod
    public void state(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            if (!fromSetupPage()) {
                call.reject("Forbidden");
                return;
            }
            JSObject result = new JSObject();
            result.put("currentOrigin", origin == null ? JSONObject.NULL : origin);
            // The setup page is open although a server is stored and nobody
            // asked to change it: the server did not load.
            result.put("unreachable", origin != null && !setupRequested);
            result.put("webViewSupported", webViewSupported);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void cleartextPermitted(PluginCall call) {
        String host = call.getString("host");
        JSObject result = new JSObject();
        result.put("permitted", host != null && cleartextPermitted(host));
        call.resolve(result);
    }

    @PluginMethod
    public void setServer(PluginCall call) {
        String requested = call.getString("origin");
        boolean allowPrivateLanHttp = Boolean.TRUE.equals(call.getBoolean("allowPrivateLanHttp", false));
        bridge.executeOnMainThread(() -> {
            if (!fromSetupPage()) {
                call.reject("Forbidden");
                return;
            }
            if (!webViewSupported) {
                call.reject("The system WebView is too old", "webview-outdated");
                return;
            }
            String transport = ShellPolicy.classifyOrigin(requested, allowPrivateLanHttp);
            if (transport == null) {
                call.reject("The address was refused", "refused");
                return;
            }
            if (!ShellPolicy.HTTPS.equals(transport) && !cleartextPermitted(ShellPolicy.originHost(requested))) {
                call.reject("Plaintext HTTP is not allowed for this address", "cleartext-build");
                return;
            }
            store.write(requested, ShellPolicy.PRIVATE_LAN_HTTP.equals(transport));
            origin = requested;
            setupRequested = false;
            installPageBridge();
            call.resolve();
            // The page shows "Connected" before the server replaces it.
            mainHandler.postDelayed(() -> openServer(origin + "/"), CONNECT_DELAY_MS);
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            if (!fromSetupPage()) {
                call.reject("Forbidden");
                return;
            }
            // Without a configured server there is nothing to go back to.
            if (origin != null && webViewSupported) {
                setupRequested = false;
                openServer(origin + "/");
            }
            call.resolve();
        });
    }

    // --- Intents ------------------------------------------------------------

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        boolean first = !started;
        started = true;
        String action = intent == null ? null : intent.getAction();
        // An intent replayed from the recents list is only a launch; its link
        // or shared text was handled when it first arrived.
        boolean replayed = intent != null && (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;

        if (!replayed && ACTION_CHANGE_SERVER.equals(action)) {
            setupRequested = true;
            bridge.getWebView().loadUrl(bridge.getAppUrl());
            return;
        }
        // No server yet, or a WebView the shell cannot use safely: the setup
        // page that Capacitor loaded stays.
        if (origin == null || !webViewSupported) return;

        String target = null;
        if (!replayed && Intent.ACTION_VIEW.equals(action)) {
            target = ShellPolicy.deepLinkTarget(intent.getDataString(), origin);
        } else if (!replayed && Intent.ACTION_SEND.equals(action) && "text/plain".equals(intent.getType())) {
            holdShare(intent);
        }

        if (target != null) {
            setupRequested = false;
            openServer(target);
        } else if (first) {
            openServer(origin + "/");
        } else {
            deliverShare();
        }
    }

    // --- Navigation ---------------------------------------------------------

    /**
     * Capacitor asks every plugin before the WebView follows a link or a
     * redirect. Returning false loads the URL in the WebView, true drops it,
     * null leaves the decision to Capacitor (its own local origin).
     */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String target = url == null ? null : url.toString();
        if (target == null) return true;
        if (isLocal(target)) return null;
        if (origin != null && webViewSupported && ShellPolicy.sameOrigin(target, origin)) return false;
        if (ShellPolicy.allowedExternalOAuth(target)) openInBrowser(url);
        return true;
    }

    /**
     * Second check, for loads that never pass through shouldOverrideLoad (a
     * form post, for one). A main-frame document that is neither the setup
     * page nor the configured origin is left at once. Such a page never has
     * the bridge: the channel and the script are bound to the origin.
     * Returns true when the page was foreign.
     */
    private boolean guardPage(WebView view, String url) {
        if (url == null || isLocal(url)) return false;
        if (origin != null && webViewSupported && ShellPolicy.sameOrigin(url, origin)) return false;
        view.stopLoading();
        foreignPages++;
        if (origin != null && webViewSupported && !setupRequested && foreignPages < FOREIGN_PAGE_LIMIT) {
            view.loadUrl(origin + "/");
        } else {
            view.loadUrl(bridge.getAppUrl());
        }
        return true;
    }

    /** Back inside the web app's history. False when Back should leave the app. */
    boolean goBack() {
        WebView view = bridge.getWebView();
        if (origin == null || !view.canGoBack()) return false;
        if (!ShellPolicy.sameOrigin(view.getUrl(), origin)) return false;
        WebBackForwardList history = view.copyBackForwardList();
        int index = history.getCurrentIndex();
        if (index <= 0) return false;
        if (!ShellPolicy.sameOrigin(history.getItemAtIndex(index - 1).getUrl(), origin)) return false;
        view.goBack();
        return true;
    }

    private void openServer(String url) {
        clearHistoryOnLoad = true;
        bridge.getWebView().loadUrl(url);
    }

    private void openInBrowser(Uri url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, url);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            getActivity().startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException noBrowser) {
            // No browser to hand the page to; the link does nothing.
        }
    }

    private boolean isLocal(String url) {
        String local = bridge.getScheme() + "://" + bridge.getHost();
        return ShellPolicy.sameOrigin(url, local);
    }

    private boolean fromSetupPage() {
        String url = bridge.getWebView().getUrl();
        return url != null && isLocal(url);
    }

    private boolean cleartextPermitted(String host) {
        String bare = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        return NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted(bare);
    }

    // --- The page bridge ----------------------------------------------------

    /**
     * Binds the message channel and the injected script to the configured
     * origin. Called on start and whenever the server changes; the previous
     * origin loses both.
     */
    private void installPageBridge() {
        WebView webView = bridge.getWebView();
        if (bridgeScript != null) {
            bridgeScript.remove();
            bridgeScript = null;
        }
        if (channelInstalled) {
            WebViewCompat.removeWebMessageListener(webView, NATIVE_CHANNEL);
            channelInstalled = false;
        }
        pageChannel = null;
        if (origin == null || !webViewSupported) return;
        String script = readAsset(BRIDGE_ASSET);
        if (script == null) return;
        Set<String> rules = Collections.singleton(origin);
        try {
            WebViewCompat.addWebMessageListener(
                webView,
                NATIVE_CHANNEL,
                rules,
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (!isMainFrame || !READY_MESSAGE.equals(message.getData())) return;
                    if (origin == null || !ShellPolicy.sameOrigin(view.getUrl(), origin)) return;
                    pageChannel = replyProxy;
                    deliverShare();
                }
            );
            channelInstalled = true;
            bridgeScript = WebViewCompat.addDocumentStartJavaScript(webView, script, rules);
        } catch (IllegalArgumentException refusedRule) {
            // The WebView did not accept the origin as a rule. The page loads
            // without the bridge and behaves as it does in a browser.
        }
    }

    /** Keeps shared text in memory until the page says it is ready. */
    private void holdShare(Intent intent) {
        try {
            JSONObject share = new JSONObject();
            share.put("type", "share");
            share.put("subject", bounded(intent.getStringExtra(Intent.EXTRA_SUBJECT)));
            share.put("text", bounded(intent.getStringExtra(Intent.EXTRA_TEXT)));
            pendingShare = share.toString();
            pendingShareAt = SystemClock.elapsedRealtime();
        } catch (JSONException impossible) {
            pendingShare = null;
        }
    }

    private void deliverShare() {
        if (pendingShare == null) return;
        if (SystemClock.elapsedRealtime() - pendingShareAt > SHARE_LIFETIME_MS) {
            pendingShare = null;
            return;
        }
        if (pageChannel == null) return;
        String share = pendingShare;
        pendingShare = null;
        pageChannel.postMessage(share);
    }

    private static String bounded(String value) {
        if (value == null) return "";
        return value.length() > SHARE_FIELD_LIMIT ? value.substring(0, SHARE_FIELD_LIMIT) : value;
    }

    private String readAsset(String name) {
        try (InputStream input = getContext().getAssets().open(name)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException missing) {
            return null;
        }
    }
}
