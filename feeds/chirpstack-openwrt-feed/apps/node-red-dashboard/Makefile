include $(TOPDIR)/rules.mk

PKG_NPM_NAME:=node-red-dashboard
PKG_NAME:=$(PKG_NPM_NAME)
PKG_VERSION:=3.6.1
PKG_RELEASE:=1

PKG_SOURCE:=$(PKG_NPM_NAME)-$(PKG_VERSION).tgz
PKG_SOURCE_URL:=https://registry.npmjs.org/$(PKG_NPM_NAME)/-/
PKG_HASH:=skip

PKG_BUILD_DEPENDS:=node/host

PKG_MAINTAINER:=OSI-OS Team <info@osi-os.org>
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/node-red-dashboard
	SECTION:=node-red
	CATEGORY:=Node-RED
	TITLE:=Node-RED Dashboard
	URL:=https://github.com/node-red/node-red-dashboard
	DEPENDS:=+node +node-npm +node-red
endef

define Package/node-red-dashboard/description
	Node-RED Dashboard UI nodes
endef

TAR_OPTIONS+= --strip-components 1
TAR_CMD=$(HOST_TAR) -C $(1) $(TAR_OPTIONS)

NPM_FLAGS:= \
	npm_config_arch=$(ARCH) \
	npm_config_build_from_source=true \
	npm_config_nodedir=$(STAGING_DIR)/usr/ \
	npm_config_prefix=$(PKG_INSTALL_DIR)/usr/ \
	npm_config_cache=$(TMP_DIR)/npm-cache \
	npm_config_tmp=$(TMP_DIR)/npm-tmp

define Build/Compile
	$(NPM_FLAGS) npm i -g --production $(PKG_BUILD_DIR)
	$(NPM_FLAGS) npm i --production --prefix=$(PKG_BUILD_DIR)
endef

define Package/node-red-dashboard/install
	$(INSTALL_DIR) $(1)/usr/lib/node/node-red/node_modules/$(PKG_NPM_NAME)
	$(CP) $(PKG_INSTALL_DIR)/usr/lib/node_modules/$(PKG_NPM_NAME)/{*.json,*.md,LICENSE} $(1)/usr/lib/node/node-red/node_modules/$(PKG_NPM_NAME)
	$(CP) $(PKG_INSTALL_DIR)/usr/lib/node_modules/$(PKG_NPM_NAME)/{node_modules,nodes,icons} $(1)/usr/lib/node/node-red/node_modules/$(PKG_NPM_NAME)
endef

$(eval $(call BuildPackage,node-red-dashboard)) 