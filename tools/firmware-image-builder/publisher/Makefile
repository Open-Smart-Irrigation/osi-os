CC ?= gcc
VERSION ?= 0.1.0
CFLAGS := -std=c17 -D_GNU_SOURCE -O2 -Wall -Wextra -Werror

PUBLISHER := osi-image-publish
SOURCE := osi-image-publish.c

.PHONY: all clean test

all: $(PUBLISHER)

$(PUBLISHER): $(SOURCE) Makefile
	SOURCE_SHA256=$$(sha256sum $(SOURCE) | awk '{print $$1}'); \
	$(CC) $(CFLAGS) -DPUBLISHER_VERSION=\"$(VERSION)\" -DPUBLISHER_SOURCE_SHA256=\"$$SOURCE_SHA256\" -o $@ $(SOURCE)
	chmod 0555 $@

test: all
	./test-publisher.sh

clean:
	rm -f $(PUBLISHER)
