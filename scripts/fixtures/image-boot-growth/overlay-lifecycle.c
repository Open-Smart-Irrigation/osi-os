/*
 * Copyright (C) 2014 John Crispin <blogic@openwrt.org>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License version 2.1
 * as published by the Free Software Foundation
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 */

#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <dirent.h>
#include <fcntl.h>
#include <glob.h>
#include <alloca.h>

enum fs_state {
	FS_STATE_UNKNOWN,
	FS_STATE_PENDING,
	FS_STATE_READY,
	__FS_STATE_LAST = FS_STATE_READY,
};

static bool keep_sysupgrade;

static int
handle_rmdir(const char *dir)
{
	struct dirent *dt;
	struct stat st;
	DIR *d;
	int fd;

	d = opendir(dir);
	if (!d)
		return -1;

	fd = dirfd(d);

	while ((dt = readdir(d)) != NULL) {
		if (fstatat(fd, dt->d_name, &st, AT_SYMLINK_NOFOLLOW) || S_ISDIR(st.st_mode))
			continue;

		if (keep_sysupgrade && !strcmp(dt->d_name, "sysupgrade.tgz"))
			continue;

		unlinkat(fd, dt->d_name, 0);
	}

	closedir(d);
	rmdir(dir);

	return 0;
}

void
foreachdir(const char *dir, int (*cb)(const char*))
{
	static char *globdir = NULL;
	static size_t globdirlen = 0;
	struct stat s = { 0 };
	size_t dirlen = strlen(dir);
	glob_t gl;
	int j;

	if (dirlen + sizeof("/*") > globdirlen) {
		/* Alloc extra 256 B to avoid too many reallocs */
		size_t len = dirlen + sizeof("/*") + 256;
		char *tmp;

		tmp = realloc(globdir, len);
		if (!tmp)
			return;
		globdir = tmp;
		globdirlen = len;
	}

	sprintf(globdir, "%s/*", dir);

	/* Include GLOB_MARK as callbacks expect a trailing slash */
	if (!glob(globdir, GLOB_NOESCAPE | GLOB_MARK | GLOB_ONLYDIR, NULL, &gl))
		for (j = 0; j < gl.gl_pathc; j++) {
			char *dir = gl.gl_pathv[j];
			int len = strlen(gl.gl_pathv[j]);
			int err;

			/* Quick way of skipping files */
			if (dir[len - 1] != '/')
				continue;

			/* lstat needs path without a trailing slash */
			if (len > 1)
				dir[len - 1] = '\0';
			err = lstat(gl.gl_pathv[j], &s);
			if (len > 1)
				dir[len - 1] = '/';

			if (!err && !S_ISLNK(s.st_mode))
				foreachdir(gl.gl_pathv[j], cb);
	}
	cb(dir);
}

void
overlay_delete(const char *dir, bool _keep_sysupgrade)
{
	keep_sysupgrade = _keep_sysupgrade;
	foreachdir(dir, handle_rmdir);
}

enum fs_state fs_state_get(const char *dir)
{
	char *path;
	char valstr[16];
	uint32_t val;
	ssize_t len;

	path = alloca(strlen(dir) + 1 + sizeof("/.fs_state"));
	sprintf(path, "%s/.fs_state", dir);
	len = readlink(path, valstr, sizeof(valstr) - 1);
	if (len < 0)
		return FS_STATE_UNKNOWN;

	valstr[len] = 0;
	val = atoi(valstr);

	if (val > __FS_STATE_LAST)
		return FS_STATE_UNKNOWN;

	return val;
}


int fs_state_set(const char *dir, enum fs_state state)
{
	char valstr[16];
	char *path;

	if (fs_state_get(dir) == state)
		return 0;

	path = alloca(strlen(dir) + 1 + sizeof("/.fs_state"));
	sprintf(path, "%s/.fs_state", dir);
	unlink(path);
	snprintf(valstr, sizeof(valstr), "%d", state);

	return symlink(valstr, path);
}
