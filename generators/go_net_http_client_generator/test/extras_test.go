package clienttest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go_net_http_client_generator_test/generated/client"
	"go_net_http_client_generator_test/generated/models"
)

func newTestClientWithOptions(t *testing.T, handler http.Handler, opts ...client.Option) *client.ApiClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return client.NewApiClient(server.Client(), server.URL, opts...)
}

func static(value string) func(context.Context, string) (string, error) {
	return func(context.Context, string) (string, error) { return value, nil }
}

func TestAuthIsAddedPerOperationSecurity(t *testing.T) {
	var got *http.Request
	handler := func(w http.ResponseWriter, r *http.Request) {
		got = r
		w.WriteHeader(http.StatusNoContent)
	}
	var schemes []string
	api := newTestClientWithOptions(t, http.HandlerFunc(handler), client.WithAuth(client.Auth{
		Bearer: func(_ context.Context, scheme string) (string, error) {
			schemes = append(schemes, scheme)
			return "tok", nil
		},
		APIKey: func(_ context.Context, scheme string) (string, error) { return "key-" + scheme, nil },
	}))
	ctx := context.Background()

	if err := api.Extras.SecureBearer(ctx); err != nil {
		t.Fatal(err)
	}
	if got.Header.Get("Authorization") != "Bearer tok" || len(schemes) != 1 || schemes[0] != "bearerAuth" {
		t.Fatalf("unexpected bearer request: %v %v", got.Header, schemes)
	}

	if err := api.Extras.SecureAnd(ctx); err != nil {
		t.Fatal(err)
	}
	cookie, err := got.Cookie("session")
	if err != nil || cookie.Value != "key-sessionCookie" || got.URL.Query().Get("api_key") != "key-apiKeyQuery" || got.Header.Get("Authorization") != "" {
		t.Fatalf("unexpected AND request: %v %v", got.URL, got.Header)
	}

	if err := api.Extras.SecureOr(ctx); err != nil {
		t.Fatal(err)
	}
	if got.Header.Get("X-Api-Key") != "key-apiKeyHeader" || got.Header.Get("Authorization") != "" {
		t.Fatalf("expected only the first alternative: %v", got.Header)
	}
}

func TestAuthAlternatives(t *testing.T) {
	var got *http.Request
	calls := 0
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		got = r
		w.WriteHeader(http.StatusNoContent)
	})
	ctx := context.Background()

	bearerOnly := newTestClientWithOptions(t, handler, client.WithAuth(client.Auth{Bearer: static("tok")}))
	if err := bearerOnly.Extras.SecureOr(ctx); err != nil || got.Header.Get("Authorization") != "Bearer tok" {
		t.Fatalf("expected the second alternative: %v", err)
	}
	if err := bearerOnly.Extras.SecureAnd(ctx); err == nil || calls != 1 {
		t.Fatalf("expected an error before sending, got %v (%d calls)", err, calls)
	}
	// An unsupported scheme is left to the *http.Client.
	if err := bearerOnly.Extras.SecureBasic(ctx); err != nil || got.Header.Get("Authorization") != "" {
		t.Fatalf("unexpected basic handling: %v %v", err, got.Header)
	}

	keyOnly := newTestClientWithOptions(t, handler, client.WithAuth(client.Auth{APIKey: static("k")}))
	if err := keyOnly.Extras.SecureOptional(ctx); err != nil || got.Header.Get("Authorization") != "" {
		t.Fatalf("expected an anonymous request: %v", err)
	}

	sourceErr := errors.New("token service down")
	failing := newTestClientWithOptions(t, handler, client.WithAuth(client.Auth{
		Bearer: func(context.Context, string) (string, error) { return "", sourceErr },
	}))
	if err := failing.Extras.SecureBearer(ctx); !errors.Is(err, sourceErr) {
		t.Fatalf("expected the source's error, got %v", err)
	}
	empty := newTestClientWithOptions(t, handler, client.WithAuth(client.Auth{Bearer: static("")}))
	if err := empty.Extras.SecureBearer(ctx); err == nil {
		t.Fatal("expected an error for an empty token")
	}

	// Without WithAuth the request is sent as is, for a Transport to authenticate.
	plain := newTestClient(t, handler)
	if err := plain.Extras.SecureBearer(ctx); err != nil || got.Header.Get("Authorization") != "" {
		t.Fatalf("unexpected plain request: %v %v", err, got.Header)
	}
}

func TestResponseErrorTruncatesAndHidesBody(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, strings.Repeat("secret", 100000))
	})
	_, err := newTestClient(t, handler).Extras.EchoPerson(context.Background(), models.PersonData{})
	var responseErr *client.ResponseError
	if !errors.As(err, &responseErr) {
		t.Fatalf("expected a ResponseError, got %v", err)
	}
	if err.Error() != "unexpected status 500" || int64(len(responseErr.Body)) != client.MaxErrorBodySize {
		t.Fatalf("unexpected error %q with %d body bytes", err, len(responseErr.Body))
	}
}

func TestResponseWithoutRequiredPropertyIsRejected(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{}`)
	})
	_, err := newTestClient(t, handler).Extras.EchoScores(context.Background(), models.Scores{})
	var validationErr *models.ValidationError
	if !errors.As(err, &validationErr) || validationErr.Field != "title" {
		t.Fatalf("expected a missing title error, got %v", err)
	}
}

func TestAliasParamsOpenEnumsAndAdditionalProperties(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sessions/abc" || r.URL.Query().Get("channel") != "pigeon" || r.URL.Query().Get("count") != "2" {
			t.Errorf("unexpected request %s", r.URL)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		// A response omits the writeOnly "secret" and may send null for a required array.
		io.WriteString(w, `{"operation":"identification","channel":"fax","id":"abc","tags":null,"comment":null,"serverId":"s1"}`)
	})
	count := 2
	channel := models.Channel("pigeon")
	session, err := newTestClient(t, handler).Extras.PutSession(context.Background(), "abc", "key", &count, nil, nil, nil, nil, nil, &channel, models.Session{})
	if err != nil {
		t.Fatal(err)
	}
	if session.Channel != "fax" || session.ServerId != "s1" {
		t.Fatalf("unexpected session %+v", session)
	}
}
