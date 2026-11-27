package clienttest

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"go_net_http_client_generator_test/generated/models"
)

func TestNamedDateTimeSchema(t *testing.T) {
	var path, query, body string
	response := ""
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		path, query, body = r.URL.Path, r.URL.Query().Get("until"), strings.TrimSpace(string(data))
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, response)
	})
	api := newTestClient(t, handler)
	ctx := context.Background()
	moment := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	const wire = "2026-01-02T03:04:05Z"

	response = `{"createdAt":"` + wire + `","marker":"` + wire + `"}`
	var createdAt models.Timestamp = moment
	timeline, err := api.Extras.PutTimeline(ctx, moment, []time.Time{moment}, models.Timeline{CreatedAt: createdAt})
	if err != nil {
		t.Fatal(err)
	}
	if path != "/timelines/"+wire || query != wire || body != `{"createdAt":"`+wire+`"}` {
		t.Errorf("unexpected request: %s until=%s %s", path, query, body)
	}
	marker, ok := timeline.Marker.AsTimestamp()
	if !timeline.CreatedAt.Equal(moment) || !ok || !marker.Equal(moment) {
		t.Errorf("unexpected response: %+v", timeline)
	}

	response = `"` + wire + `"`
	echoed, err := api.Extras.EchoTimestamp(ctx, moment)
	if err != nil || !echoed.Equal(moment) || body != `"`+wire+`"` {
		t.Errorf("unexpected echo %v (%v), sent %s", echoed, err, body)
	}

	response = "ok"
	var form string
	formAPI := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		form = r.PostFormValue("at")
		io.WriteString(w, response)
	}))
	if _, err := formAPI.Extras.NamedForm(ctx, models.NamedForm{Owner: "ann", At: &createdAt}); err != nil || form != wire {
		t.Errorf("unexpected form value %q (%v)", form, err)
	}
}
