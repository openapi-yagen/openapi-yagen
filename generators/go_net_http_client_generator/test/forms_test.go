package clienttest

import (
	"context"
	"io"
	"net/http"
	"testing"

	"go_net_http_client_generator_test/generated/models"
)

type received struct {
	contentType string
	length      int64
	form        map[string][]string
}

func TestOptionalAndNamedFormBodies(t *testing.T) {
	var got received
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = received{contentType: r.Header.Get("Content-Type"), length: r.ContentLength}
		if err := r.ParseMultipartForm(1 << 20); err == nil || err == http.ErrNotMultipart {
			got.form = r.PostForm
		} else if data, _ := io.ReadAll(r.Body); len(data) > 0 {
			t.Errorf("unreadable body %q: %v", data, err)
		}
		io.WriteString(w, "ok")
	})
	api := newTestClient(t, handler)
	ctx := context.Background()

	for name, call := range map[string]func() (string, error){
		"urlencoded": func() (string, error) { return api.Extras.OptionalForm(ctx, nil) },
		"multipart":  func() (string, error) { return api.Extras.OptionalUpload(ctx, nil) },
		"text":       func() (string, error) { return api.Extras.OptionalNote(ctx, nil) },
	} {
		if _, err := call(); err != nil {
			t.Fatal(err)
		}
		if got.length != 0 || (name != "text" && got.contentType != "") {
			t.Errorf("%s: expected no body, got %+v", name, got)
		}
	}

	quantity := models.Quantity(3)
	form := models.NamedForm{Owner: "ann", Quantity: &quantity, Members: models.IdentifierList{"cy", "di"}, Quantities: []models.Quantity{1, 2}}
	for name, call := range map[string]func() (string, error){
		"optional urlencoded": func() (string, error) { return api.Extras.OptionalForm(ctx, &form) },
		"optional multipart":  func() (string, error) { return api.Extras.OptionalUpload(ctx, &form) },
		"required urlencoded": func() (string, error) { return api.Extras.NamedForm(ctx, form) },
	} {
		if _, err := call(); err != nil {
			t.Fatal(err)
		}
		if len(got.form["owner"]) != 1 || got.form["owner"][0] != "ann" || got.form["quantity"][0] != "3" ||
			len(got.form["members"]) != 2 || got.form["members"][1] != "di" || len(got.form["quantities"]) != 2 {
			t.Errorf("%s: unexpected form %+v", name, got)
		}
	}
}
