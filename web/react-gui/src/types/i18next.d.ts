import 'i18next';
import type en_common    from '../../public/locales/en/common.json';
import type en_auth      from '../../public/locales/en/auth.json';
import type en_dashboard from '../../public/locales/en/dashboard.json';
import type en_devices   from '../../public/locales/en/devices.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common:    typeof en_common;
      auth:      typeof en_auth;
      dashboard: typeof en_dashboard;
      devices:   typeof en_devices;
    };
  }
}
