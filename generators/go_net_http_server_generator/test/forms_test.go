package servertest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"go_net_http_server_generator_test/generated/models"
)

func describe(v any) (string, error) {
	data, err := json.Marshal(v)
	return string(data), err
}

func (fakeExtrasHandler) OptionalForm(ctx context.Context, body *models.NamedForm) (string, error) {
	return describe(body)
}

func (fakeExtrasHandler) OptionalUpload(ctx context.Context, body *models.NamedForm) (string, error) {
	return describe(body)
}

func (fakeExtrasHandler) OptionalNote(ctx context.Context, body *string) (string, error) {
	return describe(body)
}

func (fakeExtrasHandler) NamedForm(ctx context.Context, body models.NamedForm) (string, error) {
	return describe(body)
}

func TestOptionalRequestBodies(t *testing.T) {
	s := newExtrasServer(t)
	var multipartBody bytes.Buffer
	writer := multipart.NewWriter(&multipartBody)
	writer.WriteField("owner", "ann")
	writer.Close()

	cases := []struct {
		path, contentType string
		body              io.Reader
		status            int
		expected          string
	}{
		{"/forms/optional", "", nil, 200, "null"},
		{"/forms/optional", "application/x-www-form-urlencoded", strings.NewReader("owner=ann"), 200, `{"owner":"ann"}`},
		{"/forms/optional", "application/x-www-form-urlencoded", strings.NewReader("alias=bo"), 400, `field "owner": is required`},
		{"/forms/optional-upload", "", nil, 200, "null"},
		{"/forms/optional-upload", writer.FormDataContentType(), &multipartBody, 200, `{"owner":"ann"}`},
		{"/forms/optional-note", "", nil, 200, "null"},
		{"/forms/optional-note", "text/plain", strings.NewReader("hi"), 200, `"hi"`},
	}
	for _, c := range cases {
		resp, data := doRequest(t, http.MethodPost, s.URL+c.path, c.contentType, c.body, nil)
		if resp.StatusCode != c.status || !strings.Contains(string(data), c.expected) {
			t.Errorf("%s %q: expected %d %q, got %d %q", c.path, c.contentType, c.status, c.expected, resp.StatusCode, data)
		}
	}
}

func TestNamedScalarAndArrayFormFields(t *testing.T) {
	s := newExtrasServer(t)
	post := func(body string) (*http.Response, string) {
		resp, data := doRequest(t, http.MethodPost, s.URL+"/forms/named", "application/x-www-form-urlencoded", strings.NewReader(body), nil)
		return resp, string(data)
	}
	resp, data := post("owner=ann&alias=bo&quantity=3&members=cy&members=di&quantities=1&quantities=2")
	expected := `{"alias":"bo","members":["cy","di"],"owner":"ann","quantities":[1,2],"quantity":3}`
	var got, want map[string]any
	json.Unmarshal([]byte(data), &got)
	json.Unmarshal([]byte(expected), &want)
	gotText, _ := describe(got)
	wantText, _ := describe(want)
	if resp.StatusCode != http.StatusOK || gotText != wantText {
		t.Fatalf("expected %s, got %d %s", expected, resp.StatusCode, data)
	}
	if resp, data := post("owner=ann&quantity=many"); resp.StatusCode != http.StatusBadRequest || !strings.Contains(data, `field "quantity"`) {
		t.Fatalf("expected a quantity error, got %d %s", resp.StatusCode, data)
	}
}
