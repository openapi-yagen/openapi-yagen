package servertest

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"go_net_http_server_generator_test/generated/models"
)

func (fakeExtrasHandler) PutTimeline(ctx context.Context, since time.Time, until []time.Time, body models.Timeline) (models.Timeline, error) {
	body.History = append(append(body.History, since), until...)
	return body, nil
}

func (fakeExtrasHandler) EchoTimestamp(ctx context.Context, body models.Timestamp) (models.Timestamp, error) {
	return body.Add(time.Hour), nil
}

func TestNamedDateTimeSchema(t *testing.T) {
	s := newExtrasServer(t)
	cases := []struct {
		method, path, contentType, body, expected string
	}{
		{
			http.MethodPut, "/timelines/2026-01-02T03:04:05Z?until=2026-02-02T03:04:05Z", "application/json",
			`{"createdAt":"2026-03-04T05:06:07Z","updatedAt":"2026-04-04T05:06:07Z","marker":"2026-05-04T05:06:07Z"}`,
			`{"createdAt":"2026-03-04T05:06:07Z","history":["2026-01-02T03:04:05Z","2026-02-02T03:04:05Z"],"marker":"2026-05-04T05:06:07Z","updatedAt":"2026-04-04T05:06:07Z"}`,
		},
		{http.MethodPost, "/timestamp", "application/json", `"2026-01-02T03:04:05Z"`, `"2026-01-02T04:04:05Z"`},
		{
			http.MethodPost, "/forms/named", "application/x-www-form-urlencoded", "owner=ann&at=2026-01-02T03:04:05Z",
			`{"at":"2026-01-02T03:04:05Z","owner":"ann"}`,
		},
	}
	for _, c := range cases {
		var body io.Reader = strings.NewReader(c.body)
		resp, data := doRequest(t, c.method, s.URL+c.path, c.contentType, body, nil)
		if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(data)) != c.expected {
			t.Errorf("%s: expected %s, got %d %s", c.path, c.expected, resp.StatusCode, data)
		}
	}
	resp, data := doRequest(t, http.MethodPost, s.URL+"/timestamp", "application/json", strings.NewReader(`"yesterday"`), nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for a malformed timestamp, got %d %s", resp.StatusCode, data)
	}
}
