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
static char probe[128], probe_content[256];
static size_t probe_size;
static int aborted;

static int record(const char *message)
{
    int fd = open(receipt, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd < 0) return -errno;
    ssize_t n = write(fd, message, strlen(message)); close(fd);
    return n == (ssize_t)strlen(message) ? 0 : -EIO;
}

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
    else if (!strcmp(path, "/upper")) { st->st_mode = S_IFDIR | 0700; st->st_nlink = 2; st->st_ino = 4; }
    else if (!strcmp(path, "/.fs_state")) { st->st_mode = S_IFLNK | 0777; st->st_nlink = 1; st->st_size = 1; st->st_ino = 2; }
    else if (!strcmp(path, "/fault")) { st->st_mode = S_IFREG | 0600; st->st_nlink = 1; st->st_size = sizeof(content); st->st_ino = 3; st->st_blksize = 4096; st->st_blocks = 8; }
    else if (probe[0] && !strcmp(path, probe)) { st->st_mode = S_IFREG | 0600; st->st_nlink = 1; st->st_size = probe_size; st->st_ino = 5; }
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
    (void)fi; return strcmp(path, "/fault") && (!probe[0] || strcmp(path, probe)) ? -ENOENT : 0;
}
static int open_dir(const char *path, struct fuse_file_info *fi)
{
    (void)fi; return strcmp(path, "/") && strcmp(path, "/upper") ? -ENOTDIR : 0;
}
static int create_file(const char *path, mode_t mode, struct fuse_file_info *fi)
{
    (void)mode; (void)fi;
    const char prefix[] = "/upper/.osi-rootfs-grow-probe-";
    if (strncmp(path, prefix, sizeof(prefix) - 1)) return -EACCES;
    /* Simulate the completed JBD2 abort: syncfs has no writeback error,
     * but starting the next journal handle returns EROFS. Not real ext4.
     */
    if (aborted) { record("probe create EROFS (simulated aborted journal)\n"); return -EROFS; }
    if (probe[0]) return -EEXIST;
    if (strlen(path) >= sizeof(probe)) return -ENAMETOOLONG;
    strcpy(probe, path); probe_size = 0;
    return record("probe create OK\n");
}
static int unlink_file(const char *path)
{
    if (!probe[0] || strcmp(path, probe)) return -ENOENT;
    if (fail == 5) { record("probe unlink EROFS\n"); return -EROFS; }
    probe[0] = '\0'; return record("probe unlink OK\n");
}
static int read_file(const char *path, char *buffer, size_t size, off_t offset, struct fuse_file_info *fi)
{
    (void)fi;
    if (probe[0] && !strcmp(path, probe)) {
        if (offset < 0 || offset >= (off_t)probe_size) return 0;
        if (size > probe_size - offset) size = probe_size - offset;
        memcpy(buffer, probe_content + offset, size); return (int)size;
    }
    if (offset >= (off_t)sizeof(content)) return 0;
    if (size > sizeof(content) - offset) size = sizeof(content) - offset;
    memcpy(buffer, content + offset, size); return (int)size;
}
static int write_file(const char *path, const char *buffer, size_t size, off_t offset, struct fuse_file_info *fi)
{
    (void)fi;
    if (probe[0] && !strcmp(path, probe)) {
        if (fail == 3) { record("probe write EIO\n"); return -EIO; }
        if (offset < 0 || size > sizeof(probe_content) || (size_t)offset > sizeof(probe_content) - size) return -EFBIG;
        memcpy(probe_content + offset, buffer, size);
        if ((size_t)offset + size > probe_size) probe_size = offset + size;
        if (record("probe write OK\n")) return -EIO;
        return (int)size;
    }
    if (record(fail == 1 ? "writeback EIO\n" : "writeback OK\n")) return -EIO;
    if (fail == 1) return -EIO;
    if (fail == 2) aborted = 1;
    if (offset < 0 || size > sizeof(content) || (size_t)offset > sizeof(content) - size) return -EFBIG;
    memcpy(content + offset, buffer, size); return (int)size;
}
static int fsync_file(const char *path, int datasync, struct fuse_file_info *fi)
{
    (void)datasync; (void)fi;
    if (fail == 4 && strcmp(path, "/fault")) { record("probe file fsync EIO\n"); return -EIO; }
    return !strcmp(path, "/fault") ? 0 : record("probe file fsync OK\n");
}
static int fsync_dir(const char *path, int datasync, struct fuse_file_info *fi)
{
    (void)path; (void)datasync; (void)fi;
    if (fail == 6) { record("probe directory fsync EIO\n"); return -EIO; }
    return record("probe directory fsync OK\n");
}
static const struct fuse_operations ops = {
    .init = init, .getattr = attributes, .readlink = state_link,
    .open = open_file, .read = read_file, .write = write_file, .fsync = fsync_file,
    .create = create_file, .unlink = unlink_file, .opendir = open_dir, .fsyncdir = fsync_dir
};
int main(int argc, char **argv)
{
    if (argc != 4) return 2;
    receipt = argv[2]; fail = atoi(argv[3]);
    char *args[] = { argv[0], "-f", "-s", argv[1] };
    return fuse_main(4, args, &ops, NULL);
}
