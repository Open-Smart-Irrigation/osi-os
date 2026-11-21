// The release Vite config fixes this to false. Only the internal matrix config
// builds the experimental charts and their diagnostics.
export const MOBILE_HISTORY_INTERNAL_ENABLED =
  typeof __OSI_INTERNAL_PHONE_CHARTS__ !== 'undefined' && __OSI_INTERNAL_PHONE_CHARTS__;
