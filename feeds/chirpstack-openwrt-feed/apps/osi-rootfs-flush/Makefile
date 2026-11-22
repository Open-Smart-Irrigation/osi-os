include $(TOPDIR)/rules.mk

PKG_NAME:=osi-rootfs-flush
PKG_VERSION:=1.0
PKG_RELEASE:=2
PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/osi-rootfs-flush
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Checked overlay writeback barrier for first-boot growth
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/osi-rootfs-flush.c $(PKG_BUILD_DIR)/
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -std=c99 -Wall -Wextra -Werror \
		$(PKG_BUILD_DIR)/osi-rootfs-flush.c $(TARGET_LDFLAGS) -o $(PKG_BUILD_DIR)/osi-rootfs-flush
endef

define Package/osi-rootfs-flush/install
	$(INSTALL_DIR) $(1)/usr/libexec
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/osi-rootfs-flush $(1)/usr/libexec/
endef

$(eval $(call BuildPackage,osi-rootfs-flush))
