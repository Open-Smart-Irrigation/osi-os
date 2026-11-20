/* SPDX-License-Identifier: MIT
 * Hold the overlay's writeback-error cursor before initialization writes.
 * S96 must never reboot after any observed error, including an earlier sync.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <stdint.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct request { uint64_t dev, ino; char command; };

static int retained(int fd)
{
    if (fd < 0 || fd >= 3) return fd;
    int copy = fcntl(fd, F_DUPFD_CLOEXEC, 3);
    int saved = errno; close(fd); errno = saved; return copy;
}

static int transfer(int fd, void *data, size_t size, int sending)
{
    char *p = data;
    while (size) {
        ssize_t n = sending ? send(fd, p, size, MSG_NOSIGNAL) : recv(fd, p, size, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { if (!n) errno = EPIPE; return -1; }
        p += n; size -= (size_t)n;
    }
    return 0;
}

static void timeout(int fd)
{
    struct timeval t = { .tv_sec = 5 };
    (void)setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &t, sizeof(t));
    (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &t, sizeof(t));
}

static int rpc(const struct sockaddr_un *address, struct request *req)
{
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int32_t result;
    if (fd < 0) return -1;
    timeout(fd);
    if (connect(fd, (const struct sockaddr *)address, sizeof(*address)) ||
        transfer(fd, req, sizeof(*req), 1) || transfer(fd, &result, sizeof(result), 0)) {
        int saved = errno; close(fd); errno = saved; return -1;
    }
    close(fd);
    if (result) { errno = result; return -1; }
    return 0;
}

static void serve(int listener, int overlay, const struct stat *identity)
{
    int failed = 0;
    (void)setsid();
    int null = open("/dev/null", O_RDWR);
    if (null < 0) _exit(1);
    for (int n = 0; n < 3; n++) if (dup2(null, n) < 0) _exit(1);
    for (int n = 3; n < 1024; n++) if (n != listener && n != overlay) close(n);
    for (;;) {
        int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
        if (client < 0) { if (errno == EINTR) continue; _exit(1); }
        timeout(client);
        struct request req = {0};
        struct ucred peer;
        socklen_t length = sizeof(peer);
        int32_t result = 0;
        if (getsockopt(client, SOL_SOCKET, SO_PEERCRED, &peer, &length) || peer.uid != getuid()) result = EPERM;
        else if (transfer(client, &req, sizeof(req), 0)) result = EPROTO;
        else if (req.command != 'Q' && (req.dev != (uint64_t)identity->st_dev || req.ino != (uint64_t)identity->st_ino)) result = ESTALE;
        else if (req.command == 'F') {
            if (!failed && syncfs(overlay)) failed = errno;
            result = failed;
        } else if (req.command == 'C') result = failed;
        else if (req.command != 'Q') result = EINVAL;
        int quit = !result && req.command == 'Q';
        if (quit) { close(overlay); close(listener); }
        (void)transfer(client, &result, sizeof(result), 1);
        close(client);
        if (quit) _exit(0);
    }
}

int main(int argc, char **argv)
{
    if (argc != 4 || (strcmp(argv[1], "arm") && strcmp(argv[1], "check") && strcmp(argv[1], "flush") && strcmp(argv[1], "stop"))) {
        fprintf(stderr, "usage: osi-rootfs-flush arm|check|flush|stop DIRECTORY SOCKET\n");
        return 2;
    }
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    if (strlen(argv[3]) >= sizeof(address.sun_path)) { errno = ENAMETOOLONG; goto error; }
    strcpy(address.sun_path, argv[3]);
    struct stat identity;
    struct request req = { .command = !strcmp(argv[1], "flush") ? 'F' : !strcmp(argv[1], "stop") ? 'Q' : 'C' };
    if (req.command != 'Q') {
        if (stat(argv[2], &identity)) goto error;
        if (!S_ISDIR(identity.st_mode)) { errno = ENOTDIR; goto error; }
        req.dev = (uint64_t)identity.st_dev; req.ino = (uint64_t)identity.st_ino;
    }
    if (strcmp(argv[1], "arm")) {
        if (rpc(&address, &req)) goto error;
        return 0;
    }
    struct stat socket_info;
    if (!lstat(argv[3], &socket_info)) {
        /* Never reset a lost or poisoned cursor on the same boot. */
        if (!S_ISSOCK(socket_info.st_mode)) { errno = EEXIST; goto error; }
        if (rpc(&address, &req)) goto error;
        return 0;
    }
    if (errno != ENOENT) goto error;
    int overlay = retained(open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC));
    if (overlay < 0) goto error;
    if (fstat(overlay, &identity)) { close(overlay); goto error; }
    int listener = retained(socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0));
    if (listener < 0) { close(overlay); goto error; }
    umask(077);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 4)) {
        int saved = errno; close(listener); close(overlay); errno = saved; goto error;
    }
    pid_t child = fork();
    if (child < 0) { close(listener); close(overlay); goto error; }
    if (!child) serve(listener, overlay, &identity);
    close(listener); close(overlay);
    /* The descriptor and listener exist before this acknowledgement. */
    return 0;
error:
    perror("osi-rootfs-flush");
    return 1;
}
