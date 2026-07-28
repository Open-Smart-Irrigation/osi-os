#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif

struct probe_result {
    int available;
    const char *code;
    const char *detail;
    int collision_proven;
    int source_unchanged;
    int destination_unchanged;
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

static void print_result(const struct probe_result *result) {
    printf("{\"available\":%s,\"code\":", result->available ? "true" : "false");
    json_string(result->code);
    fputs(",\"detail\":", stdout);
    json_string(result->detail);
    if (result->collision_proven) {
        fputs(",\"collision\":{\"errno\":\"EEXIST\",\"sourceUnchanged\":", stdout);
        fputs(result->source_unchanged ? "true" : "false", stdout);
        fputs(",\"destinationUnchanged\":", stdout);
        fputs(result->destination_unchanged ? "true" : "false", stdout);
        putchar('}');
    }
    fputs("}\n", stdout);
}

static int unsupported_filesystem_errno(int error_number) {
    return error_number == EROFS || error_number == EOPNOTSUPP || error_number == ENOTSUP ||
        error_number == EXDEV || error_number == ENOSYS;
}

static const char *filesystem_failure_code(int error_number) {
    return unsupported_filesystem_errno(error_number) ? "FILESYSTEM_UNSUPPORTED" : "FILESYSTEM_UNAVAILABLE";
}

static int write_all(int descriptor, const char *contents, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t written = write(descriptor, contents + offset, length - offset);
        if (written < 0) return -1;
        if (written == 0) {
            errno = EIO;
            return -1;
        }
        offset += (size_t)written;
    }
    return 0;
}

static int file_matches(int directory, const char *name, const char *expected) {
    char contents[32];
    size_t expected_length = strlen(expected);
    size_t offset = 0;
    int descriptor = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) return 0;
    while (offset < sizeof(contents) - 1) {
        ssize_t count = read(descriptor, contents + offset, sizeof(contents) - 1 - offset);
        if (count < 0) {
            close(descriptor);
            return 0;
        }
        if (count == 0) break;
        offset += (size_t)count;
    }
    contents[offset] = '\0';
    close(descriptor);
    return offset == expected_length && memcmp(contents, expected, expected_length) == 0;
}

static int cleanup_scratch(const char *path) {
    char source[PATH_MAX];
    char destination[PATH_MAX];
    int cleanup_error = 0;
    if (snprintf(source, sizeof(source), "%s/source.bin", path) >= (int)sizeof(source) ||
        snprintf(destination, sizeof(destination), "%s/destination.bin", path) >= (int)sizeof(destination)) return -1;
    if (unlink(source) < 0 && errno != ENOENT) cleanup_error = 1;
    if (unlink(destination) < 0 && errno != ENOENT) cleanup_error = 1;
    if (rmdir(path) < 0) cleanup_error = 1;
#ifdef PROBE_TEST_FORCE_CLEANUP_FAILURE
    if (cleanup_error == 0) return -1;
#endif
    return cleanup_error == 0 ? 0 : -1;
}

int main(int argc, char **argv) {
    const char *parent;
    const char *source_contents = "source-content\n";
    const char *destination_contents = "destination-content\n";
    char scratch_template[PATH_MAX];
    int directory = -1;
    struct probe_result result = { 0, "FILESYSTEM_UNAVAILABLE", "probe scratch location is unavailable", 0, 0, 0 };

    if (argc != 2 || argv[1][0] != '/') {
        result.code = "SCRATCH_PARENT_INVALID";
        result.detail = "exactly one absolute scratch parent is required";
        print_result(&result);
        return 2;
    }
    parent = argv[1];
    if (snprintf(scratch_template, sizeof(scratch_template), "%s%sosi-image-builder-probe-XXXXXX",
        parent, parent[strlen(parent) - 1] == '/' ? "" : "/") >= (int)sizeof(scratch_template)) {
        result.code = "FILESYSTEM_UNAVAILABLE";
        result.detail = "probe scratch path is too long";
        print_result(&result);
        return 2;
    }

    if (mkdtemp(scratch_template) == NULL) {
        result.code = filesystem_failure_code(errno);
        result.detail = result.code[0] == 'F' && strcmp(result.code, "FILESYSTEM_UNSUPPORTED") == 0
            ? "scratch parent does not support the private probe directory"
            : "scratch parent cannot create the private probe directory";
        print_result(&result);
        return 2;
    }
    directory = open(scratch_template, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (directory < 0) {
        result.code = "FILESYSTEM_UNAVAILABLE";
        result.detail = "private probe directory could not be opened";
        goto cleanup;
    }

#if !defined(__linux__) || !defined(SYS_renameat2)
    result.code = "LINUX_RENAMEAT2_UNAVAILABLE";
    result.detail = "Linux renameat2 syscall is unavailable on this host";
    goto cleanup;
#elif !defined(RENAME_NOREPLACE)
    result.code = "RENAME_NOREPLACE_UNAVAILABLE";
    result.detail = "RENAME_NOREPLACE is unavailable in the host headers";
    goto cleanup;
#else
    {
    long rename_result;
    {
        int source = openat(directory, "source.bin", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
        if (source < 0 || write_all(source, source_contents, strlen(source_contents)) < 0 || fsync(source) < 0) {
            int saved_error = errno;
            if (source >= 0) close(source);
            result.code = filesystem_failure_code(saved_error);
            result.detail = "private probe source could not be created";
            goto cleanup;
        }
        close(source);
    }
    {
        int destination = openat(directory, "destination.bin", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
        if (destination < 0 || write_all(destination, destination_contents, strlen(destination_contents)) < 0 || fsync(destination) < 0) {
            int saved_error = errno;
            if (destination >= 0) close(destination);
            result.code = filesystem_failure_code(saved_error);
            result.detail = "private probe destination could not be created";
            goto cleanup;
        }
        close(destination);
    }
    errno = 0;
#ifdef PROBE_TEST_FORCE_ENOSYS_AFTER_CREATE
    errno = ENOSYS;
    rename_result = -1;
#else
    rename_result = syscall(SYS_renameat2, directory, "source.bin", directory, "destination.bin", RENAME_NOREPLACE);
#endif
    if (rename_result == 0) {
        result.code = "RENAME_NOREPLACE_UNAVAILABLE";
        result.detail = "collision rename succeeded and would replace the destination";
    } else if (errno == EEXIST) {
        result.collision_proven = 1;
        result.source_unchanged = file_matches(directory, "source.bin", source_contents);
        result.destination_unchanged = file_matches(directory, "destination.bin", destination_contents);
        if (result.source_unchanged && result.destination_unchanged) {
            result.available = 1;
            result.code = "RENAME_NOREPLACE_AVAILABLE";
            result.detail = "collision returned EEXIST and neither file was replaced";
        } else {
            result.code = "RENAME_NOREPLACE_UNAVAILABLE";
            result.detail = "collision returned EEXIST but file contents changed";
        }
    } else if (errno == ENOSYS) {
        result.code = "LINUX_RENAMEAT2_UNAVAILABLE";
        result.detail = "Linux kernel does not expose renameat2";
    } else if (errno == EINVAL) {
        result.code = "RENAME_NOREPLACE_UNAVAILABLE";
        result.detail = "kernel rejected the RENAME_NOREPLACE flag";
    } else if (unsupported_filesystem_errno(errno)) {
        result.code = "FILESYSTEM_UNSUPPORTED";
        result.detail = "filesystem rejected RENAME_NOREPLACE";
    } else {
        result.code = "FILESYSTEM_UNAVAILABLE";
        result.detail = "filesystem probe syscall failed";
    }
    }
#endif

cleanup:
    if (directory >= 0) {
        close(directory);
        directory = -1;
    }
    if (cleanup_scratch(scratch_template) < 0) {
        result.available = 0;
        result.code = "PROBE_CLEANUP_FAILED";
        result.detail = "private probe scratch cleanup failed";
        result.collision_proven = 0;
    }
    print_result(&result);
    return result.available ? 0 : 2;
}
