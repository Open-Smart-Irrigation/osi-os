'use strict';

const PROXY = 'http://osi-egress-proxy:3128';
const CREDENTIAL_PATH = '/run/osi-image-builder/proxy-credential';
const CA_CERT_PATH = '/run/osi-image-builder/ca.pem';
const WGET_CONFIG_PATH = '/opt/osi-image-builder/operations/osi-wgetrc';
const PROXY_KEYS = Object.freeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);

function authenticatedProxyEnvironment(environment, readCredential) {
  if (environment === null || typeof environment !== 'object' || typeof readCredential !== 'function') throw new Error('proxy credential environment is invalid');
  const credentialPath = environment.OSI_EGRESS_PROXY_CREDENTIAL_FILE;
  const caCertPath = environment.OSI_EGRESS_CA_CERT_FILE;
  const presentProxyKeys = PROXY_KEYS.filter((key) => Object.hasOwn(environment, key));
  if (credentialPath === undefined && caCertPath === undefined && presentProxyKeys.length === 0) return { ...environment };
  if (credentialPath !== CREDENTIAL_PATH || caCertPath !== CA_CERT_PATH || presentProxyKeys.length !== PROXY_KEYS.length) throw new Error('proxy credential environment is incomplete');
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    if (environment[key] !== PROXY) throw new Error('proxy authority differs from the installed policy');
  }
  if (environment.NO_PROXY !== '' || environment.no_proxy !== '') throw new Error('proxy bypass environment is not empty');
  const credential = readCredential(CREDENTIAL_PATH);
  if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{48,128}$/u.test(credential)) throw new Error('proxy credential is invalid');
  const authenticated = `http://osi:${credential}@osi-egress-proxy:3128`;
  const child = { ...environment };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) child[key] = authenticated;
  delete child.OSI_EGRESS_PROXY_CREDENTIAL_FILE;
  delete child.OSI_EGRESS_CA_CERT_FILE;
  child.CURL_CA_BUNDLE = CA_CERT_PATH;
  child.SSL_CERT_FILE = CA_CERT_PATH;
  child.GIT_SSL_CAINFO = CA_CERT_PATH;
  child.NODE_EXTRA_CA_CERTS = CA_CERT_PATH;
  child.WGETRC = WGET_CONFIG_PATH;
  return child;
}

module.exports = Object.freeze({ authenticatedProxyEnvironment });
