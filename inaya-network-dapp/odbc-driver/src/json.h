#ifndef INAYA_JSON_H
#define INAYA_JSON_H

#include <stddef.h>

/* A small, real recursive-descent JSON parser and a string-builder
 * serializer, written for this driver rather than vendored, since the
 * only external dependency this project wants is WinHTTP + the platform
 * ODBC SDK -- both already provided by the OS / MinGW-w64. Supports the
 * full JSON grammar (object, array, string with \\uXXXX escapes, number,
 * true/false/null); it is not a partial parser restricted to the shapes
 * this driver happens to consume. */

typedef enum {
    JSON_NULL,
    JSON_BOOL,
    JSON_NUMBER,
    JSON_STRING,
    JSON_ARRAY,
    JSON_OBJECT
} JsonType;

typedef struct JsonValue {
    JsonType type;
    int boolValue;
    double numberValue;
    char *stringValue; /* owned, NUL-terminated, JSON_STRING only */

    struct JsonValue **items; /* JSON_ARRAY */
    size_t itemCount;

    char **keys;               /* JSON_OBJECT */
    struct JsonValue **values;  /* JSON_OBJECT, parallel to keys */
    size_t memberCount;
} JsonValue;

/* Parses `text` (NUL-terminated). Returns NULL and sets *errorOut (caller
 * must free with free()) on a syntax error. On success the returned tree
 * must be released with json_free(). */
JsonValue *json_parse(const char *text, char **errorOut);

void json_free(JsonValue *v);

/* NULL if `obj` isn't a JSON_OBJECT or has no such key. */
JsonValue *json_object_get(const JsonValue *obj, const char *key);

/* Builders, used to construct synthetic catalog result sets (SQLTables /
 * SQLColumns) in the exact same rows-of-objects shape the real query
 * endpoint returns, so SQLFetch/SQLGetData share one code path for both
 * real query results and driver-side catalog metadata. */
JsonValue *json_new_object(void);
JsonValue *json_new_array(void);
JsonValue *json_new_string(const char *s);
JsonValue *json_new_number(double n);
JsonValue *json_new_null(void);
/* Both take ownership of `value`; key is duplicated. */
void json_object_set(JsonValue *obj, const char *key, JsonValue *value);
void json_array_push(JsonValue *arr, JsonValue *value);

/* Simple growable string buffer, used both to build request bodies and
 * to stringify arbitrary JSON values into display text for SQLGetData. */
typedef struct {
    char *data;
    size_t length;
    size_t capacity;
} JsonStringBuilder;

void jsb_init(JsonStringBuilder *sb);
void jsb_free(JsonStringBuilder *sb);
void jsb_append(JsonStringBuilder *sb, const char *text);
void jsb_append_json_escaped(JsonStringBuilder *sb, const char *text);

/* Renders any JSON value (including nested arrays/objects, which the
 * server never sends for a scalar cell, but the driver must not crash if
 * it did) as human-readable text, matching the honest all-columns-are-
 * text-typed model documented for the JDBC driver in jdbc-driver/README.md. */
void json_value_to_display_string(const JsonValue *v, JsonStringBuilder *out);

#endif
