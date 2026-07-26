CC ?= gcc
VERSION ?= 0.1.0
CFLAGS := -std=c17 -D_GNU_SOURCE -O2 -Wall -Wextra -Werror

PUBLISHER := osi-image-publish
SOURCE := osi-image-publish.c

.PHONY: all clean test test-hooks test-before test-after test-destination

all: $(PUBLISHER)

$(PUBLISHER): $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o $@ $(SOURCE)
	chmod 0555 $@

test: all
	./test-publisher.sh

test-hooks: test-before test-after test-destination

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

clean:
	rm -f $(PUBLISHER) osi-image-publish-test-before osi-image-publish-test-after osi-image-publish-test-destination
