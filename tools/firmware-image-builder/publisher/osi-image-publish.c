#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif

#ifndef PUBLISHER_VERSION
#define PUBLISHER_VERSION "0.1.0"
#endif

#ifndef PUBLISHER_SOURCE_SHA256
#define PUBLISHER_SOURCE_SHA256 "unknown"
#endif

#define MAX_COMPONENT 256
#define MAX_JOB_ID 128
#define MAX_BRANCH 4096
#define MAX_SHA 40
#define MAX_BRANCH_BASENAME 255

struct operation_result {
    int available;
    int mutation_count;
    int published;
    int quarantined;
    int self_test;
    const char *error_code;
    const char *destination;
    const char *staging;
    const char *rename_result;
    char source_relative[PATH_MAX];
    char destination_relative[PATH_MAX];
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

static void print_result(const struct operation_result *result) {
    printf("{\"available\":%s,\"published\":%s,\"quarantined\":%s,\"selfTest\":%s,\"mutationCount\":%d",
        result->available ? "true" : "false",
        result->published ? "true" : "false",
        result->quarantined ? "true" : "false",
        result->self_test ? "true" : "false",
        result->mutation_count);
    if (result->error_code != NULL) {
        fputs(",\"errorCode\":", stdout);
        json_string(result->error_code);
    }
    if (result->destination != NULL) {
        fputs(",\"destination\":", stdout);
        json_string(result->destination);
    }
    if (result->staging != NULL) {
        fputs(",\"staging\":", stdout);
        json_string(result->staging);
    }
    if (result->source_relative[0] != '\0') {
        fputs(",\"publisherVersion\":", stdout);
        json_string(PUBLISHER_VERSION);
        fputs(",\"publisherSourceSha256\":", stdout);
        json_string(PUBLISHER_SOURCE_SHA256);
        fputs(",\"sourceRelativePath\":", stdout);
        json_string(result->source_relative);
    }
    if (result->destination_relative[0] != '\0') {
        fputs(",\"destinationRelativePath\":", stdout);
        json_string(result->destination_relative);
    }
    if (result->rename_result != NULL) {
        fputs(",\"renameResult\":", stdout);
        json_string(result->rename_result);
    }
    putchar('}');
    putchar('\n');
}

static int fail_result(const char *error_code, int available, int mutation_count) {
    struct operation_result result = {
        .available = available,
        .mutation_count = mutation_count,
        .published = 0,
        .quarantined = 0,
        .self_test = 0,
        .error_code = error_code,
        .destination = NULL,
        .staging = NULL,
    };
    print_result(&result);
    return 2;
}

static int is_hex_string(const char *value, size_t length) {
    size_t index;
    if (strlen(value) != length) return 0;
    for (index = 0; index < length; index += 1) {
        char character = value[index];
        if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return 0;
    }
    return 1;
}

static int safe_identifier(const char *value, size_t maximum) {
    size_t length = strlen(value);
    size_t index;
    if (length == 0 || length > maximum || value[0] == '.' || value[0] == '-') return 0;
    for (index = 0; index < length; index += 1) {
        char character = value[index];
        if (!((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
              (character >= '0' && character <= '9') || character == '-' || character == '_' || character == '.')) return 0;
    }
    return 1;
}

static int safe_branch(const char *value) {
    size_t length = strlen(value);
    size_t index;
    if (length == 0 || length > MAX_BRANCH_BASENAME || length >= MAX_BRANCH || strcmp(value, ".") == 0 || strcmp(value, "..") == 0 || value[length - 1] == '%') return 0;
    for (index = 0; index < length; index += 1) {
        char character = value[index];
        if ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
            (character >= '0' && character <= '9') || character == '-' || character == '_' || character == '.' || character == '~') continue;
        if (character == '%' && index + 2 < length &&
            ((value[index + 1] >= '0' && value[index + 1] <= '9') || (value[index + 1] >= 'A' && value[index + 1] <= 'F')) &&
            ((value[index + 2] >= '0' && value[index + 2] <= '9') || (value[index + 2] >= 'A' && value[index + 2] <= 'F'))) {
            index += 2;
            continue;
        }
        return 0;
    }
    return 1;
}

static int safe_target(const char *value) {
    return strcmp(value, "rpi-5") == 0 || strcmp(value, "rpi-2") == 0;
}

static int safe_absolute_path(const char *value) {
    size_t length = strlen(value);
    size_t index;
    if (length < 2 || length >= PATH_MAX || value[0] != '/' || strstr(value, "//") != NULL) return 0;
    for (index = 0; index + 1 < length; index += 1) {
        if (value[index] == '/' && value[index + 1] == '.') {
            if (index + 2 == length || value[index + 2] == '/' ||
                (value[index + 2] == '.' && (index + 3 == length || value[index + 3] == '/'))) return 0;
        }
    }
    return 1;
}

static int open_absolute_directory(const char *path) {
    char copy[PATH_MAX];
    char *cursor;
    int current;
    if (!safe_absolute_path(path) || strlen(path) >= sizeof(copy)) return -1;
    (void)snprintf(copy, sizeof(copy), "%s", path);
    current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (current < 0) return -1;
    cursor = copy + 1;
    while (*cursor != '\0') {
        char *next = strchr(cursor, '/');
        int child;
        if (next != NULL) *next = '\0';
        if (*cursor == '\0' || strcmp(cursor, ".") == 0 || strcmp(cursor, "..") == 0 || strlen(cursor) >= MAX_COMPONENT) {
            close(current);
            return -1;
        }
        child = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (child < 0) {
            close(current);
            return -1;
        }
        close(current);
        current = child;
        if (next == NULL) break;
        cursor = next + 1;
    }
    return current;
}

static int open_directory_at(int parent, const char *name, int create, int *created) {
    int result;
    if (created != NULL) *created = 0;
    if (create) {
        if (mkdirat(parent, name, 0750) == 0) {
            if (created != NULL) *created = 1;
        } else if (errno != EEXIST) return -1;
    }
    result = openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    return result;
}

static int same_device(int first, int second) {
    struct stat first_stat;
    struct stat second_stat;
#ifdef PUBLISHER_TEST_CROSS_DEVICE
    (void)first;
    (void)second;
    return 0;
#endif
    if (fstat(first, &first_stat) < 0 || fstat(second, &second_stat) < 0) return 0;
    return first_stat.st_dev == second_stat.st_dev;
}

static int fsync_tree(int directory) {
    int duplicate = dup(directory);
    DIR *stream;
    struct dirent *entry;
    if (duplicate < 0) return -1;
    stream = fdopendir(duplicate);
    if (stream == NULL) {
        close(duplicate);
        return -1;
    }
    errno = 0;
    while ((entry = readdir(stream)) != NULL) {
        struct stat item;
        struct stat opened_item;
        int child;
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (fstatat(directory, entry->d_name, &item, AT_SYMLINK_NOFOLLOW) < 0 || S_ISLNK(item.st_mode) || S_ISBLK(item.st_mode)) {
            closedir(stream);
            return -1;
        }
        if (S_ISDIR(item.st_mode)) {
            child = openat(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
            if (child < 0 || fstat(child, &opened_item) < 0 || opened_item.st_dev != item.st_dev || opened_item.st_ino != item.st_ino || !S_ISDIR(opened_item.st_mode) || fsync_tree(child) < 0) {
                if (child >= 0) close(child);
                closedir(stream);
                return -1;
            }
            close(child);
        } else if (S_ISREG(item.st_mode)) {
            child = openat(directory, entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
            if (child < 0 || fstat(child, &opened_item) < 0 || opened_item.st_dev != item.st_dev || opened_item.st_ino != item.st_ino || !S_ISREG(opened_item.st_mode) || fsync(child) < 0) {
                if (child >= 0) close(child);
                closedir(stream);
                return -1;
            }
            close(child);
        } else {
            closedir(stream);
            return -1;
        }
    }
    if (errno != 0) {
        closedir(stream);
        return -1;
    }
    if (closedir(stream) < 0) return -1;
    return fsync(directory);
}

static int publisher_renameat2(int old_parent, const char *old_name, int new_parent, const char *new_name) {
#ifdef __GLIBC__
    return renameat2(old_parent, old_name, new_parent, new_name, RENAME_NOREPLACE);
#else
    (void)old_parent;
    (void)old_name;
    (void)new_parent;
    (void)new_name;
    errno = ENOSYS;
    return -1;
#endif
}

static int publisher_capability_available(int directory) {
    char probe_name[96];
    int probe = -1;
    int renamed = 0;
    int supported = -1;
    int cleanup_failed = 0;
    int status;
#ifdef PUBLISHER_TEST_UNSUPPORTED
    (void)directory;
    return 0;
#endif
    if (snprintf(probe_name, sizeof(probe_name), ".osi-image-publisher-capability-%ld", (long)getpid()) < 0) return -1;
    if (mkdirat(directory, probe_name, 0700) < 0) return -1;
    probe = openat(directory, probe_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (probe < 0 || mkdirat(probe, "source", 0700) < 0) goto cleanup;
    status = publisher_renameat2(probe, "source", probe, "destination");
    if (status == 0) {
        renamed = 1;
        supported = 1;
    } else if (errno == ENOSYS || errno == EOPNOTSUPP) supported = 0;
cleanup:
    if (probe >= 0) {
        if (unlinkat(probe, renamed ? "destination" : "source", AT_REMOVEDIR) < 0 && errno != ENOENT) cleanup_failed = 1;
        if (close(probe) < 0) cleanup_failed = 1;
    }
    if (unlinkat(directory, probe_name, AT_REMOVEDIR) < 0) cleanup_failed = 1;
    if (fsync(directory) < 0) cleanup_failed = 1;
    return cleanup_failed ? -1 : supported;
}

static int source_identity_matches(int parent, const char *name, const struct stat *expected) {
    struct stat observed;
    if (fstatat(parent, name, &observed, AT_SYMLINK_NOFOLLOW) < 0) return 0;
    return S_ISDIR(observed.st_mode) && observed.st_dev == expected->st_dev && observed.st_ino == expected->st_ino;
}

static int directory_binding_matches(int parent, const char *name, int directory) {
    struct stat opened;
    struct stat named;
    if (fstat(directory, &opened) < 0 || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) < 0) return 0;
    return S_ISDIR(opened.st_mode) && S_ISDIR(named.st_mode) &&
        opened.st_dev == named.st_dev && opened.st_ino == named.st_ino;
}

#if defined(PUBLISHER_TEST_SWAP_BEFORE) || defined(PUBLISHER_TEST_SWAP_AFTER)
static int test_swap_source(int parent, const char *name) {
    if (renameat(parent, name, parent, ".publisher-test-hidden") < 0) return -1;
    if (symlinkat("/tmp", parent, name) < 0) return -1;
    return 0;
}
#endif

#ifdef PUBLISHER_TEST_SWAP_DESTINATION
static int test_swap_destination(int parent, const char *name) {
    char hidden[MAX_JOB_ID + 40];
    int length = snprintf(hidden, sizeof(hidden), ".publisher-test-destination-hidden-%s", name);
    if (length < 0 || (size_t)length >= sizeof(hidden)) return -1;
    if (renameat(parent, name, parent, hidden) < 0) return -1;
    if (symlinkat("/tmp", parent, name) < 0) return -1;
    return 0;
}
#endif

#if defined(PUBLISHER_TEST_ANCESTOR_BEFORE) || defined(PUBLISHER_TEST_ANCESTOR_AFTER)
static int test_swap_ancestor(int parent, const char *name) {
    if (renameat(parent, name, parent, ".publisher-test-ancestor-hidden") < 0) return -1;
    if (mkdirat(parent, name, 0750) < 0) return -1;
    return 0;
}
#endif

static int destination_identity_matches(int directory, const char *name, const struct stat *expected) {
    int destination = openat(directory, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat opened;
    struct stat named;
    int matches;
    if (destination < 0) return 0;
#ifdef PUBLISHER_TEST_SWAP_DESTINATION
    if (test_swap_destination(directory, name) < 0) {
        close(destination);
        return 0;
    }
#endif
    if (fstat(destination, &opened) < 0 || fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) < 0) {
        close(destination);
        return 0;
    }
    matches = S_ISDIR(opened.st_mode) && S_ISDIR(named.st_mode) &&
        opened.st_dev == expected->st_dev && opened.st_ino == expected->st_ino &&
        named.st_dev == opened.st_dev && named.st_ino == opened.st_ino;
    close(destination);
    return matches;
}

static int sync_publish_parents(int staging_parent, int destination_parent, int branch_parent, int metadata, int root) {
    int failed = 0;
    if (fsync(staging_parent) < 0) failed = 1;
    if (fsync(destination_parent) < 0) failed = 1;
    if (fsync(branch_parent) < 0) failed = 1;
    if (fsync(metadata) < 0) failed = 1;
    if (fsync(root) < 0) failed = 1;
#ifdef PUBLISHER_TEST_FSYNC_FAILURE
    failed = 1;
#endif
    return failed ? -1 : 0;
}

static int sync_quarantine_parents(int staging_parent, int quarantine_parent, int metadata, int root) {
    int failed = 0;
    if (fsync(staging_parent) < 0) failed = 1;
    if (fsync(quarantine_parent) < 0) failed = 1;
    if (fsync(metadata) < 0) failed = 1;
    if (fsync(root) < 0) failed = 1;
#ifdef PUBLISHER_TEST_FSYNC_FAILURE
    failed = 1;
#endif
    return failed ? -1 : 0;
}

static int path_exists_at(int directory, const char *name, struct stat *item) {
    if (fstatat(directory, name, item, AT_SYMLINK_NOFOLLOW) == 0) return 1;
    if (errno == ENOENT) return 0;
    return -1;
}

static int required_release_files(int directory) {
    const char *required[] = { "sha256sums", "build-manifest.json", "verification.json" };
    size_t index;
    int image_count = 0;
    int duplicate = dup(directory);
    DIR *stream;
    struct dirent *entry;
    if (duplicate < 0) return 0;
    stream = fdopendir(duplicate);
    if (stream == NULL) {
        close(duplicate);
        return 0;
    }
    for (index = 0; index < sizeof(required) / sizeof(required[0]); index += 1) {
        struct stat item;
        if (fstatat(directory, required[index], &item, AT_SYMLINK_NOFOLLOW) < 0 || !S_ISREG(item.st_mode)) {
            closedir(stream);
            return 0;
        }
    }
    while ((entry = readdir(stream)) != NULL) {
        size_t length = strlen(entry->d_name);
        struct stat item;
        if (length > 7 && strcmp(entry->d_name + length - 7, ".img.gz") == 0 &&
            fstatat(directory, entry->d_name, &item, AT_SYMLINK_NOFOLLOW) == 0 && S_ISREG(item.st_mode)) image_count += 1;
    }
    closedir(stream);
    return image_count == 1;
}

static int prepare_root(const char *root_path, int *root, int *metadata) {
    struct stat root_stat;
    if (lstat(root_path, &root_stat) < 0) return -1;
#ifdef PUBLISHER_TEST_BLOCK_ROOT
    root_stat.st_mode = S_IFBLK;
#endif
    if (S_ISBLK(root_stat.st_mode) || !S_ISDIR(root_stat.st_mode) || S_ISLNK(root_stat.st_mode)) return -1;
    *root = open_absolute_directory(root_path);
    if (*root < 0) return -1;
    *metadata = open_directory_at(*root, ".osi-image-builder", 0, NULL);
    if (*metadata < 0) {
        close(*root);
        return -1;
    }
    return 0;
}

static const char *rename_error_name(int error_number) {
    if (error_number == EEXIST) return "EEXIST";
    if (error_number == ENOSYS) return "ENOSYS";
    if (error_number == EOPNOTSUPP) return "EOPNOTSUPP";
    if (error_number == EXDEV) return "EXDEV";
    return "OTHER_ERROR";
}

static int publish_bindings_match(int root, int metadata, int staging_parent, int branch_parent, const char *branch, int destination_parent, const char *sha) {
    return directory_binding_matches(root, ".osi-image-builder", metadata) &&
        directory_binding_matches(metadata, "staging", staging_parent) &&
        directory_binding_matches(root, branch, branch_parent) &&
        directory_binding_matches(branch_parent, sha, destination_parent);
}

static int quarantine_bindings_match(int root, int metadata, int staging_parent, int quarantine_parent) {
    return directory_binding_matches(root, ".osi-image-builder", metadata) &&
        directory_binding_matches(metadata, "staging", staging_parent) &&
        directory_binding_matches(metadata, "quarantine", quarantine_parent);
}

static int publish_operation(const char *root_path, const char *job_id, const char *branch, const char *sha, const char *target, struct operation_result *result) {
    int root = -1;
    int metadata = -1;
    int staging_parent = -1;
    int source = -1;
    int branch_parent = -1;
    int destination_parent = -1;
    int branch_created = 0;
    int destination_created = 0;
    int capability;
    int status;
    struct stat source_identity;
    result->available = 1;
    if (prepare_root(root_path, &root, &metadata) < 0) {
        result->error_code = "PUBLISH_FAILED";
        return 2;
    }
    capability = publisher_capability_available(metadata);
    if (capability == 0) {
        result->available = 0;
        result->error_code = "PUBLISHER_UNSUPPORTED";
        close(metadata);
        close(root);
        return 2;
    }
    if (capability < 0) goto invalid;
    (void)snprintf(result->source_relative, sizeof(result->source_relative), ".osi-image-builder/staging/%s", job_id);
    (void)snprintf(result->destination_relative, sizeof(result->destination_relative), "%s/%s/%s", branch, sha, target);
    staging_parent = open_directory_at(metadata, "staging", 0, NULL);
    if (staging_parent < 0) goto invalid;
    source = openat(staging_parent, job_id, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (source < 0) goto invalid;
    if (fstat(source, &source_identity) < 0 || !S_ISDIR(source_identity.st_mode)) goto invalid;
    if (fsync_tree(source) < 0 || fsync(staging_parent) < 0) goto invalid;
#ifdef PUBLISHER_TEST_SWAP_BEFORE
    if (test_swap_source(staging_parent, job_id) < 0) goto invalid;
#endif
    if (!source_identity_matches(staging_parent, job_id, &source_identity)) {
        result->error_code = "PUBLISH_FAILED";
        goto done;
    }
    branch_parent = open_directory_at(root, branch, 1, &branch_created);
    result->mutation_count += branch_created;
    if (branch_parent < 0) goto invalid;
    destination_parent = open_directory_at(branch_parent, sha, 1, &destination_created);
    result->mutation_count += destination_created;
    if (destination_parent < 0) goto invalid;
    if (!same_device(source, destination_parent)) {
        result->error_code = "STAGING_FILESYSTEM_MISMATCH";
        goto done;
    }
#ifdef PUBLISHER_TEST_SWAP_AFTER
    if (test_swap_source(staging_parent, job_id) < 0) goto invalid;
#endif
#ifdef PUBLISHER_TEST_ANCESTOR_BEFORE
    if (test_swap_ancestor(branch_parent, sha) < 0) goto invalid;
#endif
    if (!publish_bindings_match(root, metadata, staging_parent, branch_parent, branch, destination_parent, sha) ||
        !source_identity_matches(staging_parent, job_id, &source_identity)) {
        result->error_code = "PUBLISH_FAILED";
        goto done;
    }
    status = publisher_renameat2(staging_parent, job_id, destination_parent, target);
    if (status < 0) {
        int rename_error = errno;
        result->rename_result = rename_error_name(rename_error);
        if (rename_error == EEXIST) result->error_code = "OUTPUT_COLLISION";
        else if (rename_error == EXDEV) result->error_code = "STAGING_FILESYSTEM_MISMATCH";
        else result->error_code = "PUBLISH_FAILED";
        goto done;
    }
    result->rename_result = "RENAMED";
    result->published = 1;
    result->mutation_count += 1;
#ifdef PUBLISHER_TEST_ANCESTOR_AFTER
    if (test_swap_ancestor(branch_parent, sha) < 0) goto invalid;
#endif
    if (!publish_bindings_match(root, metadata, staging_parent, branch_parent, branch, destination_parent, sha) ||
        !destination_identity_matches(destination_parent, target, &source_identity)) {
        result->published = 0;
        result->error_code = "PUBLISH_FAILED";
        (void)sync_publish_parents(staging_parent, destination_parent, branch_parent, metadata, root);
        goto done;
    }
    if (sync_publish_parents(staging_parent, destination_parent, branch_parent, metadata, root) < 0) {
        result->published = 0;
        result->error_code = "PUBLISH_FAILED";
        goto done;
    }
    if (!publish_bindings_match(root, metadata, staging_parent, branch_parent, branch, destination_parent, sha) ||
        !destination_identity_matches(destination_parent, target, &source_identity)) {
        result->published = 0;
        result->error_code = "PUBLISH_FAILED";
        (void)sync_publish_parents(staging_parent, destination_parent, branch_parent, metadata, root);
        goto done;
    }
    goto done;
invalid:
    result->error_code = "PUBLISH_FAILED";
done:
    if (destination_parent >= 0) close(destination_parent);
    if (branch_parent >= 0) close(branch_parent);
    if (source >= 0) close(source);
    if (staging_parent >= 0) close(staging_parent);
    close(metadata);
    close(root);
    return result->published ? 0 : 2;
}

static int quarantine_operation(const char *root_path, const char *job_id, struct operation_result *result) {
    int root = -1;
    int metadata = -1;
    int staging_parent = -1;
    int quarantine_parent = -1;
    int source = -1;
    int quarantine_created = 0;
    int capability;
    int status;
    struct stat source_identity;
    result->available = 1;
    if (prepare_root(root_path, &root, &metadata) < 0) {
        result->error_code = "QUARANTINE_PENDING";
        return 2;
    }
    capability = publisher_capability_available(metadata);
    if (capability == 0) {
        result->available = 0;
        result->error_code = "PUBLISHER_UNSUPPORTED";
        close(metadata);
        close(root);
        return 2;
    }
    if (capability < 0) goto invalid;
    (void)snprintf(result->source_relative, sizeof(result->source_relative), ".osi-image-builder/staging/%s", job_id);
    (void)snprintf(result->destination_relative, sizeof(result->destination_relative), ".osi-image-builder/quarantine/%s", job_id);
    staging_parent = open_directory_at(metadata, "staging", 0, NULL);
    quarantine_parent = open_directory_at(metadata, "quarantine", 1, &quarantine_created);
    result->mutation_count += quarantine_created;
    if (staging_parent < 0 || quarantine_parent < 0) goto invalid;
    source = openat(staging_parent, job_id, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (source < 0 || fstat(source, &source_identity) < 0 || !S_ISDIR(source_identity.st_mode) || fsync_tree(source) < 0 || !same_device(source, quarantine_parent)) goto invalid;
#ifdef PUBLISHER_TEST_SWAP_BEFORE
    if (test_swap_source(staging_parent, job_id) < 0) goto invalid;
#endif
    if (!source_identity_matches(staging_parent, job_id, &source_identity)) {
        result->error_code = "QUARANTINE_PENDING";
        goto done;
    }
#ifdef PUBLISHER_TEST_SWAP_AFTER
    if (test_swap_source(staging_parent, job_id) < 0) goto invalid;
#endif
#ifdef PUBLISHER_TEST_ANCESTOR_BEFORE
    if (test_swap_ancestor(metadata, "quarantine") < 0) goto invalid;
#endif
    if (!quarantine_bindings_match(root, metadata, staging_parent, quarantine_parent) ||
        !source_identity_matches(staging_parent, job_id, &source_identity)) {
        result->error_code = "QUARANTINE_PENDING";
        goto done;
    }
    status = publisher_renameat2(staging_parent, job_id, quarantine_parent, job_id);
    if (status < 0) {
        result->rename_result = rename_error_name(errno);
        result->error_code = "QUARANTINE_PENDING";
        goto done;
    }
    result->rename_result = "RENAMED";
    result->quarantined = 1;
    result->mutation_count += 1;
#ifdef PUBLISHER_TEST_ANCESTOR_AFTER
    if (test_swap_ancestor(metadata, "quarantine") < 0) goto invalid;
#endif
    if (!quarantine_bindings_match(root, metadata, staging_parent, quarantine_parent) ||
        !destination_identity_matches(quarantine_parent, job_id, &source_identity)) {
        result->quarantined = 0;
        result->error_code = "QUARANTINE_PENDING";
        (void)sync_quarantine_parents(staging_parent, quarantine_parent, metadata, root);
        goto done;
    }
    if (sync_quarantine_parents(staging_parent, quarantine_parent, metadata, root) < 0) {
        result->quarantined = 0;
        result->error_code = "QUARANTINE_PENDING";
    }
    if (result->quarantined &&
        (!quarantine_bindings_match(root, metadata, staging_parent, quarantine_parent) ||
         !destination_identity_matches(quarantine_parent, job_id, &source_identity))) {
        result->quarantined = 0;
        result->error_code = "QUARANTINE_PENDING";
        (void)sync_quarantine_parents(staging_parent, quarantine_parent, metadata, root);
    }
    goto done;
invalid:
    result->error_code = "QUARANTINE_PENDING";
done:
    if (source >= 0) close(source);
    if (quarantine_parent >= 0) close(quarantine_parent);
    if (staging_parent >= 0) close(staging_parent);
    close(metadata);
    close(root);
    return result->quarantined ? 0 : 2;
}

static int recheck_operation(const char *root_path, const char *job_id, const char *branch, const char *sha, const char *target, struct operation_result *result) {
    int root = -1;
    int metadata = -1;
    int staging_parent = -1;
    int branch_parent = -1;
    int destination_parent = -1;
    int destination = -1;
    struct stat item;
    int parent_bindings_match;
    int destination_matches = 0;
    int structurally_complete = 0;
    int staging_state;
    int destination_state;
    result->available = 1;
    if (prepare_root(root_path, &root, &metadata) < 0) {
        result->error_code = "INVALID_ARGUMENT";
        return 2;
    }
    staging_parent = open_directory_at(metadata, "staging", 0, NULL);
    if (staging_parent < 0) goto invalid;
    staging_state = path_exists_at(staging_parent, job_id, &item);
    if (staging_state < 0 || (staging_state == 1 && (!S_ISDIR(item.st_mode) || S_ISLNK(item.st_mode)))) goto invalid;
    result->staging = staging_state == 1 ? "present" : "absent";
    branch_parent = open_directory_at(root, branch, 0, NULL);
    if (branch_parent < 0 && errno != ENOENT) goto invalid;
    if (branch_parent >= 0) {
        destination_parent = open_directory_at(branch_parent, sha, 0, NULL);
        if (destination_parent < 0 && errno != ENOENT) goto invalid;
    }
    if (destination_parent >= 0) {
        destination_state = path_exists_at(destination_parent, target, &item);
        if (destination_state < 0 || (destination_state == 1 && S_ISLNK(item.st_mode))) goto invalid;
        if (destination_state == 1 && S_ISDIR(item.st_mode)) {
            destination = openat(destination_parent, target, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
            if (destination < 0) goto invalid;
            structurally_complete = required_release_files(destination);
            destination_matches = destination_identity_matches(destination_parent, target, &item);
        }
    } else destination_state = 0;
    parent_bindings_match = directory_binding_matches(root, ".osi-image-builder", metadata) &&
        directory_binding_matches(metadata, "staging", staging_parent) &&
        (branch_parent < 0 || directory_binding_matches(root, branch, branch_parent)) &&
        (destination_parent < 0 || directory_binding_matches(branch_parent, sha, destination_parent));
    if (!parent_bindings_match) result->destination = "mismatched";
    else if (destination_state == 0) result->destination = "absent";
    else if (destination != -1 && structurally_complete && destination_matches && staging_state == 0) result->destination = "candidate";
    else result->destination = "mismatched";
    if (strcmp(result->destination, "mismatched") == 0) result->error_code = "UNVERIFIED_FINAL_PATH_BLOCKER";
    else if (strcmp(result->destination, "absent") == 0) result->error_code = "PUBLISH_RECOVERY_FAILED";
    if (destination >= 0) close(destination);
    if (destination_parent >= 0) close(destination_parent);
    if (branch_parent >= 0) close(branch_parent);
    close(staging_parent);
    close(metadata);
    close(root);
    return 0;
invalid:
    result->error_code = "INVALID_ARGUMENT";
    if (destination >= 0) close(destination);
    if (destination_parent >= 0) close(destination_parent);
    if (branch_parent >= 0) close(branch_parent);
    if (staging_parent >= 0) close(staging_parent);
    close(metadata);
    close(root);
    return 2;
}

static int remove_tree_at(int parent, const char *name) {
    int directory = openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (directory < 0) return unlinkat(parent, name, 0);
    {
        int duplicate = dup(directory);
        DIR *stream = duplicate < 0 ? NULL : fdopendir(duplicate);
        struct dirent *entry;
        if (stream == NULL) {
            if (duplicate >= 0) close(duplicate);
            close(directory);
            return -1;
        }
        errno = 0;
        while ((entry = readdir(stream)) != NULL) {
            if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0 && remove_tree_at(directory, entry->d_name) < 0) {
                closedir(stream);
                close(directory);
                return -1;
            }
            errno = 0;
        }
        if (errno != 0) {
            closedir(stream);
            close(directory);
            return -1;
        }
        if (closedir(stream) < 0) {
            close(directory);
            return -1;
        }
    }
    close(directory);
    return unlinkat(parent, name, AT_REMOVEDIR);
}

static int create_self_test_job(int staging, const char *name) {
    int job = open_directory_at(staging, name, 1, NULL);
    int file;
    if (job < 0) return -1;
    file = openat(job, "payload", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (file < 0 || write(file, "image", 5) != 5 || fsync(file) < 0) {
        if (file >= 0) close(file);
        close(job);
        return -1;
    }
    close(file);
    if (fsync(job) < 0) {
        close(job);
        return -1;
    }
    close(job);
    return 0;
}

static int self_test(void) {
    char scratch_template[] = "/tmp/osi-image-publish-self-test-XXXXXX";
    char *scratch = mkdtemp(scratch_template);
    int temporary_parent = -1;
    struct operation_result result = { 0 };
    int code = 2;
    int capability_directory = open("/tmp", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    int capability = capability_directory < 0 ? -1 : publisher_capability_available(capability_directory);
    if (capability_directory >= 0) close(capability_directory);
    if (capability == 0) return fail_result("PUBLISHER_UNSUPPORTED", 0, 0);
    if (capability < 0) return fail_result("PUBLISHER_SELF_TEST_FAILED", 1, 0);
    if (scratch == NULL) return fail_result("PUBLISHER_UNSUPPORTED", 0, 0);
    temporary_parent = open("/tmp", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (temporary_parent < 0) {
        if (rmdir(scratch) < 0) return fail_result("PUBLISHER_SELF_TEST_FAILED", 1, 0);
        return fail_result("PUBLISHER_UNSUPPORTED", 0, 0);
    }
    {
        int root = open_absolute_directory(scratch);
        int metadata = root < 0 ? -1 : open_directory_at(root, ".osi-image-builder", 1, NULL);
        int staging = metadata < 0 ? -1 : open_directory_at(metadata, "staging", 1, NULL);
        int quarantine = metadata < 0 ? -1 : open_directory_at(metadata, "quarantine", 1, NULL);
        int job = staging < 0 ? -1 : create_self_test_job(staging, "job-self-test");
        if (root >= 0 && metadata >= 0 && staging >= 0 && quarantine >= 0 && job >= 0) {
            struct operation_result link_result = { 0 };
            int checks_ok = 1;
            int link_code = symlinkat("/tmp", staging, "job-link");
            if (link_code != 0 || publish_operation(scratch, "job-link", "self-test", "0123456789abcdef0123456789abcdef01234567", "rpi-5", &link_result) != 2 || link_result.error_code == NULL || strcmp(link_result.error_code, "PUBLISH_FAILED") != 0) checks_ok = 0;
            (void)unlinkat(staging, "job-link", 0);
            if (safe_identifier("../escape", MAX_JOB_ID) || safe_branch("../escape")) checks_ok = 0;
            close(quarantine); close(staging); close(metadata); close(root);
            if (checks_ok) code = publish_operation(scratch, "job-self-test", "self-test", "0123456789abcdef0123456789abcdef01234567", "rpi-5", &result);
            if (code == 0 && result.published == 1) {
                int second_root = open_absolute_directory(scratch);
                int second_metadata = second_root < 0 ? -1 : open_directory_at(second_root, ".osi-image-builder", 0, NULL);
                int second_staging = second_metadata < 0 ? -1 : open_directory_at(second_metadata, "staging", 0, NULL);
                struct operation_result collision = { 0 };
                if (second_staging < 0 || create_self_test_job(second_staging, "job-collision") < 0) code = 2;
                else code = publish_operation(scratch, "job-collision", "self-test", "0123456789abcdef0123456789abcdef01234567", "rpi-5", &collision);
                if (second_staging >= 0) close(second_staging);
                if (second_metadata >= 0) close(second_metadata);
                if (second_root >= 0) close(second_root);
                if (code == 2 && collision.error_code != NULL && strcmp(collision.error_code, "OUTPUT_COLLISION") == 0) code = 0;
                if (code == 0) {
                    int quarantine_root = open_absolute_directory(scratch);
                    int quarantine_metadata = quarantine_root < 0 ? -1 : open_directory_at(quarantine_root, ".osi-image-builder", 0, NULL);
                    int quarantine_staging = quarantine_metadata < 0 ? -1 : open_directory_at(quarantine_metadata, "staging", 0, NULL);
                    struct operation_result quarantine_result = { 0 };
                    if (quarantine_staging < 0 || create_self_test_job(quarantine_staging, "job-quarantine") < 0) code = 2;
                    else if (quarantine_operation(scratch, "job-quarantine", &quarantine_result) != 0 || quarantine_result.quarantined != 1) code = 2;
                    if (quarantine_staging >= 0) close(quarantine_staging);
                    if (quarantine_metadata >= 0) close(quarantine_metadata);
                    if (quarantine_root >= 0) close(quarantine_root);
                }
            }
        } else {
            if (quarantine >= 0) close(quarantine);
            if (staging >= 0) close(staging);
            if (metadata >= 0) close(metadata);
            if (root >= 0) close(root);
        }
    }
    if (remove_tree_at(temporary_parent, strrchr(scratch, '/') + 1) < 0) code = 2;
    close(temporary_parent);
    if (code != 0) return fail_result("PUBLISHER_SELF_TEST_FAILED", 1, 0);
    {
        struct operation_result success = { .available = 1, .mutation_count = 0, .published = 0, .quarantined = 0, .self_test = 1, .error_code = NULL, .destination = NULL, .staging = NULL };
        print_result(&success);
    }
    return 0;
}

int main(int argc, char **argv) {
    const char *root = NULL;
    const char *job_id = NULL;
    const char *branch = NULL;
    const char *sha = NULL;
    const char *target = NULL;
    struct operation_result result = { .available = 1, .mutation_count = 0, .published = 0, .quarantined = 0, .self_test = 0, .error_code = NULL, .destination = NULL, .staging = NULL };
    int code;
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("{\"available\":true,\"version\":");
        json_string(PUBLISHER_VERSION);
        printf(",\"sourceSha256\":");
        json_string(PUBLISHER_SOURCE_SHA256);
        puts("}");
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
        return self_test();
    }
    if (argc == 12 && strcmp(argv[1], "publish") == 0 &&
        strcmp(argv[2], "--root") == 0 && strcmp(argv[4], "--job-id") == 0 &&
        strcmp(argv[6], "--branch") == 0 && strcmp(argv[8], "--sha") == 0 && strcmp(argv[10], "--target") == 0) {
        root = argv[3]; job_id = argv[5]; branch = argv[7]; sha = argv[9]; target = argv[11];
        if (!safe_absolute_path(root) || !safe_identifier(job_id, MAX_JOB_ID) || !safe_branch(branch) || !is_hex_string(sha, MAX_SHA) || !safe_target(target)) return fail_result("INVALID_ARGUMENT", 1, 0);
        code = publish_operation(root, job_id, branch, sha, target, &result);
        print_result(&result);
        return code;
    }
    if (argc == 6 && strcmp(argv[1], "quarantine") == 0 && strcmp(argv[2], "--root") == 0 && strcmp(argv[4], "--job-id") == 0) {
        root = argv[3]; job_id = argv[5];
        if (!safe_absolute_path(root) || !safe_identifier(job_id, MAX_JOB_ID)) return fail_result("INVALID_ARGUMENT", 1, 0);
        code = quarantine_operation(root, job_id, &result);
        print_result(&result);
        return code;
    }
    if (argc == 12 && strcmp(argv[1], "recheck") == 0 &&
        strcmp(argv[2], "--root") == 0 && strcmp(argv[4], "--job-id") == 0 &&
        strcmp(argv[6], "--branch") == 0 && strcmp(argv[8], "--sha") == 0 && strcmp(argv[10], "--target") == 0) {
        root = argv[3]; job_id = argv[5]; branch = argv[7]; sha = argv[9]; target = argv[11];
        if (!safe_absolute_path(root) || !safe_identifier(job_id, MAX_JOB_ID) || !safe_branch(branch) || !is_hex_string(sha, MAX_SHA) || !safe_target(target)) return fail_result("INVALID_ARGUMENT", 1, 0);
        code = recheck_operation(root, job_id, branch, sha, target, &result);
        print_result(&result);
        return code;
    }
    return fail_result("INVALID_ARGUMENT", 1, 0);
}
