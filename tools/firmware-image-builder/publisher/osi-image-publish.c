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

struct operation_result {
    int available;
    int mutation_count;
    int published;
    int quarantined;
    int self_test;
    const char *error_code;
    const char *destination;
    const char *staging;
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
        fputs(",\"sourceRelativePath\":", stdout);
        json_string(result->source_relative);
    }
    if (result->destination_relative[0] != '\0') {
        fputs(",\"destinationRelativePath\":", stdout);
        json_string(result->destination_relative);
    }
    if (result->published || result->quarantined) fputs(",\"renameResult\":\"RENAME_NOREPLACE\"", stdout);
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
    if (length == 0 || length >= maximum || value[0] == '.' || value[0] == '-') return 0;
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
    if (length == 0 || length >= MAX_BRANCH || value[0] == '%' || value[length - 1] == '%') return 0;
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

static int open_directory_at(int parent, const char *name, int create) {
    int result;
    if (create && mkdirat(parent, name, 0750) < 0 && errno != EEXIST) return -1;
    result = openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    return result;
}

static int same_device(int first, int second) {
    struct stat first_stat;
    struct stat second_stat;
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
    while ((entry = readdir(stream)) != NULL) {
        struct stat item;
        int child;
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (fstatat(directory, entry->d_name, &item, AT_SYMLINK_NOFOLLOW) < 0 || S_ISLNK(item.st_mode) || S_ISBLK(item.st_mode)) {
            closedir(stream);
            return -1;
        }
        if (S_ISDIR(item.st_mode)) {
            child = openat(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
            if (child < 0 || fsync_tree(child) < 0) {
                if (child >= 0) close(child);
                closedir(stream);
                return -1;
            }
            close(child);
        } else if (S_ISREG(item.st_mode)) {
            child = openat(directory, entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
            if (child < 0 || fsync(child) < 0) {
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

static int publisher_capability_available(void) {
    int status = publisher_renameat2(-1, "publisher-capability-probe", -1, "publisher-capability-probe-destination");
    (void)status;
    return errno != ENOSYS && errno != EOPNOTSUPP;
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
    if (lstat(root_path, &root_stat) < 0 || S_ISBLK(root_stat.st_mode) || !S_ISDIR(root_stat.st_mode) || S_ISLNK(root_stat.st_mode)) return -1;
    *root = open_absolute_directory(root_path);
    if (*root < 0) return -1;
    *metadata = open_directory_at(*root, ".osi-image-builder", 0);
    if (*metadata < 0) {
        close(*root);
        return -1;
    }
    return 0;
}

static int publish_operation(const char *root_path, const char *job_id, const char *branch, const char *sha, const char *target, struct operation_result *result) {
    int root = -1;
    int metadata = -1;
    int staging_parent = -1;
    int source = -1;
    int branch_parent = -1;
    int destination_parent = -1;
    int status;
    result->available = 1;
    if (prepare_root(root_path, &root, &metadata) < 0) {
        result->error_code = "INVALID_ARGUMENT";
        return 2;
    }
    if (!publisher_capability_available()) {
        result->available = 0;
        result->error_code = "PUBLISHER_UNSUPPORTED";
        close(metadata);
        close(root);
        return 2;
    }
    staging_parent = open_directory_at(metadata, "staging", 0);
    if (staging_parent < 0) goto invalid;
    source = openat(staging_parent, job_id, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (source < 0) goto invalid;
    branch_parent = open_directory_at(root, branch, 1);
    if (branch_parent < 0) goto invalid;
    destination_parent = open_directory_at(branch_parent, sha, 1);
    if (destination_parent < 0) goto invalid;
    if (!same_device(source, destination_parent) || fsync_tree(source) < 0 || fsync(staging_parent) < 0) {
        result->available = 1;
        result->error_code = "STAGING_FILESYSTEM_MISMATCH";
        goto done;
    }
    status = publisher_renameat2(staging_parent, job_id, destination_parent, target);
    if (status < 0) {
        if (errno == EEXIST) result->error_code = "OUTPUT_COLLISION";
        else if (errno == ENOSYS || errno == EOPNOTSUPP || errno == EXDEV) {
            result->available = 0;
            result->error_code = "PUBLISHER_UNSUPPORTED";
        } else result->error_code = "PUBLISH_FAILED";
        goto done;
    }
    result->published = 1;
    result->mutation_count = 1;
    (void)snprintf(result->source_relative, sizeof(result->source_relative), ".osi-image-builder/staging/%s", job_id);
    (void)snprintf(result->destination_relative, sizeof(result->destination_relative), "%s/%s/%s", branch, sha, target);
    if (fsync(destination_parent) < 0 || fsync(branch_parent) < 0 || fsync(root) < 0) {
        result->published = 0;
        result->error_code = "PUBLISH_FAILED";
        goto done;
    }
    goto done;
invalid:
    result->error_code = "INVALID_ARGUMENT";
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
    int status;
    result->available = 1;
    if (prepare_root(root_path, &root, &metadata) < 0) {
        result->error_code = "INVALID_ARGUMENT";
        return 2;
    }
    if (!publisher_capability_available()) {
        result->available = 0;
        result->error_code = "PUBLISHER_UNSUPPORTED";
        close(metadata);
        close(root);
        return 2;
    }
    staging_parent = open_directory_at(metadata, "staging", 0);
    quarantine_parent = open_directory_at(metadata, "quarantine", 1);
    if (staging_parent < 0 || quarantine_parent < 0) goto invalid;
    source = openat(staging_parent, job_id, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (source < 0 || fsync_tree(source) < 0 || !same_device(source, quarantine_parent)) goto invalid;
    status = publisher_renameat2(staging_parent, job_id, quarantine_parent, job_id);
    if (status < 0) {
        if (errno == EEXIST) result->error_code = "QUARANTINE_PENDING";
        else if (errno == ENOSYS || errno == EOPNOTSUPP || errno == EXDEV) {
            result->available = 0;
            result->error_code = "PUBLISHER_UNSUPPORTED";
        } else result->error_code = "PUBLISH_FAILED";
        goto done;
    }
    result->quarantined = 1;
    result->mutation_count = 1;
    if (fsync(quarantine_parent) < 0 || fsync(root) < 0) {
        result->quarantined = 0;
        result->error_code = "PUBLISH_FAILED";
    }
    goto done;
invalid:
    result->error_code = "INVALID_ARGUMENT";
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
    int staging_state;
    int destination_state;
    result->available = 1;
    if (prepare_root(root_path, &root, &metadata) < 0) {
        result->error_code = "INVALID_ARGUMENT";
        return 2;
    }
    staging_parent = open_directory_at(metadata, "staging", 0);
    if (staging_parent < 0) goto invalid;
    staging_state = path_exists_at(staging_parent, job_id, &item);
    if (staging_state < 0 || (staging_state == 1 && (!S_ISDIR(item.st_mode) || S_ISLNK(item.st_mode)))) goto invalid;
    result->staging = staging_state == 1 ? "present" : "absent";
    branch_parent = open_directory_at(root, branch, 0);
    if (branch_parent < 0 && errno != ENOENT) goto invalid;
    if (branch_parent >= 0) {
        destination_parent = open_directory_at(branch_parent, sha, 0);
        if (destination_parent < 0 && errno != ENOENT) goto invalid;
    }
    if (destination_parent >= 0) {
        destination_state = path_exists_at(destination_parent, target, &item);
        if (destination_state < 0 || (destination_state == 1 && S_ISLNK(item.st_mode))) goto invalid;
        if (destination_state == 1 && S_ISDIR(item.st_mode)) {
            destination = openat(destination_parent, target, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
            if (destination < 0) goto invalid;
        }
    } else destination_state = 0;
    if (destination_state == 0) result->destination = "absent";
    else if (destination != -1 && required_release_files(destination)) result->destination = "complete";
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
        while ((entry = readdir(stream)) != NULL) {
            if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0 && remove_tree_at(directory, entry->d_name) < 0) {
                closedir(stream);
                close(directory);
                return -1;
            }
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
    int job = open_directory_at(staging, name, 1);
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
    if (!publisher_capability_available()) return fail_result("PUBLISHER_UNSUPPORTED", 0, 0);
    if (scratch == NULL) return fail_result("PUBLISHER_UNSUPPORTED", 0, 0);
    temporary_parent = open("/tmp", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (temporary_parent < 0) return fail_result("PUBLISHER_UNSUPPORTED", 0, 0);
    {
        int root = open_absolute_directory(scratch);
        int metadata = root < 0 ? -1 : open_directory_at(root, ".osi-image-builder", 1);
        int staging = metadata < 0 ? -1 : open_directory_at(metadata, "staging", 1);
        int quarantine = metadata < 0 ? -1 : open_directory_at(metadata, "quarantine", 1);
        int job = staging < 0 ? -1 : create_self_test_job(staging, "job-self-test");
        if (root >= 0 && metadata >= 0 && staging >= 0 && quarantine >= 0 && job >= 0) {
            struct operation_result link_result = { 0 };
            int checks_ok = 1;
            int link_code = symlinkat("/tmp", staging, "job-link");
            if (link_code != 0 || publish_operation(scratch, "job-link", "self-test", "0123456789abcdef0123456789abcdef01234567", "rpi-5", &link_result) != 2 || link_result.error_code == NULL || strcmp(link_result.error_code, "INVALID_ARGUMENT") != 0) checks_ok = 0;
            (void)unlinkat(staging, "job-link", 0);
            if (safe_identifier("../escape", MAX_JOB_ID) || safe_branch("../escape")) checks_ok = 0;
            close(quarantine); close(staging); close(metadata); close(root);
            if (checks_ok) code = publish_operation(scratch, "job-self-test", "self-test", "0123456789abcdef0123456789abcdef01234567", "rpi-5", &result);
            if (code == 0 && result.published == 1) {
                int second_root = open_absolute_directory(scratch);
                int second_metadata = second_root < 0 ? -1 : open_directory_at(second_root, ".osi-image-builder", 0);
                int second_staging = second_metadata < 0 ? -1 : open_directory_at(second_metadata, "staging", 0);
                struct operation_result collision;
                if (second_staging < 0 || create_self_test_job(second_staging, "job-collision") < 0) code = 2;
                else code = publish_operation(scratch, "job-collision", "self-test", "0123456789abcdef0123456789abcdef01234567", "rpi-5", &collision);
                if (second_staging >= 0) close(second_staging);
                if (second_metadata >= 0) close(second_metadata);
                if (second_root >= 0) close(second_root);
                if (code == 2 && collision.error_code != NULL && strcmp(collision.error_code, "OUTPUT_COLLISION") == 0) code = 0;
            }
        } else {
            if (quarantine >= 0) close(quarantine);
            if (staging >= 0) close(staging);
            if (metadata >= 0) close(metadata);
            if (root >= 0) close(root);
        }
    }
    (void)remove_tree_at(temporary_parent, strrchr(scratch, '/') + 1);
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
