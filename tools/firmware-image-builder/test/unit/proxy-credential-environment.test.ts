import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface ProxyEnvironmentModule {
  readonly authenticatedProxyEnvironment: (
    environment: NodeJS.ProcessEnv,
    readCredential: (path: string) => string,
  ) => NodeJS.ProcessEnv;
}

function helper(): ProxyEnvironmentModule {
  return require('../../builder/operations/osi-proxy-credential-environment.cjs') as ProxyEnvironmentModule;
}

describe('execution guard proxy credential injection', () => {
  it('adds the per-operation credential only to the trusted child environment', () => {
    const unauthenticated = 'http://osi-egress-proxy:3128';
    const source = {
      HTTP_PROXY: unauthenticated,
      HTTPS_PROXY: unauthenticated,
      ALL_PROXY: unauthenticated,
      NO_PROXY: '',
      http_proxy: unauthenticated,
      https_proxy: unauthenticated,
      all_proxy: unauthenticated,
      no_proxy: '',
      OSI_EGRESS_PROXY_CREDENTIAL_FILE: '/run/osi-image-builder/proxy-credential',
      OSI_EGRESS_CA_CERT_FILE: '/run/osi-image-builder/ca.pem',
      WGETRC: '/workdir/attacker-wgetrc',
    };
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const child = helper().authenticatedProxyEnvironment(source, (path) => {
      expect(path).toBe('/run/osi-image-builder/proxy-credential');
      return credential;
    });

    expect(source.HTTP_PROXY).toBe(unauthenticated);
    expect(child.HTTP_PROXY).toBe(`http://osi:${credential}@osi-egress-proxy:3128`);
    expect(child.HTTPS_PROXY).toBe(child.HTTP_PROXY);
    expect(child.http_proxy).toBe(child.HTTP_PROXY);
    expect(child.OSI_EGRESS_PROXY_CREDENTIAL_FILE).toBeUndefined();
    expect(child.CURL_CA_BUNDLE).toBe('/run/osi-image-builder/ca.pem');
    expect(child.SSL_CERT_FILE).toBe('/run/osi-image-builder/ca.pem');
    expect(child.GIT_SSL_CAINFO).toBe('/run/osi-image-builder/ca.pem');
    expect(child.NODE_EXTRA_CA_CERTS).toBe('/run/osi-image-builder/ca.pem');
    expect(child.WGETRC).toBe('/opt/osi-image-builder/operations/osi-wgetrc');
  });

  it('leaves offline operation environments unchanged without reading a credential', () => {
    let reads = 0;
    const source = { PATH: '/usr/bin' };
    expect(helper().authenticatedProxyEnvironment(source, () => {
      reads += 1;
      return 'unused';
    })).toEqual(source);
    expect(reads).toBe(0);
  });

  it('fails closed on a partial proxy environment or malformed credential', () => {
    expect(() => helper().authenticatedProxyEnvironment({
      HTTP_PROXY: 'http://osi-egress-proxy:3128',
      OSI_EGRESS_PROXY_CREDENTIAL_FILE: '/run/osi-image-builder/proxy-credential',
      OSI_EGRESS_CA_CERT_FILE: '/run/osi-image-builder/ca.pem',
    }, () => 'bad')).toThrow(/proxy|credential/u);
  });
});
