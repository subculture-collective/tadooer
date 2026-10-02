package tv.subcult.tadooer;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Runs {@link ShellPolicy} over inputs from standard input, one call per
 * line, and prints one result per line. {@code apps/mobile/src/
 * android-policy.test.mjs} compiles this with a plain JDK and compares the
 * results with the shared JavaScript policy.
 *
 * A line is a function name and its arguments, tab-separated, each argument
 * base64-encoded UTF-8. A leading "-" marks a null argument.
 */
public final class PolicyCheck {

    private PolicyCheck() {}

    public static void main(String[] arguments) throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        StringBuilder output = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isEmpty()) continue;
            String[] fields = line.split("\t", -1);
            output.append(call(fields)).append('\n');
        }
        System.out.print(output);
    }

    private static String argument(String[] fields, int index) {
        String field = fields[index];
        if (field.equals("-")) return null;
        return new String(Base64.getDecoder().decode(field), StandardCharsets.UTF_8);
    }

    private static String call(String[] fields) {
        switch (fields[0]) {
            case "classifyOrigin":
                return String.valueOf(ShellPolicy.classifyOrigin(argument(fields, 1), "true".equals(fields[2])));
            case "sameOrigin":
                return String.valueOf(ShellPolicy.sameOrigin(argument(fields, 1), argument(fields, 2)));
            case "deepLinkTarget":
                return String.valueOf(ShellPolicy.deepLinkTarget(argument(fields, 1), argument(fields, 2)));
            case "allowedExternalOAuth":
                return String.valueOf(ShellPolicy.allowedExternalOAuth(argument(fields, 1)));
            default:
                throw new IllegalArgumentException("Unknown function " + fields[0]);
        }
    }
}
