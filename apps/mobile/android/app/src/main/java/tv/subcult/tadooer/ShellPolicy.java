package tv.subcult.tadooer;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;

/**
 * Authority rules of the Android shell (ADR 0049), for the places where no
 * JavaScript runs: reading the stored server on start, the navigation guard,
 * deep links and the system-browser exception for Google OAuth.
 *
 * The rules are those of {@code apps/desktop/src/policy.mjs}, which the setup
 * page uses through {@code @suite/shell-policy}. This class is a second,
 * stricter reading of them: it accepts only text that is already in the
 * canonical form the JavaScript produces, and refuses everything else. The
 * test {@code apps/mobile/src/android-policy.test.mjs} runs both over the
 * same inputs and fails when this class accepts something the JavaScript
 * refuses or returns a different result.
 *
 * No Android import: the class compiles and runs on a plain JDK.
 */
public final class ShellPolicy {

    public static final String DEEP_LINK_PREFIX = "tadooer://open";
    public static final String HTTPS = "https";
    public static final String LOOPBACK_HTTP = "loopback-http";
    public static final String PRIVATE_LAN_HTTP = "private-lan-http";

    /** Capacitor serves the bundled setup page from this host name. */
    static final String RESERVED_HOST = "localhost";

    private static final int MAXIMUM_URL_LENGTH = 2048;
    private static final int MAXIMUM_PATH_LENGTH = 1024;
    private static final int MAXIMUM_OAUTH_LENGTH = 4096;
    private static final String OAUTH_PREFIX = "https://accounts.google.com/o/oauth2/v2/auth?";

    private ShellPolicy() {}

    /**
     * The transport of a canonical origin, or null when the origin is not
     * accepted. Canonical means exactly what {@code URL.origin} returns:
     * lower case, no default port, no trailing slash.
     *
     * Unlike the desktop shell, the host name {@code localhost} is refused
     * (it is the setup page's own host) and the only IPv6 literal accepted is
     * the loopback address.
     */
    public static String classifyOrigin(String origin, boolean allowPrivateLanHttp) {
        if (origin == null || origin.length() > MAXIMUM_URL_LENGTH) return null;
        boolean secure;
        String rest;
        if (origin.startsWith("https://")) {
            secure = true;
            rest = origin.substring(8);
        } else if (origin.startsWith("http://")) {
            secure = false;
            rest = origin.substring(7);
        } else {
            return null;
        }
        String host;
        String port = null;
        if (rest.startsWith("[")) {
            int close = rest.indexOf(']');
            if (close < 0) return null;
            host = rest.substring(0, close + 1);
            String after = rest.substring(close + 1);
            if (!after.isEmpty()) {
                if (!after.startsWith(":")) return null;
                port = after.substring(1);
            }
        } else {
            int colon = rest.indexOf(':');
            host = colon < 0 ? rest : rest.substring(0, colon);
            if (colon >= 0) port = rest.substring(colon + 1);
        }
        if (port != null && !canonicalPort(port, secure)) return null;
        boolean loopbackV6 = host.equals("[::1]");
        int[] v4 = loopbackV6 ? null : ipv4(host);
        if (!loopbackV6 && v4 == null && !hostName(host)) return null;
        if (host.equals(RESERVED_HOST)) return null;
        if (secure) return HTTPS;
        if (loopbackV6 || host.equals("127.0.0.1")) return LOOPBACK_HTTP;
        if (v4 == null || !privateLan(v4)) return null;
        return allowPrivateLanHttp ? PRIVATE_LAN_HTTP : null;
    }

    /** The host of an origin that {@link #classifyOrigin} accepted. */
    public static String originHost(String origin) {
        String rest = origin.substring(origin.indexOf("://") + 3);
        if (rest.startsWith("[")) return rest.substring(0, rest.indexOf(']') + 1);
        int colon = rest.indexOf(':');
        return colon < 0 ? rest : rest.substring(0, colon);
    }

    /**
     * True when {@code url} is on {@code origin}. The WebView reports URLs in
     * canonical form, so the origin is followed by the path, a query, a
     * fragment or nothing.
     */
    public static boolean sameOrigin(String url, String origin) {
        if (url == null || origin == null || origin.isEmpty()) return false;
        if (!url.startsWith(origin)) return false;
        if (url.length() == origin.length()) return true;
        char next = url.charAt(origin.length());
        return next == '/' || next == '?' || next == '#';
    }

    /**
     * {@code tadooer://open/<path>} to an absolute URL on the configured
     * origin, or null. The link carries a path, a query and a fragment only.
     * Paths under {@code /api}, dot segments, encoded separators and every
     * character a URL parser would rewrite are refused.
     */
    public static String deepLinkTarget(String raw, String origin) {
        if (raw == null || origin == null || raw.length() > MAXIMUM_URL_LENGTH) return null;
        if (raw.length() < DEEP_LINK_PREFIX.length()) return null;
        String scheme = raw.substring(0, 7);
        if (!scheme.equalsIgnoreCase("tadooer")) return null;
        if (!raw.startsWith("://open", 7)) return null;
        String rest = raw.substring(DEEP_LINK_PREFIX.length());
        for (int index = 0; index < rest.length(); index++) {
            if (!linkCharacter(rest.charAt(index))) return null;
        }
        if (!rest.isEmpty() && "/?#".indexOf(rest.charAt(0)) < 0) return null;
        String fragment = "";
        int hash = rest.indexOf('#');
        if (hash >= 0) {
            fragment = rest.substring(hash + 1);
            rest = rest.substring(0, hash);
        }
        String query = "";
        int question = rest.indexOf('?');
        if (question >= 0) {
            query = rest.substring(question + 1);
            rest = rest.substring(0, question);
        }
        String path = rest.isEmpty() ? "/" : rest;
        String relative = path + (query.isEmpty() ? "" : "?" + query) + (fragment.isEmpty() ? "" : "#" + fragment);
        if (relative.length() > MAXIMUM_PATH_LENGTH) return null;
        if (path.startsWith("//")) return null;
        String lowered = path.toLowerCase(java.util.Locale.ROOT);
        if (lowered.equals("/api") || lowered.startsWith("/api/")) return null;
        if (lowered.contains("%2f") || lowered.contains("%5c") || lowered.contains("%2e")) return null;
        for (String segment : path.split("/", -1)) {
            if (segment.equals(".") || segment.equals("..")) return null;
        }
        return origin + relative;
    }

    /**
     * The one address the shell hands to the system browser: Google's OAuth
     * consent page with an authorization-code request.
     */
    public static boolean allowedExternalOAuth(String url) {
        if (url == null || url.length() > MAXIMUM_OAUTH_LENGTH || !url.startsWith(OAUTH_PREFIX)) return false;
        String query = url.substring(OAUTH_PREFIX.length());
        int hash = query.indexOf('#');
        if (hash >= 0) query = query.substring(0, hash);
        String responseType = null;
        String clientId = null;
        String redirectUri = null;
        String state = null;
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            String name;
            String value;
            try {
                // The two-argument form with a charset name exists on every
                // Android version; the Charset overload needs API 33.
                name = URLDecoder.decode(equals < 0 ? pair : pair.substring(0, equals), "UTF-8");
                value = equals < 0 ? "" : URLDecoder.decode(pair.substring(equals + 1), "UTF-8");
            } catch (IllegalArgumentException | UnsupportedEncodingException malformed) {
                return false;
            }
            // The first value of a repeated name counts, as in URLSearchParams.get.
            if (name.equals("response_type") && responseType == null) responseType = value;
            else if (name.equals("client_id") && clientId == null) clientId = value;
            else if (name.equals("redirect_uri") && redirectUri == null) redirectUri = value;
            else if (name.equals("state") && state == null) state = value;
        }
        return (
            "code".equals(responseType) &&
            clientId != null &&
            clientId.length() > 4 &&
            redirectUri != null &&
            !redirectUri.isEmpty() &&
            state != null &&
            state.length() >= 32
        );
    }

    private static boolean linkCharacter(char character) {
        if (character >= 'a' && character <= 'z') return true;
        if (character >= 'A' && character <= 'Z') return true;
        if (character >= '0' && character <= '9') return true;
        return "-._~!$&()*+,;=:@/%?#".indexOf(character) >= 0;
    }

    private static boolean canonicalPort(String port, boolean secure) {
        if (port.isEmpty() || port.length() > 5 || port.charAt(0) == '0') return false;
        for (int index = 0; index < port.length(); index++) {
            char digit = port.charAt(index);
            if (digit < '0' || digit > '9') return false;
        }
        int value = Integer.parseInt(port);
        return value <= 65535 && value != (secure ? 443 : 80);
    }

    /** Four canonical decimal parts, or null. */
    private static int[] ipv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return null;
        int[] values = new int[4];
        for (int index = 0; index < 4; index++) {
            String part = parts[index];
            if (part.isEmpty() || part.length() > 3) return null;
            if (part.length() > 1 && part.charAt(0) == '0') return null;
            for (int position = 0; position < part.length(); position++) {
                char digit = part.charAt(position);
                if (digit < '0' || digit > '9') return null;
            }
            values[index] = Integer.parseInt(part);
            if (values[index] > 255) return null;
        }
        return values;
    }

    private static boolean privateLan(int[] v4) {
        return (
            v4[0] == 10 ||
            (v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31) ||
            (v4[0] == 192 && v4[1] == 168) ||
            (v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127)
        );
    }

    /**
     * A lower-case DNS name. A name whose last label starts with a digit is
     * refused: a URL parser reads such a host as an IPv4 address, and those
     * are handled by {@link #ipv4}.
     */
    private static boolean hostName(String host) {
        if (host.isEmpty() || host.length() > 253) return false;
        String[] labels = host.split("\\.", -1);
        for (String label : labels) {
            if (label.isEmpty() || label.length() > 63) return false;
            if (label.charAt(0) == '-' || label.charAt(label.length() - 1) == '-') return false;
            for (int index = 0; index < label.length(); index++) {
                char character = label.charAt(index);
                boolean letter = character >= 'a' && character <= 'z';
                boolean digit = character >= '0' && character <= '9';
                if (!letter && !digit && character != '-') return false;
            }
        }
        char first = labels[labels.length - 1].charAt(0);
        return first < '0' || first > '9';
    }
}
