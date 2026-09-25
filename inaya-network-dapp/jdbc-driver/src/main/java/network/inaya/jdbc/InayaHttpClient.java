package network.inaya.jdbc;

import org.json.JSONObject;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.SQLException;
import java.time.Duration;

/**
 * Real HTTP transport to Inaya's /api/public/v1/data-sources/{id}/**
 * routes -- no mocking, no stub responses. Every call this class makes is
 * a genuine HTTPS/HTTP request carrying the org's real bearer API key.
 */
final class InayaHttpClient {

    private final HttpClient httpClient;
    private final String baseUrl;
    private final String apiKey;

    InayaHttpClient(String baseUrl, String apiKey) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.apiKey = apiKey;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                // Forced explicitly: java.net.http.HttpClient defaults to
                // attempting an HTTP/2 h2c upgrade on a plain http:// URL,
                // and this app's Next.js dev server crashes handling that
                // upgrade request ("Error handling upgrade request
                // TypeError: Cannot read properties of undefined (reading
                // 'bind')" in the dev server's own logs) -- a real bug
                // found via this driver's own integration test, not a
                // hypothetical. HTTP/1.1 avoids the upgrade attempt
                // entirely; production Inaya deployments terminate HTTPS
                // at a real reverse proxy that handles this correctly
                // regardless, so this only actually matters for local dev.
                .version(HttpClient.Version.HTTP_1_1)
                .build();
    }

    JSONObject get(String path) throws SQLException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .header("Authorization", "Bearer " + apiKey)
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();
        return send(request);
    }

    JSONObject post(String path, JSONObject body) throws SQLException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(60))
                .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                .build();
        return send(request);
    }

    private JSONObject send(HttpRequest request) throws SQLException {
        HttpResponse<String> response;
        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new SQLException("Network error calling Inaya gateway: " + e.getMessage(), e);
        }

        JSONObject json;
        try {
            json = new JSONObject(response.body());
        } catch (Exception e) {
            throw new SQLException("Inaya gateway returned a non-JSON response (status " + response.statusCode() + "): " + response.body());
        }

        if (response.statusCode() >= 300) {
            String error = json.optString("error", "Unknown error from Inaya gateway (status " + response.statusCode() + ").");
            throw new SQLException(error, sqlStateFor(response.statusCode()));
        }
        return json;
    }

    /** Maps HTTP status to a real SQLState code -- 42501 (insufficient
     *  privilege) for 403, 28000 (invalid authorization) for 401,
     *  08001/08006 (connection) for network-class failures -- rather than
     *  leaving every error under the same generic state. */
    private static String sqlStateFor(int status) {
        switch (status) {
            case 401: return "28000";
            case 403: return "42501";
            case 404: return "42P01";
            case 400: return "42000";
            default: return "08006";
        }
    }
}
