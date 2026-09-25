#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include "http.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static wchar_t *utf8_to_wide(const char *s) {
    if (!s) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    wchar_t *w = (wchar_t *)malloc(sizeof(wchar_t) * (size_t)n);
    MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
    return w;
}

static char *make_error(const char *stage, DWORD code) {
    char buf[256];
    snprintf(buf, sizeof(buf), "%s failed (Win32 error %lu)", stage, (unsigned long)code);
    char *out = (char *)malloc(strlen(buf) + 1);
    strcpy(out, buf);
    return out;
}

HttpResponse http_request(const char *method, const char *baseUrl, const char *path,
                           const char *bearerToken, const char *jsonBody) {
    HttpResponse resp;
    resp.transportOk = 0;
    resp.statusCode = 0;
    resp.body = NULL;
    resp.errorText = NULL;

    size_t fullLen = strlen(baseUrl) + strlen(path) + 1;
    char *fullUrl = (char *)malloc(fullLen);
    snprintf(fullUrl, fullLen, "%s%s", baseUrl, path);

    wchar_t *wUrl = utf8_to_wide(fullUrl);
    free(fullUrl);

    URL_COMPONENTS uc;
    ZeroMemory(&uc, sizeof(uc));
    uc.dwStructSize = sizeof(uc);
    wchar_t hostName[256];
    wchar_t urlPath[2048];
    wchar_t extraInfo[2048];
    uc.lpszHostName = hostName;
    uc.dwHostNameLength = 256;
    uc.lpszUrlPath = urlPath;
    uc.dwUrlPathLength = 2048;
    uc.lpszExtraInfo = extraInfo;
    uc.dwExtraInfoLength = 2048;

    if (!WinHttpCrackUrl(wUrl, 0, 0, &uc)) {
        resp.errorText = make_error("WinHttpCrackUrl", GetLastError());
        free(wUrl);
        return resp;
    }
    free(wUrl);

    int isHttps = (uc.nScheme == INTERNET_SCHEME_HTTPS);

    HINTERNET hSession = WinHttpOpen(L"InayaODBC/1.0",
                                      WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                      WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) {
        resp.errorText = make_error("WinHttpOpen", GetLastError());
        return resp;
    }

    /* This driver only ever talks to a single, org-configured Inaya host --
     * default WinHTTP timeouts (no explicit call) are fine for a first
     * real cut; a production build would expose SQLSetConnectAttr-driven
     * timeouts here the way the JDBC driver exposes setQueryTimeout(). */

    HINTERNET hConnect = WinHttpConnect(hSession, hostName, uc.nPort, 0);
    if (!hConnect) {
        resp.errorText = make_error("WinHttpConnect", GetLastError());
        WinHttpCloseHandle(hSession);
        return resp;
    }

    wchar_t pathAndQuery[4096];
    _snwprintf(pathAndQuery, 4096, L"%s%s", urlPath, extraInfo);

    wchar_t *wMethod = utf8_to_wide(method);
    DWORD flags = isHttps ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET hRequest = WinHttpOpenRequest(hConnect, wMethod, pathAndQuery, NULL,
                                             WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    free(wMethod);
    if (!hRequest) {
        resp.errorText = make_error("WinHttpOpenRequest", GetLastError());
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return resp;
    }

    if (bearerToken && *bearerToken) {
        char headerBuf[1024];
        snprintf(headerBuf, sizeof(headerBuf), "Authorization: Bearer %s", bearerToken);
        wchar_t *wHeader = utf8_to_wide(headerBuf);
        WinHttpAddRequestHeaders(hRequest, wHeader, (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);
        free(wHeader);
    }
    if (jsonBody) {
        WinHttpAddRequestHeaders(hRequest, L"Content-Type: application/json", (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);
    }

    DWORD bodyLen = jsonBody ? (DWORD)strlen(jsonBody) : 0;
    BOOL sent = WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                    jsonBody ? (LPVOID)jsonBody : WINHTTP_NO_REQUEST_DATA,
                                    bodyLen, bodyLen, 0);
    if (!sent) {
        resp.errorText = make_error("WinHttpSendRequest", GetLastError());
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return resp;
    }

    if (!WinHttpReceiveResponse(hRequest, NULL)) {
        resp.errorText = make_error("WinHttpReceiveResponse", GetLastError());
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return resp;
    }

    DWORD statusCode = 0;
    DWORD statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                         WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);

    char *bodyBuf = NULL;
    size_t bodyCap = 0;
    size_t bodyLenAccum = 0;
    for (;;) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(hRequest, &available)) break;
        if (available == 0) break;
        if (bodyLenAccum + available + 1 > bodyCap) {
            bodyCap = (bodyLenAccum + available + 1) * 2;
            bodyBuf = (char *)realloc(bodyBuf, bodyCap);
        }
        DWORD read = 0;
        if (!WinHttpReadData(hRequest, bodyBuf + bodyLenAccum, available, &read)) break;
        if (read == 0) break;
        bodyLenAccum += read;
    }
    if (bodyBuf) bodyBuf[bodyLenAccum] = 0;
    else { bodyBuf = (char *)malloc(1); bodyBuf[0] = 0; }

    resp.transportOk = 1;
    resp.statusCode = (long)statusCode;
    resp.body = bodyBuf;

    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return resp;
}

void http_response_free(HttpResponse *r) {
    if (!r) return;
    free(r->body);
    free(r->errorText);
    r->body = NULL;
    r->errorText = NULL;
}
