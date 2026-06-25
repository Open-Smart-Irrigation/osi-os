.PHONY: build clean init update devshell show-envs switch-env verify-profile-parity

# Build the OpenWrt image.
# Note: execute this within the devshell.
build:
	cd openwrt && make

# Initialize the OpenWrt environment.
init:
	git submodule init
	git submodule update
	cp feeds.conf.default openwrt/feeds.conf.default
	ln -s ../conf/.config openwrt/.config
	ln -s ../conf/files openwrt/files
	docker compose run --rm chirpstack-gateway-os openwrt/scripts/feeds update -a
	docker compose run --rm chirpstack-gateway-os openwrt/scripts/feeds install -a
	docker compose run --rm chirpstack-gateway-os quilt init

# Update OpenWrt + package feeds.
update:
	git submodule update
	cp feeds.conf.default openwrt/feeds.conf.default
	cd openwrt && \
		./scripts/feeds update -a && \
		./scripts/feeds install -a

# Activate the devshell.
devshell:
	docker compose run --rm chirpstack-gateway-os bash

# Switch configuration environment.,
# Note: execute this within the devshell.
switch-env:
	@echo "Cleaning patch state"
	cd openwrt && quilt pop -af || true
	rm -rf openwrt/.pc
	
	@echo "Restoring clean source tree"
	cd openwrt && git checkout -- . || true
	cd openwrt && git clean -fd || true
	
	@echo "Switching configuration"
	rm -f conf/files conf/patches conf/.config
	if [ -d "conf/${ENV}/files-overlay" ]; then \
		rm -rf ".tmp-openwrt-files/${ENV}"; \
		mkdir -p ".tmp-openwrt-files/${ENV}"; \
		cp -a "conf/${ENV}/files/." ".tmp-openwrt-files/${ENV}/"; \
		cp -a "conf/${ENV}/files-overlay/." ".tmp-openwrt-files/${ENV}/"; \
		ln -s "../.tmp-openwrt-files/${ENV}" conf/files; \
	else \
		ln -s ${ENV}/files conf/files; \
	fi
	ln -s ${ENV}/patches conf/patches
	ln -s ${ENV}/.config conf/.config
	
	@echo "Recreating openwrt symlinks"
	rm -f openwrt/.config openwrt/files openwrt/patches
	ln -s ../conf/.config openwrt/.config
	ln -s ../conf/files openwrt/files
	ln -s ../conf/patches openwrt/patches
	
	@echo "Initializing quilt"
	mkdir -p openwrt/.pc
	echo "patches" > openwrt/.pc/.quilt_patches
	cd openwrt && quilt upgrade || true
	
	@echo "Applying patches"
	cd openwrt && quilt push -a || [ $$? -eq 2 ]

# Clean the OpenWrt environment.
clean:
	rm -rf openwrt

# Verify bcm2709 / bcm2712 profile parity.
verify-profile-parity:
	node scripts/verify-profile-parity.js
