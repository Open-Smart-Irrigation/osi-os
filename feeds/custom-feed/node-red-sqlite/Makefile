include $(TOPDIR)/rules.mk

PKG_NAME:=node-red-sqlite
PKG_VERSION:=3.0.8
PKG_RELEASE:=1

PKG_SOURCE:=node-red-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://registry.npmjs.org/node-red/-/
PKG_HASH:=skip

PKG_MAINTAINER:=Your Name <your@email.com>
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/node-red-sqlite
  SECTION:=utils
  CATEGORY:=Utilities
  SUBMENU:=Node-RED
  TITLE:=Node-RED with SQLite support
  URL:=https://nodered.org
  DEPENDS:=+node +node-npm +sqlite3-cli
  PKGARCH:=all
endef

define Package/node-red-sqlite/description
  Node-RED with pre-installed SQLite node for database operations
endef

define Package/node-red-sqlite/conffiles
/etc/config/node-red
endef

define Build/Prepare
	$(call Build/Prepare/Default)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/node-red-sqlite/install
	$(INSTALL_DIR) $(1)/usr/lib/node_modules/node-red
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_DIR) $(1)/usr/share/node-red
	
	# Install Node-RED
	$(CP) $(PKG_BUILD_DIR)/* $(1)/usr/lib/node_modules/node-red/
	
	# Create node-red executable
	echo '#!/bin/sh' > $(1)/usr/bin/node-red
	echo 'cd /usr/lib/node_modules/node-red && node red.js $$$$*' >> $(1)/usr/bin/node-red
	$(INSTALL_BIN) $(1)/usr/bin/node-red $(1)/usr/bin/node-red
	
	# Install init script
	$(INSTALL_BIN) ./files/node-red.init $(1)/etc/init.d/node-red
	
	# Install UCI configuration
	$(INSTALL_CONF) ./files/node-red.config $(1)/etc/config/node-red
	
	# Install default flows and settings
	$(INSTALL_DATA) ./files/flows.json $(1)/usr/share/node-red/flows.json
	$(INSTALL_DATA) ./files/settings.js $(1)/usr/share/node-red/settings.js
endef

define Package/node-red-sqlite/postinst
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0

# Install Node-RED SQLite node
npm install -g --prefix /usr node-red-node-sqlite

# Create node-red user and directories
if ! grep -q "^node-red:" /etc/passwd; then
    echo "node-red:x:1000:1000:Node-RED:/var/lib/node-red:/bin/false" >> /etc/passwd
    echo "node-red:x:1000:" >> /etc/group
fi

mkdir -p /var/lib/node-red/.node-red
cp /usr/share/node-red/* /var/lib/node-red/.node-red/ 2>/dev/null || true
chown -R node-red:node-red /var/lib/node-red

# Enable service
/etc/init.d/node-red enable

exit 0
endef

$(eval $(call BuildPackage,node-red-sqlite))
