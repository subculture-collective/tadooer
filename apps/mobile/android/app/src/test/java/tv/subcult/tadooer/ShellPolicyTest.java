package tv.subcult.tadooer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Fixed cases for {@link ShellPolicy}, run by {@code ./gradlew
 * testDebugUnitTest}. The wider comparison with the JavaScript policy is
 * {@code apps/mobile/src/android-policy.test.mjs}.
 */
public class ShellPolicyTest {

    private static final String ORIGIN = "https://tasks.example.org";

    @Test
    public void acceptsCanonicalOrigins() {
        assertEquals(ShellPolicy.HTTPS, ShellPolicy.classifyOrigin(ORIGIN, false));
        assertEquals(ShellPolicy.HTTPS, ShellPolicy.classifyOrigin("https://tasks.example.org:8443", false));
        assertEquals(ShellPolicy.HTTPS, ShellPolicy.classifyOrigin("https://10.0.0.50", false));
        assertEquals(ShellPolicy.LOOPBACK_HTTP, ShellPolicy.classifyOrigin("http://127.0.0.1:8080", false));
        assertEquals(ShellPolicy.LOOPBACK_HTTP, ShellPolicy.classifyOrigin("http://[::1]:8080", false));
        assertEquals(ShellPolicy.PRIVATE_LAN_HTTP, ShellPolicy.classifyOrigin("http://10.0.0.50:8080", true));
        assertEquals(ShellPolicy.PRIVATE_LAN_HTTP, ShellPolicy.classifyOrigin("http://100.65.164.66", true));
    }

    @Test
    public void refusesEverythingElse() {
        String[] refused = {
            null,
            "",
            "tasks.example.org",
            "https://tasks.example.org/",
            "https://tasks.example.org/path",
            "https://Tasks.example.org",
            "https://user@tasks.example.org",
            "https://tasks.example.org:443",
            "https://tasks.example.org:0",
            "https://tasks.example.org:08443",
            "https://localhost",
            "http://localhost:8080",
            "http://tasks.example.org",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://100.128.0.1",
            "http://010.0.0.1",
            "http://[fd00::1]",
            "ftp://tasks.example.org",
            "https://exa mple.org",
            "https://example.org#x"
        };
        for (String origin : refused) assertNull(origin, ShellPolicy.classifyOrigin(origin, true));
        assertNull(ShellPolicy.classifyOrigin("http://10.0.0.50:8080", false));
    }

    @Test
    public void comparesOrigins() {
        assertTrue(ShellPolicy.sameOrigin("https://tasks.example.org/today", ORIGIN));
        assertTrue(ShellPolicy.sameOrigin("https://tasks.example.org", ORIGIN));
        assertTrue(ShellPolicy.sameOrigin("https://tasks.example.org/?a=1#b", ORIGIN));
        assertFalse(ShellPolicy.sameOrigin("https://tasks.example.org.evil.example/", ORIGIN));
        assertFalse(ShellPolicy.sameOrigin("https://tasks.example.org:8443/", ORIGIN));
        assertFalse(ShellPolicy.sameOrigin("https://tasks.example.org@evil.example/", ORIGIN));
        assertFalse(ShellPolicy.sameOrigin("http://tasks.example.org/", ORIGIN));
        assertFalse(ShellPolicy.sameOrigin(null, ORIGIN));
        assertFalse(ShellPolicy.sameOrigin("https://tasks.example.org/", null));
    }

    @Test
    public void resolvesDeepLinks() {
        assertEquals(ORIGIN + "/today", ShellPolicy.deepLinkTarget("tadooer://open/today", ORIGIN));
        assertEquals(ORIGIN + "/", ShellPolicy.deepLinkTarget("tadooer://open", ORIGIN));
        assertEquals(ORIGIN + "/tasks?view=inbox#top", ShellPolicy.deepLinkTarget("TADOOER://open/tasks?view=inbox#top", ORIGIN));
        String[] refused = {
            null,
            "tadooer://evil.example/today",
            "tadooer://open.evil.example/today",
            "tadooer://open//evil.example/x",
            "tadooer://open/api",
            "tadooer://open/API/data/export",
            "tadooer://open/a/../api/build",
            "tadooer://open/%2e%2e/api/build",
            "tadooer://open/a%2fb",
            "tadooer://user@open/today",
            "tadooer://open:81/today",
            "tadooer://open/a\\b",
            "tadooer://open/a b",
            "https://tasks.example.org/today"
        };
        for (String link : refused) assertNull(link, ShellPolicy.deepLinkTarget(link, ORIGIN));
    }

    @Test
    public void allowsOnlyGoogleAuthorizationCodeRequests() {
        String state = "0123456789abcdef0123456789abcdef";
        String valid =
            "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abcde.apps&redirect_uri=https%3A%2F%2Ftasks.example.org%2Fapi%2Fconnectors%2Fgoogle%2Fcallback&state=" +
            state;
        assertTrue(ShellPolicy.allowedExternalOAuth(valid));
        assertFalse(ShellPolicy.allowedExternalOAuth(valid.replace("response_type=code", "response_type=token")));
        assertFalse(ShellPolicy.allowedExternalOAuth(valid.replace(state, "short")));
        assertFalse(ShellPolicy.allowedExternalOAuth(valid.replace("accounts.google.com", "accounts.google.com.evil.example")));
        assertFalse(ShellPolicy.allowedExternalOAuth(valid.replace("https://", "http://")));
        assertFalse(ShellPolicy.allowedExternalOAuth("https://accounts.google.com/o/oauth2/v2/auth"));
        assertFalse(ShellPolicy.allowedExternalOAuth(null));
    }
}
