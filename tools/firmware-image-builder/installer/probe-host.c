#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#if defined(__linux__) && defined(SYS_renameat2)
#define OSI_LINUX_RENAMEAT2_HEADERS 1
#else
#define OSI_LINUX_RENAMEAT2_HEADERS 0
#endif

#if defined(__linux__) && defined(RENAME_NOREPLACE)
#define OSI_RENAME_NOREPLACE_HEADER 1
#else
#define OSI_RENAME_NOREPLACE_HEADER 0
#endif

struct prerequisite {
    const char *name;
    int available;
    const char *available_code;
    const char *missing_code;
    const char *available_detail;
    const char *missing_detail;
};

static void json_string(const char *value) {
    const unsigned char *cursor = (const unsigned char *)(value == NULL ? "" : value);
    putchar('"');
    while (*cursor != '\0') {
        switch (*cursor) {
        case '\\': fputs("\\\\", stdout); break;
        case '"': fputs("\\\"", stdout); break;
        case '\n': fputs("\\n", stdout); break;
        case '\r': fputs("\\r", stdout); break;
        case '\t': fputs("\\t", stdout); break;
        default:
            if (*cursor < 0x20U) printf("\\u%04x", (unsigned int)*cursor);
            else putchar((int)*cursor);
        }
        cursor += 1;
    }
    putchar('"');
}

static int command_on_path(const char *command) {
    const char *path = getenv("PATH");
    const char *cursor;
    if (path == NULL) return 0;
    cursor = path;
    while (1) {
        const char *separator = strchr(cursor, ':');
        size_t directory_length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
        char candidate[PATH_MAX];
        int written;
        if (directory_length == 0) {
            written = snprintf(candidate, sizeof(candidate), "./%s", command);
        } else {
            written = snprintf(candidate, sizeof(candidate), "%.*s/%s", (int)directory_length, cursor, command);
        }
        if (written > 0 && (size_t)written < sizeof(candidate) && access(candidate, X_OK) == 0) return 1;
        if (separator == NULL) break;
        cursor = separator + 1;
    }
    return 0;
}

static void print_prerequisite(const struct prerequisite *item) {
    printf("\"%s\":{\"available\":%s,\"code\":", item->name, item->available ? "true" : "false");
    json_string(item->available ? item->available_code : item->missing_code);
    fputs(",\"detail\":", stdout);
    json_string(item->available ? item->available_detail : item->missing_detail);
    putchar('}');
}

int main(void) {
    struct prerequisite gcc = {
        .name = "gcc",
        .available = command_on_path("gcc"),
        .available_code = "GCC_AVAILABLE",
        .missing_code = "GCC_MISSING",
        .available_detail = "gcc executable found on PATH",
        .missing_detail = "gcc executable was not found on PATH"
    };
    struct prerequisite libc_headers = {
        .name = "libcHeaders",
        .available = 1,
        .available_code = "LIBC_HEADERS_AVAILABLE",
        .missing_code = "LIBC_HEADERS_MISSING",
        .available_detail = "required libc and Linux filesystem headers compiled",
        .missing_detail = "required libc or Linux filesystem headers are unavailable"
    };
    struct prerequisite make = {
        .name = "make",
        .available = command_on_path("make"),
        .available_code = "MAKE_AVAILABLE",
        .missing_code = "MAKE_MISSING",
        .available_detail = "make executable found on PATH",
        .missing_detail = "make executable was not found on PATH"
    };
    struct prerequisite linux_renameat2 = {
        .name = "linuxRenameat2",
        .available = OSI_LINUX_RENAMEAT2_HEADERS && OSI_RENAME_NOREPLACE_HEADER,
        .available_code = "LINUX_RENAMEAT2_AVAILABLE",
        .missing_code = "LINUX_RENAMEAT2_MISSING",
        .available_detail = "Linux renameat2 and RENAME_NOREPLACE declarations compiled",
        .missing_detail = "Linux renameat2 or RENAME_NOREPLACE declarations are unavailable"
    };
    const struct prerequisite *first_failure = NULL;
    const struct prerequisite *items[] = { &gcc, &libc_headers, &make, &linux_renameat2 };
    size_t index;

    for (index = 0; index < sizeof(items) / sizeof(items[0]); index += 1) {
        if (!items[index]->available) {
            first_failure = items[index];
            break;
        }
    }

    printf("{\"available\":%s,\"code\":", first_failure == NULL ? "true" : "false");
    json_string(first_failure == NULL ? "HOST_PREREQUISITES_AVAILABLE" : first_failure->missing_code);
    fputs(",\"detail\":", stdout);
    json_string(first_failure == NULL ? "all native host prerequisites are available" : first_failure->missing_detail);
    fputs(",\"prerequisites\":{", stdout);
    print_prerequisite(&gcc);
    putchar(',');
    print_prerequisite(&libc_headers);
    putchar(',');
    print_prerequisite(&make);
    putchar(',');
    print_prerequisite(&linux_renameat2);
    fputs("}}\n", stdout);
    return first_failure == NULL ? 0 : 2;
}
