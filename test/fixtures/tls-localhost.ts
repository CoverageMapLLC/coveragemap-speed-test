/**
 * A self-signed certificate for `localhost` and `127.0.0.1`, valid until 2126, for tests that
 * open `wss://` against a local server. Test only: the key secures nothing.
 *
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
 *     -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
 */
export const LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIURlycc0yWZjofssEz7n0hyEw1ljcwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExNTIwMTUxMVoYDzIxMjYxMDIy
MjAxNTExWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQtKvNoszJtNgLOr79oIB+i44EEI6N0n31FlHV8viix4r226ebfU9Xp
yU8Io1Soe29Ykl5JoQH47H45DCotcBRzo28wbTAdBgNVHQ4EFgQUIvGo4yJnZJRv
fvtljnf7RK6zzpAwHwYDVR0jBBgwFoAUIvGo4yJnZJRvfvtljnf7RK6zzpAwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDRwAwRAIgDPvo9lSMT8kfnefKZNIyuRhft+BRH+ppQ4B7tR9UjD4CIAs2
MICu9ZZPsKDyj/CKZHVziGFmAAon2D4FsNRRdoZd
-----END CERTIFICATE-----
`;

export const LOCALHOST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/7xCipQ1CjakwygD
SuETd8iqGsulbgKUxJ+N7a0cqo2hRANCAAQtKvNoszJtNgLOr79oIB+i44EEI6N0
n31FlHV8viix4r226ebfU9XpyU8Io1Soe29Ykl5JoQH47H45DCotcBRz
-----END PRIVATE KEY-----
`;
