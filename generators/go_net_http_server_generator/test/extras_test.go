package servertest

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go_net_http_server_generator_test/generated/models"
	"go_net_http_server_generator_test/generated/server"
)

type fakeExtrasHandler struct{}

func (fakeExtrasHandler) PutSession(ctx context.Context, sessionId string, idempotencyKey string, count *int, ids []string, since *string, code *string, ratio *float64, lookahead *string, channel *models.Channel, body models.Session) (models.Session, error) {
	if channel != nil {
		body.Channel = *channel
	}
	server.ResponseWriterFromContext(ctx).Header().Set("ETag", `"v1"`)
	if requestID := server.RequestFromContext(ctx).Header.Get("X-Request-ID"); requestID != "" {
		server.ResponseWriterFromContext(ctx).Header().Set("X-Request-ID", requestID)
	}
	return body, nil
}

func (fakeExtrasHandler) EchoPerson(ctx context.Context, body models.PersonData) (models.PersonData, error) {
	return body, nil
}

func (fakeExtrasHandler) EchoScores(ctx context.Context, body models.Scores) (models.Scores, error) {
	return body, nil
}

func (fakeExtrasHandler) GetRaw(ctx context.Context, mode string) (string, error) {
	w := server.ResponseWriterFromContext(ctx)
	switch mode {
	case "own":
		w.Header().Set("Content-Type", "application/custom")
		w.WriteHeader(http.StatusAccepted)
		io.WriteString(w, "written by the handler")
	case "partial":
		io.WriteString(w, "partial")
		return "", errors.New("failed after writing")
	case "delegate":
		http.RedirectHandler("/elsewhere", http.StatusFound).ServeHTTP(w, server.RequestFromContext(ctx))
	case "flush":
		io.WriteString(w, "chunk")
		w.(http.Flusher).Flush()
	case "fail":
		return "", errors.New("failed before writing")
	}
	return "generated", nil
}

func newExtrasServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	server.RegisterExtrasRoutes(mux, fakeExtrasHandler{}, nil)
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

const validSession = `{"operation":"identification","channel":"fax","id":"abc","tags":[],"comment":null,"secret":"s"}`

const validKey = "123e4567-e89b-12d3-a456-426614174000"

func putSession(t *testing.T, s *httptest.Server, path, body string) (*http.Response, string) {
	t.Helper()
	resp, data := doRequest(t, http.MethodPut, s.URL+path, "application/json", strings.NewReader(body),
		map[string]string{"Idempotency-Key": validKey, "X-Request-ID": "req-1"})
	return resp, string(data)
}

func TestRequiredBodyPropertiesAreEnforced(t *testing.T) {
	s := newExtrasServer(t)
	resp, data := putSession(t, s, "/sessions/abc", validSession)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, data)
	}
	if resp.Header.Get("ETag") != `"v1"` || resp.Header.Get("X-Request-ID") != "req-1" {
		t.Fatalf("expected the handler's headers, got %v", resp.Header)
	}

	cases := map[string]string{
		`{}`: `field "channel": is required`,
		strings.Replace(validSession, `"tags":[],`, "", 1):                         `field "tags": is required`,
		strings.Replace(validSession, `"comment":null,`, "", 1):                    `field "comment": is required`,
		strings.Replace(validSession, `"id":"abc"`, `"id":null`, 1):                `field "id": must not be null`,
		strings.Replace(validSession, `"id":"abc"`, `"ID":"abc"`, 1):               `field "id": is required`,
		strings.Replace(validSession, `"id":"abc"`, `"id":"ABC"`, 1):               `field "id": does not match pattern`,
		strings.Replace(validSession, `"id":"abc"`, `"id":"abc","ownerId":"1"`, 1): `field "ownerId": does not match pattern`,
		strings.Replace(validSession, `"id":"abc"`, `"id":"abc","attempts":0`, 1):  `field "attempts": must be >= 1`,
		strings.Replace(validSession, "identification", "other", 1):                "invalid Operation value",
	}
	for body, expected := range cases {
		resp, data := putSession(t, s, "/sessions/abc", body)
		if resp.StatusCode != http.StatusBadRequest || !strings.Contains(data, expected) {
			t.Errorf("body %s: expected 400 with %q, got %d: %s", body, expected, resp.StatusCode, data)
		}
	}
}

func TestRequiredEnumIsCheckedByValidate(t *testing.T) {
	session := models.Session{Id: "abc"}
	var validationErr *models.ValidationError
	if err := session.Validate(); !errors.As(err, &validationErr) || validationErr.Field != "operation" {
		t.Fatalf("expected an operation error, got %v", err)
	}
}

func TestOpenEnumAcceptsUnknownValues(t *testing.T) {
	var session models.Session
	if err := json.Unmarshal([]byte(validSession), &session); err != nil {
		t.Fatal(err)
	}
	if session.Channel != "fax" || session.Channel.IsKnown() || !models.ChannelWeb.IsKnown() {
		t.Fatalf("unexpected channel handling: %q", session.Channel)
	}
	s := newExtrasServer(t)
	resp, data := putSession(t, s, "/sessions/abc?channel=pigeon", validSession)
	if resp.StatusCode != http.StatusOK || !strings.Contains(data, `"channel":"pigeon"`) {
		t.Fatalf("expected an unknown channel parameter to pass, got %d: %s", resp.StatusCode, data)
	}
}

func TestParameterConstraints(t *testing.T) {
	s := newExtrasServer(t)
	ok := "/sessions/abc?count=1&ids=a&ids=b&since=2026-01-31&code=ab&ratio=0.5&lookahead=zzz"
	if resp, data := putSession(t, s, ok, validSession); resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, data)
	}
	cases := map[string]string{
		"/sessions/ABC":                  `field "sessionId": does not match pattern`,
		"/sessions/abc?count=0":          `field "count": must be >= 1`,
		"/sessions/abc?ids=a&ids=B":      `field "ids": does not match pattern`,
		"/sessions/abc?since=31.01.2026": `field "since": must be a valid date`,
		"/sessions/abc?code=a":           `field "code": must have length >= 2`,
		"/sessions/abc?code=abcde":       `field "code": must have length <= 4`,
		"/sessions/abc?ratio=1.5":        `field "ratio": must be <= 1`,
	}
	for path, expected := range cases {
		resp, data := putSession(t, s, path, validSession)
		if resp.StatusCode != http.StatusBadRequest || !strings.Contains(data, expected) {
			t.Errorf("%s: expected 400 with %q, got %d: %s", path, expected, resp.StatusCode, data)
		}
	}
	resp, data := doRequest(t, http.MethodPut, s.URL+"/sessions/abc", "application/json", strings.NewReader(validSession),
		map[string]string{"Idempotency-Key": "abc"})
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), `field "Idempotency-Key": must be a valid UUID`) {
		t.Fatalf("expected a UUID error, got %d: %s", resp.StatusCode, data)
	}
}

func TestAdditionalProperties(t *testing.T) {
	s := newExtrasServer(t)
	input := `{"firstName":"Ann","FIRSTNAME":"other","address":{"city":"X"},"big":12345678901234567890}`
	resp, data := doRequest(t, http.MethodPost, s.URL+"/person", "application/json", strings.NewReader(input), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, data)
	}
	for _, expected := range []string{`"firstName":"Ann"`, `"FIRSTNAME":"other"`, `"address":{"city":"X"}`} {
		if !strings.Contains(string(data), expected) {
			t.Errorf("expected %s in %s", expected, data)
		}
	}
	var person models.PersonData
	if err := json.Unmarshal([]byte(input), &person); err != nil {
		t.Fatal(err)
	}
	if *person.FirstName != "Ann" || len(person.AdditionalProperties) != 3 {
		t.Fatalf("unexpected person: %+v", person)
	}
	person.AdditionalProperties["firstName"] = "shadow"
	person.FirstName = nil
	encoded, err := json.Marshal(person)
	if err != nil || strings.Contains(string(encoded), "shadow") {
		t.Fatalf("an additional property must not stand in for a declared one: %s (%v)", encoded, err)
	}
}

// Scores declares a property literally named "AdditionalProperties", so the map field is renamed.
func TestTypedAdditionalProperties(t *testing.T) {
	var scores models.Scores
	input := `{"title":"t","AdditionalProperties":"declared","alice":{"value":3}}`
	if err := json.Unmarshal([]byte(input), &scores); err != nil {
		t.Fatal(err)
	}
	if *scores.Level != 3 || *scores.AdditionalProperties != "declared" || scores.AdditionalPropertiesWrapper["alice"].Value != 3 {
		t.Fatalf("unexpected scores: %+v", scores)
	}
	encoded, err := json.Marshal(scores)
	if err != nil || !strings.Contains(string(encoded), `"alice":{"value":3}`) {
		t.Fatalf("unexpected encoding: %s (%v)", encoded, err)
	}

	s := newExtrasServer(t)
	for body, expected := range map[string]string{
		`{"title":"t","bob":{"value":11}}`: `field "bob.value": must be <= 10`,
		`{"title":"t","bob":{}}`:           `field "value": is required`,
		`{"title":"t","bob":1}`:            `property \"bob\"`,
	} {
		resp, data := doRequest(t, http.MethodPost, s.URL+"/scores", "application/json", strings.NewReader(body), nil)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: expected 400, got %d: %s", body, resp.StatusCode, data)
		} else if !strings.Contains(string(data), strings.ReplaceAll(expected, `\"`, `"`)) {
			t.Errorf("%s: expected %q in %s", body, expected, data)
		}
	}
}

func TestHandlerOwnsResponseItWrote(t *testing.T) {
	s := newExtrasServer(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	cases := []struct {
		mode   string
		status int
		body   string
	}{
		{"none", 200, "generated"},
		{"own", 202, "written by the handler"},
		{"partial", 200, "partial"},
		{"delegate", 302, "<a href=\"/elsewhere\">Found</a>.\n\n"},
		{"flush", 200, "chunk"},
		{"fail", 500, "internal server error\n"},
	}
	for _, c := range cases {
		resp, err := client.Get(s.URL + "/raw?mode=" + c.mode)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(bufio.NewReader(resp.Body))
		resp.Body.Close()
		if resp.StatusCode != c.status || string(data) != c.body {
			t.Errorf("%s: expected %d %q, got %d %q", c.mode, c.status, c.body, resp.StatusCode, data)
		}
	}
	if server.RequestFromContext(context.Background()) != nil || server.ResponseWriterFromContext(context.Background()) != nil {
		t.Fatal("expected nil outside a handler")
	}
}

func TestRequireBearerToken(t *testing.T) {
	cases := map[string]string{
		"Bearer abc":   "abc",
		"bearer abc":   "abc",
		"BEARER   abc": "abc",
		"Basic abc":    "",
		"abc":          "",
		"Bearer":       "",
		"Bearer ":      "",
		"Bearerabc":    "",
		"":             "",
	}
	for header, expected := range cases {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		if header != "" {
			r.Header.Set("Authorization", header)
		}
		token, err := server.RequireBearerToken(r, "Authorization")
		var authErr *server.MissingAuthenticationError
		if expected == "" && !errors.As(err, &authErr) {
			t.Errorf("%q: expected MissingAuthenticationError, got %q, %v", header, token, err)
		}
		if expected != "" && (err != nil || token != expected) {
			t.Errorf("%q: expected %q, got %q, %v", header, expected, token, err)
		}
	}
}
