#ifndef INAYA_HTTP_H
#define INAYA_HTTP_H

typedef struct {
    int transportOk;   /* 0 if the request never reached the server (DNS/connect/TLS failure) */
    long statusCode;   /* HTTP status code, valid only if transportOk */
    char *body;        /* malloc'd, NUL-terminated response body, or NULL */
    char *errorText;   /* malloc'd human-readable transport error, or NULL */
} HttpResponse;

/* baseUrl: e.g. "http://localhost:3000" or "https://app.inaya.network".
 * path: e.g. "/api/public/v1/data-sources/<id>/query".
 * bearerToken: sent as "Authorization: Bearer <token>"; NULL to omit.
 * jsonBody: NULL for GET; a JSON request body for POST. */
HttpResponse http_request(const char *method, const char *baseUrl, const char *path,
                           const char *bearerToken, const char *jsonBody);

void http_response_free(HttpResponse *r);

#endif
