#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif

static int rename_no_replace(const char *source, const char *destination) {
#if defined(__linux__) && defined(SYS_renameat2)
    if (syscall(SYS_renameat2, AT_FDCWD, source, AT_FDCWD, destination, RENAME_NOREPLACE) == 0) {
        return 0;
    }
    fprintf(stderr, "rename-noreplace failed: %s\n", strerror(errno));
    return 1;
#else
    (void)source;
    (void)destination;
    fprintf(stderr, "rename-noreplace is unavailable\n");
    return 2;
#endif
}

static int hold_lock(const char *path) {
    int descriptor = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (descriptor < 0) {
        fprintf(stderr, "install lock open failed: %s\n", strerror(errno));
        return 1;
    }

    struct stat status;
    if (fstat(descriptor, &status) < 0 || !S_ISREG(status.st_mode) || status.st_nlink != 1) {
        fprintf(stderr, "install lock is not a private regular file\n");
        close(descriptor);
        return 1;
    }
    if (flock(descriptor, LOCK_EX | LOCK_NB) < 0) {
        int failure = errno;
        fprintf(stderr, "another installer holds the install lock\n");
        close(descriptor);
        return failure == EWOULDBLOCK ? 3 : 1;
    }
    if (write(STDOUT_FILENO, "LOCKED\n", 7) != 7) {
        fprintf(stderr, "install lock readiness write failed\n");
        close(descriptor);
        return 1;
    }

    char buffer[64];
    for (;;) {
        ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (count == 0) break;
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) {
            fprintf(stderr, "install lock control read failed: %s\n", strerror(errno));
            close(descriptor);
            return 1;
        }
    }
    if (flock(descriptor, LOCK_UN) < 0) {
        fprintf(stderr, "install lock release failed: %s\n", strerror(errno));
        close(descriptor);
        return 1;
    }
    return close(descriptor) == 0 ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc == 4 && strcmp(argv[1], "rename-noreplace") == 0) {
        return rename_no_replace(argv[2], argv[3]);
    }
    if (argc == 3 && strcmp(argv[1], "hold-lock") == 0) {
        return hold_lock(argv[2]);
    }
    fprintf(stderr, "usage: installer-fs-helper rename-noreplace SOURCE DESTINATION | hold-lock PATH\n");
    return 2;
}
