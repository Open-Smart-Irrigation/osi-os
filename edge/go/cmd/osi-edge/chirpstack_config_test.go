package main

import "testing"

// The osi-chirpstack-helper constructor's messages, in its order (URL first),
// which cancel-ingress answers with 500 and the encoder publishes in its
// FAILED ACK (confirm-B2 C1).
func TestChirpstackClientConfigMatchesHelperConstructor(t *testing.T) {
	cases := []struct{ url, key, want string }{
		{"", "", "CHIRPSTACK_API_URL is required"},
		{" \t\u00a0\ufeff", "synthetic", "CHIRPSTACK_API_URL is required"},
		{"http://", "synthetic", "Invalid URL"},
		{"127.0.0.1:8080", "", "CHIRPSTACK_API_KEY is required"},
		{"127.0.0.1:8080", "\u2028 \u3000", "CHIRPSTACK_API_KEY is required"},
		{"127.0.0.1:8080", "abc\u00e9", "CHIRPSTACK_API_KEY contains characters not allowed in gRPC metadata"},
		{"127.0.0.1:8080", "a\x7fb", "CHIRPSTACK_API_KEY contains characters not allowed in gRPC metadata"},
		{"127.0.0.1:8080", " synthetic key ", ""},
		{"https://cs.example.invalid", "synthetic", ""},
	}
	for _, c := range cases {
		t.Setenv("CHIRPSTACK_API_URL", c.url)
		t.Setenv("CHIRPSTACK_API_KEY", c.key)
		err := chirpstackClientConfigError()
		got := ""
		if err != nil {
			got = err.Error()
		}
		if got != c.want {
			t.Errorf("url %q key %q: got %q, want %q", c.url, c.key, got, c.want)
		}
	}
}
