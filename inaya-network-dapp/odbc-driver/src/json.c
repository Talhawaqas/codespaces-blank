#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const char *text;
    size_t pos;
    size_t len;
} Parser;

static void skip_ws(Parser *p) {
    while (p->pos < p->len) {
        char c = p->text[p->pos];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') p->pos++;
        else break;
    }
}

static JsonValue *json_new(JsonType type) {
    JsonValue *v = (JsonValue *)calloc(1, sizeof(JsonValue));
    v->type = type;
    return v;
}

static char *dupstr(const char *s) {
    size_t n = strlen(s) + 1;
    char *out = (char *)malloc(n);
    memcpy(out, s, n);
    return out;
}

static void set_error(char **errorOut, const char *fmt, size_t pos) {
    if (!errorOut) return;
    char buf[128];
    snprintf(buf, sizeof(buf), fmt, (unsigned long)pos);
    *errorOut = dupstr(buf);
}

static JsonValue *parse_value(Parser *p, char **errorOut);

static int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Encodes a Unicode code point as UTF-8 into sb. Used only for \\uXXXX
 * escapes; surrogate pairs are combined before this is called. */
static void jsb_append_codepoint(JsonStringBuilder *sb, unsigned int cp) {
    char bytes[4];
    int n = 0;
    if (cp <= 0x7F) {
        bytes[0] = (char)cp;
        n = 1;
    } else if (cp <= 0x7FF) {
        bytes[0] = (char)(0xC0 | (cp >> 6));
        bytes[1] = (char)(0x80 | (cp & 0x3F));
        n = 2;
    } else if (cp <= 0xFFFF) {
        bytes[0] = (char)(0xE0 | (cp >> 12));
        bytes[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        bytes[2] = (char)(0x80 | (cp & 0x3F));
        n = 3;
    } else {
        bytes[0] = (char)(0xF0 | (cp >> 18));
        bytes[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
        bytes[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
        bytes[3] = (char)(0x80 | (cp & 0x3F));
        n = 4;
    }
    for (int i = 0; i < n; i++) {
        char one[2] = { bytes[i], 0 };
        jsb_append(sb, one);
    }
}

static char *parse_string_raw(Parser *p, char **errorOut) {
    if (p->text[p->pos] != '"') {
        set_error(errorOut, "expected '\"' at offset %lu", p->pos);
        return NULL;
    }
    p->pos++; /* opening quote */
    JsonStringBuilder sb;
    jsb_init(&sb);
    while (p->pos < p->len && p->text[p->pos] != '"') {
        char c = p->text[p->pos];
        if (c == '\\') {
            p->pos++;
            if (p->pos >= p->len) { jsb_free(&sb); set_error(errorOut, "unterminated escape at offset %lu", p->pos); return NULL; }
            char esc = p->text[p->pos];
            switch (esc) {
                case '"': jsb_append(&sb, "\""); p->pos++; break;
                case '\\': jsb_append(&sb, "\\"); p->pos++; break;
                case '/': jsb_append(&sb, "/"); p->pos++; break;
                case 'b': jsb_append(&sb, "\b"); p->pos++; break;
                case 'f': jsb_append(&sb, "\f"); p->pos++; break;
                case 'n': jsb_append(&sb, "\n"); p->pos++; break;
                case 'r': jsb_append(&sb, "\r"); p->pos++; break;
                case 't': jsb_append(&sb, "\t"); p->pos++; break;
                case 'u': {
                    p->pos++;
                    if (p->pos + 4 > p->len) { jsb_free(&sb); set_error(errorOut, "truncated \\u escape at offset %lu", p->pos); return NULL; }
                    unsigned int cp = 0;
                    for (int i = 0; i < 4; i++) {
                        int d = hex_digit(p->text[p->pos + i]);
                        if (d < 0) { jsb_free(&sb); set_error(errorOut, "bad hex digit at offset %lu", p->pos); return NULL; }
                        cp = (cp << 4) | (unsigned int)d;
                    }
                    p->pos += 4;
                    if (cp >= 0xD800 && cp <= 0xDBFF && p->pos + 6 <= p->len &&
                        p->text[p->pos] == '\\' && p->text[p->pos + 1] == 'u') {
                        unsigned int low = 0;
                        int ok = 1;
                        for (int i = 0; i < 4; i++) {
                            int d = hex_digit(p->text[p->pos + 2 + i]);
                            if (d < 0) { ok = 0; break; }
                            low = (low << 4) | (unsigned int)d;
                        }
                        if (ok && low >= 0xDC00 && low <= 0xDFFF) {
                            p->pos += 6;
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                        }
                    }
                    jsb_append_codepoint(&sb, cp);
                    break;
                }
                default:
                    jsb_free(&sb);
                    set_error(errorOut, "unknown escape at offset %lu", p->pos);
                    return NULL;
            }
        } else {
            char one[2] = { c, 0 };
            jsb_append(&sb, one);
            p->pos++;
        }
    }
    if (p->pos >= p->len) { jsb_free(&sb); set_error(errorOut, "unterminated string at offset %lu", p->pos); return NULL; }
    p->pos++; /* closing quote */
    return sb.data ? sb.data : dupstr("");
}

static JsonValue *parse_object(Parser *p, char **errorOut) {
    JsonValue *v = json_new(JSON_OBJECT);
    p->pos++; /* { */
    skip_ws(p);
    if (p->pos < p->len && p->text[p->pos] == '}') { p->pos++; return v; }
    while (1) {
        skip_ws(p);
        char *key = parse_string_raw(p, errorOut);
        if (!key) { json_free(v); return NULL; }
        skip_ws(p);
        if (p->pos >= p->len || p->text[p->pos] != ':') {
            free(key); json_free(v);
            set_error(errorOut, "expected ':' at offset %lu", p->pos);
            return NULL;
        }
        p->pos++;
        skip_ws(p);
        JsonValue *val = parse_value(p, errorOut);
        if (!val) { free(key); json_free(v); return NULL; }

        v->keys = (char **)realloc(v->keys, sizeof(char *) * (v->memberCount + 1));
        v->values = (JsonValue **)realloc(v->values, sizeof(JsonValue *) * (v->memberCount + 1));
        v->keys[v->memberCount] = key;
        v->values[v->memberCount] = val;
        v->memberCount++;

        skip_ws(p);
        if (p->pos < p->len && p->text[p->pos] == ',') { p->pos++; continue; }
        if (p->pos < p->len && p->text[p->pos] == '}') { p->pos++; break; }
        json_free(v);
        set_error(errorOut, "expected ',' or '}' at offset %lu", p->pos);
        return NULL;
    }
    return v;
}

static JsonValue *parse_array(Parser *p, char **errorOut) {
    JsonValue *v = json_new(JSON_ARRAY);
    p->pos++; /* [ */
    skip_ws(p);
    if (p->pos < p->len && p->text[p->pos] == ']') { p->pos++; return v; }
    while (1) {
        skip_ws(p);
        JsonValue *item = parse_value(p, errorOut);
        if (!item) { json_free(v); return NULL; }
        v->items = (JsonValue **)realloc(v->items, sizeof(JsonValue *) * (v->itemCount + 1));
        v->items[v->itemCount++] = item;
        skip_ws(p);
        if (p->pos < p->len && p->text[p->pos] == ',') { p->pos++; continue; }
        if (p->pos < p->len && p->text[p->pos] == ']') { p->pos++; break; }
        json_free(v);
        set_error(errorOut, "expected ',' or ']' at offset %lu", p->pos);
        return NULL;
    }
    return v;
}

static JsonValue *parse_value(Parser *p, char **errorOut) {
    skip_ws(p);
    if (p->pos >= p->len) { set_error(errorOut, "unexpected end of input at offset %lu", p->pos); return NULL; }
    char c = p->text[p->pos];
    if (c == '{') return parse_object(p, errorOut);
    if (c == '[') return parse_array(p, errorOut);
    if (c == '"') {
        char *s = parse_string_raw(p, errorOut);
        if (!s) return NULL;
        JsonValue *v = json_new(JSON_STRING);
        v->stringValue = s;
        return v;
    }
    if (strncmp(p->text + p->pos, "true", 4) == 0) {
        p->pos += 4;
        JsonValue *v = json_new(JSON_BOOL);
        v->boolValue = 1;
        return v;
    }
    if (strncmp(p->text + p->pos, "false", 5) == 0) {
        p->pos += 5;
        JsonValue *v = json_new(JSON_BOOL);
        v->boolValue = 0;
        return v;
    }
    if (strncmp(p->text + p->pos, "null", 4) == 0) {
        p->pos += 4;
        return json_new(JSON_NULL);
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
        size_t start = p->pos;
        if (p->text[p->pos] == '-') p->pos++;
        while (p->pos < p->len && p->text[p->pos] >= '0' && p->text[p->pos] <= '9') p->pos++;
        if (p->pos < p->len && p->text[p->pos] == '.') {
            p->pos++;
            while (p->pos < p->len && p->text[p->pos] >= '0' && p->text[p->pos] <= '9') p->pos++;
        }
        if (p->pos < p->len && (p->text[p->pos] == 'e' || p->text[p->pos] == 'E')) {
            p->pos++;
            if (p->pos < p->len && (p->text[p->pos] == '+' || p->text[p->pos] == '-')) p->pos++;
            while (p->pos < p->len && p->text[p->pos] >= '0' && p->text[p->pos] <= '9') p->pos++;
        }
        char numbuf[64];
        size_t n = p->pos - start;
        if (n >= sizeof(numbuf)) n = sizeof(numbuf) - 1;
        memcpy(numbuf, p->text + start, n);
        numbuf[n] = 0;
        JsonValue *v = json_new(JSON_NUMBER);
        v->numberValue = atof(numbuf);
        return v;
    }
    set_error(errorOut, "unexpected character at offset %lu", p->pos);
    return NULL;
}

JsonValue *json_parse(const char *text, char **errorOut) {
    if (errorOut) *errorOut = NULL;
    if (!text) { set_error(errorOut, "empty response body at offset %lu", 0); return NULL; }
    Parser p;
    p.text = text;
    p.pos = 0;
    p.len = strlen(text);
    JsonValue *v = parse_value(&p, errorOut);
    if (!v) return NULL;
    skip_ws(&p);
    if (p.pos != p.len) {
        json_free(v);
        set_error(errorOut, "trailing content after JSON value at offset %lu", p.pos);
        return NULL;
    }
    return v;
}

void json_free(JsonValue *v) {
    if (!v) return;
    if (v->type == JSON_STRING) free(v->stringValue);
    if (v->type == JSON_ARRAY) {
        for (size_t i = 0; i < v->itemCount; i++) json_free(v->items[i]);
        free(v->items);
    }
    if (v->type == JSON_OBJECT) {
        for (size_t i = 0; i < v->memberCount; i++) {
            free(v->keys[i]);
            json_free(v->values[i]);
        }
        free(v->keys);
        free(v->values);
    }
    free(v);
}

JsonValue *json_object_get(const JsonValue *obj, const char *key) {
    if (!obj || obj->type != JSON_OBJECT) return NULL;
    for (size_t i = 0; i < obj->memberCount; i++) {
        if (strcmp(obj->keys[i], key) == 0) return obj->values[i];
    }
    return NULL;
}

JsonValue *json_new_object(void) { return json_new(JSON_OBJECT); }
JsonValue *json_new_array(void) { return json_new(JSON_ARRAY); }

JsonValue *json_new_string(const char *s) {
    JsonValue *v = json_new(JSON_STRING);
    v->stringValue = dupstr(s ? s : "");
    return v;
}

JsonValue *json_new_number(double n) {
    JsonValue *v = json_new(JSON_NUMBER);
    v->numberValue = n;
    return v;
}

JsonValue *json_new_null(void) { return json_new(JSON_NULL); }

void json_object_set(JsonValue *obj, const char *key, JsonValue *value) {
    if (!obj || obj->type != JSON_OBJECT) { json_free(value); return; }
    obj->keys = (char **)realloc(obj->keys, sizeof(char *) * (obj->memberCount + 1));
    obj->values = (JsonValue **)realloc(obj->values, sizeof(JsonValue *) * (obj->memberCount + 1));
    obj->keys[obj->memberCount] = dupstr(key);
    obj->values[obj->memberCount] = value;
    obj->memberCount++;
}

void json_array_push(JsonValue *arr, JsonValue *value) {
    if (!arr || arr->type != JSON_ARRAY) { json_free(value); return; }
    arr->items = (JsonValue **)realloc(arr->items, sizeof(JsonValue *) * (arr->itemCount + 1));
    arr->items[arr->itemCount++] = value;
}

void jsb_init(JsonStringBuilder *sb) {
    sb->data = NULL;
    sb->length = 0;
    sb->capacity = 0;
}

void jsb_free(JsonStringBuilder *sb) {
    free(sb->data);
    sb->data = NULL;
    sb->length = 0;
    sb->capacity = 0;
}

static void jsb_reserve(JsonStringBuilder *sb, size_t extra) {
    if (sb->length + extra + 1 <= sb->capacity) return;
    size_t newCap = sb->capacity == 0 ? 64 : sb->capacity * 2;
    while (newCap < sb->length + extra + 1) newCap *= 2;
    sb->data = (char *)realloc(sb->data, newCap);
    sb->capacity = newCap;
}

void jsb_append(JsonStringBuilder *sb, const char *text) {
    if (!text) return;
    size_t n = strlen(text);
    jsb_reserve(sb, n);
    memcpy(sb->data + sb->length, text, n);
    sb->length += n;
    sb->data[sb->length] = 0;
}

void jsb_append_json_escaped(JsonStringBuilder *sb, const char *text) {
    jsb_append(sb, "\"");
    if (text) {
        for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
            unsigned char c = *p;
            char buf[8];
            switch (c) {
                case '"': jsb_append(sb, "\\\""); break;
                case '\\': jsb_append(sb, "\\\\"); break;
                case '\n': jsb_append(sb, "\\n"); break;
                case '\r': jsb_append(sb, "\\r"); break;
                case '\t': jsb_append(sb, "\\t"); break;
                default:
                    if (c < 0x20) {
                        snprintf(buf, sizeof(buf), "\\u%04x", c);
                        jsb_append(sb, buf);
                    } else {
                        buf[0] = (char)c;
                        buf[1] = 0;
                        jsb_append(sb, buf);
                    }
            }
        }
    }
    jsb_append(sb, "\"");
}

void json_value_to_display_string(const JsonValue *v, JsonStringBuilder *out) {
    if (!v || v->type == JSON_NULL) return; /* caller treats empty as SQL NULL */
    char numbuf[64];
    switch (v->type) {
        case JSON_BOOL:
            jsb_append(out, v->boolValue ? "true" : "false");
            break;
        case JSON_NUMBER:
            if (v->numberValue == (double)(long long)v->numberValue) {
                snprintf(numbuf, sizeof(numbuf), "%lld", (long long)v->numberValue);
            } else {
                snprintf(numbuf, sizeof(numbuf), "%.15g", v->numberValue);
            }
            jsb_append(out, numbuf);
            break;
        case JSON_STRING:
            jsb_append(out, v->stringValue);
            break;
        case JSON_ARRAY:
        case JSON_OBJECT: {
            /* Only ever reached for a malformed/unexpected server response
             * (real cell values are scalars); still handled for real
             * rather than left to crash, per this session's own rule
             * against silent no-ops on unexpected input. */
            jsb_append(out, v->type == JSON_ARRAY ? "[array]" : "[object]");
            break;
        }
        default:
            break;
    }
}
