/* SPDX-License-Identifier: MIT
 * Disposable kernel writeback-cache filesystem; no block device is used.
 * Inode callbacks retain an unlinked probe through the final syncfs.
 */
#define FUSE_USE_VERSION 31
#include <fuse_lowlevel.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>

enum { ROOT = 1, READY, FAULT, UPPER, PROBE };
static const char *receipt;
static int fail, aborted, probe_exists;
static char content[4096], probe_content[256], probe_name[128];
static size_t probe_size;

static int record(const char *message)
{
    int fd = open(receipt, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd < 0) return errno;
    ssize_t n = write(fd, message, strlen(message)); close(fd);
    return n == (ssize_t)strlen(message) ? 0 : EIO;
}
static void attributes(fuse_ino_t ino, struct stat *st)
{
    memset(st, 0, sizeof(*st)); st->st_uid = getuid(); st->st_gid = getgid();
    st->st_ino = ino; st->st_nlink = 1; st->st_blksize = 4096;
    if (ino == ROOT || ino == UPPER) { st->st_mode = S_IFDIR | 0700; st->st_nlink = 2; }
    else if (ino == READY) { st->st_mode = S_IFLNK | 0777; st->st_size = 1; }
    else {
        st->st_mode = S_IFREG | 0600;
        st->st_size = ino == FAULT ? sizeof(content) : probe_size;
        st->st_nlink = ino == PROBE && !probe_exists ? 0 : 1;
        st->st_blocks = (st->st_size + 511) / 512;
    }
}
static void entry(fuse_ino_t ino, struct fuse_entry_param *e)
{
    memset(e, 0, sizeof(*e)); e->ino = ino; e->generation = 1;
    attributes(ino, &e->attr);
}
static void initialize(void *data, struct fuse_conn_info *conn)
{
    (void)data;
    if (!(conn->capable & FUSE_CAP_WRITEBACK_CACHE)) abort();
    conn->want |= FUSE_CAP_WRITEBACK_CACHE;
}
static void lookup(fuse_req_t req, fuse_ino_t parent, const char *name)
{
    fuse_ino_t ino = 0;
    if (parent == ROOT) {
        if (!strcmp(name, ".fs_state")) ino = READY;
        else if (!strcmp(name, "fault")) ino = FAULT;
        else if (!strcmp(name, "upper")) ino = UPPER;
    } else if (parent == UPPER && probe_exists && !strcmp(name, probe_name)) ino = PROBE;
    if (!ino) { fuse_reply_err(req, ENOENT); return; }
    struct fuse_entry_param e; entry(ino, &e); fuse_reply_entry(req, &e);
}
static void getattr_inode(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi)
{
    (void)fi; struct stat st; attributes(ino, &st); fuse_reply_attr(req, &st, 0);
}
static void setattr_inode(fuse_req_t req, fuse_ino_t ino, struct stat *attr, int valid, struct fuse_file_info *fi)
{
    (void)fi;
    /* Writeback-cache fsync also flushes timestamps for unlinked inodes. */
    if (ino == PROBE && (valid & FUSE_SET_ATTR_SIZE)) {
        if (attr->st_size < 0 || attr->st_size > (off_t)sizeof(probe_content)) { fuse_reply_err(req, EFBIG); return; }
        probe_size = (size_t)attr->st_size;
    }
    struct stat st; attributes(ino, &st); fuse_reply_attr(req, &st, 0);
}
static void readlink_inode(fuse_req_t req, fuse_ino_t ino)
{
    if (ino != READY) fuse_reply_err(req, EINVAL); else fuse_reply_readlink(req, "2");
}
static void open_inode(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi)
{
    fi->fh = ino; fi->keep_cache = 1; fuse_reply_open(req, fi);
}
static void create_inode(fuse_req_t req, fuse_ino_t parent, const char *name, mode_t mode, struct fuse_file_info *fi)
{
    (void)mode;
    const char prefix[] = ".osi-rootfs-grow-probe-";
    if (parent != UPPER || strncmp(name, prefix, sizeof(prefix) - 1)) { fuse_reply_err(req, EACCES); return; }
    /* Simulate a completed JBD2 abort: syncfs has no writeback error,
     * but the next journal-starting create returns EROFS. Not real ext4.
     */
    if (aborted) { record("probe create EROFS (simulated aborted journal)\n"); fuse_reply_err(req, EROFS); return; }
    if (probe_exists) { fuse_reply_err(req, EEXIST); return; }
    if (strlen(name) >= sizeof(probe_name)) { fuse_reply_err(req, ENAMETOOLONG); return; }
    strcpy(probe_name, name); probe_size = 0; probe_exists = 1;
    int error = record("probe create OK\n");
    if (error) { fuse_reply_err(req, error); return; }
    struct fuse_entry_param e; entry(PROBE, &e); fi->fh = PROBE;
    fuse_reply_create(req, &e, fi);
}
static void unlink_inode(fuse_req_t req, fuse_ino_t parent, const char *name)
{
    if (parent != UPPER || !probe_exists || strcmp(name, probe_name)) { fuse_reply_err(req, ENOENT); return; }
    if (fail == 5) { record("probe unlink EROFS\n"); fuse_reply_err(req, EROFS); return; }
    probe_exists = 0; fuse_reply_err(req, record("probe unlink OK\n"));
}
static void read_inode(fuse_req_t req, fuse_ino_t ino, size_t size, off_t offset, struct fuse_file_info *fi)
{
    (void)fi;
    const char *buffer = ino == FAULT ? content : probe_content;
    size_t length = ino == FAULT ? sizeof(content) : probe_size;
    if (offset < 0 || (size_t)offset >= length) { fuse_reply_buf(req, NULL, 0); return; }
    if (size > length - offset) size = length - offset;
    fuse_reply_buf(req, buffer + offset, size);
}
static void write_inode(fuse_req_t req, fuse_ino_t ino, const char *buffer, size_t size, off_t offset, struct fuse_file_info *fi)
{
    (void)fi;
    if (ino == PROBE && fail == 3) { record("probe write EIO\n"); fuse_reply_err(req, EIO); return; }
    const char *message = ino == PROBE ? "probe write OK\n" : fail == 1 ? "writeback EIO\n" : "writeback OK\n";
    int error = record(message);
    if (!error && ino == FAULT && fail == 1) error = EIO;
    if (error) { fuse_reply_err(req, error); return; }
    if (ino == FAULT && fail == 2) aborted = 1;
    char *target = ino == FAULT ? content : probe_content;
    size_t limit = ino == FAULT ? sizeof(content) : sizeof(probe_content);
    if (offset < 0 || size > limit || (size_t)offset > limit - size) { fuse_reply_err(req, EFBIG); return; }
    memcpy(target + offset, buffer, size);
    if (ino == PROBE && (size_t)offset + size > probe_size) probe_size = offset + size;
    fuse_reply_write(req, size);
}
static void fsync_inode(fuse_req_t req, fuse_ino_t ino, int datasync, struct fuse_file_info *fi)
{
    (void)datasync; (void)fi;
    if (ino == PROBE && fail == 4) { record("probe file fsync EIO\n"); fuse_reply_err(req, EIO); return; }
    fuse_reply_err(req, ino == PROBE ? record("probe file fsync OK\n") : 0);
}
static void fsync_directory(fuse_req_t req, fuse_ino_t ino, int datasync, struct fuse_file_info *fi)
{
    (void)ino; (void)datasync; (void)fi;
    if (fail == 6) { record("probe directory fsync EIO\n"); fuse_reply_err(req, EIO); return; }
    fuse_reply_err(req, record("probe directory fsync OK\n"));
}
static void release_inode(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi)
{
    (void)ino; (void)fi; fuse_reply_err(req, 0);
}
static void forget_inode(fuse_req_t req, fuse_ino_t ino, uint64_t nlookup)
{
    (void)ino; (void)nlookup; fuse_reply_none(req);
}
static const struct fuse_lowlevel_ops ops = {
    .init = initialize, .lookup = lookup, .getattr = getattr_inode, .setattr = setattr_inode,
    .readlink = readlink_inode, .open = open_inode, .opendir = open_inode,
    .create = create_inode, .unlink = unlink_inode, .read = read_inode, .write = write_inode,
    .fsync = fsync_inode, .fsyncdir = fsync_directory, .release = release_inode,
    .releasedir = release_inode, .forget = forget_inode
};
int main(int argc, char **argv)
{
    if (argc != 4) return 2;
    receipt = argv[2]; fail = atoi(argv[3]);
    char *values[] = { argv[0], "-f", "-s", argv[1] };
    struct fuse_args args = FUSE_ARGS_INIT(4, values);
    struct fuse_cmdline_opts opts;
    if (fuse_parse_cmdline(&args, &opts)) return 2;
    struct fuse_session *session = fuse_session_new(&args, &ops, sizeof(ops), NULL);
    int status = 1;
    if (session) {
        if (!fuse_session_mount(session, opts.mountpoint)) {
            if (!fuse_set_signal_handlers(session)) {
                status = fuse_session_loop(session);
                fuse_remove_signal_handlers(session);
            }
            fuse_session_unmount(session);
        }
        fuse_session_destroy(session);
    }
    free(opts.mountpoint); fuse_opt_free_args(&args);
    return status;
}
