package tv.subcult.tadooer;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * What the shell stores (ADR 0049): the server origin and whether the owner
 * accepted plaintext HTTP for a private address. Two values in app-private
 * preferences. No session, credential, task or cached owner data: those stay
 * in the web app's own storage inside the WebView.
 */
final class ShellStore {

    private static final String FILE = "tadooer-shell";
    private static final String ORIGIN = "serverOrigin";
    private static final String ALLOW_PRIVATE_LAN_HTTP = "allowPrivateLanHttp";

    private final SharedPreferences preferences;

    ShellStore(Context context) {
        preferences = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** The stored origin, checked again with the policy that accepted it, or null. */
    String origin() {
        String origin;
        boolean allow;
        try {
            origin = preferences.getString(ORIGIN, null);
            allow = preferences.getBoolean(ALLOW_PRIVATE_LAN_HTTP, false);
        } catch (ClassCastException damaged) {
            return null;
        }
        return origin != null && ShellPolicy.classifyOrigin(origin, allow) != null ? origin : null;
    }

    void write(String origin, boolean allowPrivateLanHttp) {
        preferences.edit().putString(ORIGIN, origin).putBoolean(ALLOW_PRIVATE_LAN_HTTP, allowPrivateLanHttp).apply();
    }
}
