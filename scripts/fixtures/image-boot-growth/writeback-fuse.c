/* SPDX-License-Identifier: MIT
 * Disposable writeback-cache filesystem. write(2) dirties a cached page;
 * the later FUSE writeback callback can return EIO. No block device is used.
 */
#define FUSE_USE_VERSION 31
#include <fuse.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>

static const char *receipt;
static int fail;
static char content[4096];

static void *init(struct fuse_conn_info *conn, struct fuse_config *cfg)
{
    if (!(conn->capable & FUSE_CAP_WRITEBACK_CACHE)) abort();
    conn->want |= FUSE_CAP_WRITEBACK_CACHE;
    cfg->kernel_cache = 1;
    cfg->use_ino = 1;
    return NULL;
}
static int attributes(const char *path, struct stat *st, struct fuse_file_info *fi)
{
    (void)fi; memset(st, 0, sizeof(*st)); st->st_uid = getuid(); st->st_gid = getgid();
    if (!strcmp(path, "/")) { st->st_mode = S_IFDIR | 0700; st->st_nlink = 2; st->st_ino = 1; }
    else if (!strcmp(path, "/.fs_state")) { st->st_mode = S_IFLNK | 0777; st->st_nlink = 1; st->st_size = 1; st->st_ino = 2; }
    else if (!strcmp(path, "/fault")) { st->st_mode = S_IFREG | 0600; st->st_nlink = 1; st->st_size = sizeof(content); st->st_ino = 3; st->st_blksize = 4096; st->st_blocks = 8; }
    else return -ENOENT;
    return 0;
}
static int state_link(const char *path, char *buffer, size_t size)
{
    if (strcmp(path, "/.fs_state")) return -EINVAL;
    snprintf(buffer, size, "2"); return 0;
}
static int open_file(const char *path, struct fuse_file_info *fi)
{
    (void)fi; return strcmp(path, "/fault") ? -ENOENT : 0;
}
static int read_file(const char *path, char *buffer, size_t size, off_t offset, struct fuse_file_info *fi)
{
    (void)path; (void)fi;
    if (offset >= (off_t)sizeof(content)) return 0;
    if (size > sizeof(content) - offset) size = sizeof(content) - offset;
    memcpy(buffer, content + offset, size); return (int)size;
}
static int write_file(const char *path, const char *buffer, size_t size, off_t offset, struct fuse_file_info *fi)
{
    (void)path; (void)fi;
    int fd = open(receipt, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd < 0) return -errno;
    const char *message = fail ? "writeback EIO\n" : "writeback OK\n";
    ssize_t n = write(fd, message, strlen(message)); close(fd);
    if (n != (ssize_t)strlen(message)) return -EIO;
    if (fail) return -EIO;
    if (offset < 0 || size > sizeof(content) || (size_t)offset > sizeof(content) - size) return -EFBIG;
    memcpy(content + offset, buffer, size); return (int)size;
}
static int fsync_file(const char *path, int datasync, struct fuse_file_info *fi)
{
    (void)path; (void)datasync; (void)fi; return 0;
}
static const struct fuse_operations ops = {
    .init = init, .getattr = attributes, .readlink = state_link,
    .open = open_file, .read = read_file, .write = write_file, .fsync = fsync_file
};
int main(int argc, char **argv)
{
    if (argc != 4) return 2;
    receipt = argv[2]; fail = atoi(argv[3]);
    char *args[] = { argv[0], "-f", "-s", argv[1] };
    return fuse_main(4, args, &ops, NULL);
}
