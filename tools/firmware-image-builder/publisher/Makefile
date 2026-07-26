CC ?= gcc
VERSION ?= 0.1.0
CFLAGS := -std=c17 -D_GNU_SOURCE -O2 -Wall -Wextra -Werror

PUBLISHER := osi-image-publish
SOURCE := osi-image-publish.c

TEST_BINARIES := \
	osi-image-publish-test-before \
	osi-image-publish-test-after \
	osi-image-publish-test-destination \
	osi-image-publish-test-ancestor-before \
	osi-image-publish-test-ancestor-after \
	osi-image-publish-test-unsupported \
	osi-image-publish-test-cross-device \
	osi-image-publish-test-fsync-failure \
	osi-image-publish-test-block-root

.PHONY: all clean test test-hooks test-before test-after test-destination test-ancestor-before test-ancestor-after test-unsupported test-cross-device test-fsync-failure test-block-root

all: $(PUBLISHER)

$(PUBLISHER): $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o $@ $(SOURCE)
	chmod 0555 $@

test: all
	./test-publisher.sh

test-hooks: test-before test-after test-destination test-ancestor-before test-ancestor-after test-unsupported test-cross-device test-fsync-failure test-block-root

test-before: $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_TESTING -DPUBLISHER_TEST_SWAP_BEFORE -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o osi-image-publish-test-before $(SOURCE)
	chmod 0555 osi-image-publish-test-before

test-after: $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_TESTING -DPUBLISHER_TEST_SWAP_AFTER -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o osi-image-publish-test-after $(SOURCE)
	chmod 0555 osi-image-publish-test-after

test-destination: $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_TESTING -DPUBLISHER_TEST_SWAP_DESTINATION -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o osi-image-publish-test-destination $(SOURCE)
	chmod 0555 osi-image-publish-test-destination

test-ancestor-before: $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_TESTING -DPUBLISHER_TEST_ANCESTOR_BEFORE -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o osi-image-publish-test-ancestor-before $(SOURCE)
	chmod 0555 osi-image-publish-test-ancestor-before

test-ancestor-after: $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_TESTING -DPUBLISHER_TEST_ANCESTOR_AFTER -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o osi-image-publish-test-ancestor-after $(SOURCE)
	chmod 0555 osi-image-publish-test-ancestor-after

test-unsupported: $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_TESTING -DPUBLISHER_TEST_CAPABILITY_EINVAL -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o osi-image-publish-test-unsupported $(SOURCE)
	chmod 0555 osi-image-publish-test-unsupported

test-cross-device: $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_TESTING -DPUBLISHER_TEST_CROSS_DEVICE -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o osi-image-publish-test-cross-device $(SOURCE)
	chmod 0555 osi-image-publish-test-cross-device

test-fsync-failure: $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_TESTING -DPUBLISHER_TEST_FSYNC_FAILURE -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o osi-image-publish-test-fsync-failure $(SOURCE)
	chmod 0555 osi-image-publish-test-fsync-failure

test-block-root: $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_TESTING -DPUBLISHER_TEST_BLOCK_ROOT -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o osi-image-publish-test-block-root $(SOURCE)
	chmod 0555 osi-image-publish-test-block-root

clean:
	rm -f $(PUBLISHER) $(TEST_BINARIES)
