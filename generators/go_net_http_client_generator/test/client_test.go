package clienttest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go_net_http_client_generator_test/generated/client"
	"go_net_http_client_generator_test/generated/models"
)

func newTestClient(t *testing.T, handler http.Handler) *client.ApiClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return client.NewApiClient(server.Client(), server.URL)
}

func TestListPets(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/pets" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "10" {
			t.Fatalf("expected limit=10, got %q", got)
		}
		if got := r.URL.Query()["tags"]; len(got) != 2 || got[0] != "a" || got[1] != "b" {
			t.Fatalf("expected repeated tags=a&tags=b, got %v", got)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]models.Pet{{Id: 1, Name: "Rex"}})
	})

	c := newTestClient(t, handler)
	limit := 10
	pets, err := c.Pets.ListPets(context.Background(), &limit, nil, []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pets) != 1 || pets[0].Name != "Rex" {
		t.Fatalf("unexpected pets: %+v", pets)
	}
}

func TestGetPetByIdNotFound(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"code":404,"message":"not found"}`))
	})
	c := newTestClient(t, handler)
	_, err := c.Pets.GetPetById(context.Background(), "missing")
	if err == nil {
		t.Fatal("expected an error")
	}
	respErr, ok := err.(*client.ResponseError)
	if !ok {
		t.Fatalf("expected *client.ResponseError, got %T: %v", err, err)
	}
	if respErr.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", respErr.StatusCode)
	}
}

func TestCreatePet(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("expected JSON content type, got %q", r.Header.Get("Content-Type"))
		}
		var body models.NewPet
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Name != "Fido" {
			t.Fatalf("unexpected body: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(models.Pet{Id: 2, Name: body.Name})
	})
	c := newTestClient(t, handler)
	pet, err := c.Pets.CreatePet(context.Background(), models.NewPet{Name: "Fido"})
	if err != nil {
		t.Fatal(err)
	}
	if pet.Name != "Fido" {
		t.Fatalf("unexpected pet: %+v", pet)
	}
}

func TestRatePetHeaderAndValidation(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Request-Id"); got != "req-123" {
			t.Fatalf("expected X-Request-Id header, got %q", got)
		}
		var rating models.Rating
		json.NewDecoder(r.Body).Decode(&rating)
		if err := rating.Validate(); err != nil {
			t.Fatalf("expected valid rating, got %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	c := newTestClient(t, handler)
	err := c.Pets.RatePet(context.Background(), "1", "req-123", models.Rating{Score: 5, Label: "great"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRatingValidateRejectsBadPattern(t *testing.T) {
	rating := models.Rating{Score: 5, Label: "NOT-LOWERCASE"}
	if err := rating.Validate(); err == nil {
		t.Fatal("expected a validation error for a label not matching ^[a-z]+$")
	}
	rating2 := models.Rating{Score: 10, Label: "ok"}
	if err := rating2.Validate(); err == nil {
		t.Fatal("expected a validation error for score > maximum")
	}
}

func TestUploadPetPhotoMultipart(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		if got := r.FormValue("caption"); got != "Nice dog" {
			t.Fatalf("unexpected caption: %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	c := newTestClient(t, handler)
	caption := "Nice dog"
	err := c.Pets.UploadPetPhoto(context.Background(), "1", models.PetPhotoUpload{Caption: &caption, Photo: "binarydata"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSubscribeToPetUrlencoded(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Fatalf("unexpected content type: %q", r.Header.Get("Content-Type"))
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if got := r.FormValue("email"); got != "a@example.com" {
			t.Fatalf("unexpected email: %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	c := newTestClient(t, handler)
	err := c.Pets.SubscribeToPet(context.Background(), "1", models.PetSubscription{Email: "a@example.com"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSetPetNotesText(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != "hello" {
			t.Fatalf("unexpected body: %q", body)
		}
		w.Header().Set("Content-Type", "text/plain")
		w.Write(body)
	})
	c := newTestClient(t, handler)
	result, err := c.Pets.SetPetNotes(context.Background(), "1", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if result != "hello" {
		t.Fatalf("unexpected result: %q", result)
	}
}

func TestUploadPetAvatarBytes(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(body)
	})
	c := newTestClient(t, handler)
	result, err := c.Pets.UploadPetAvatar(context.Background(), "1", []byte{1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result, []byte{1, 2, 3}) {
		t.Fatalf("unexpected result: %v", result)
	}
}

func TestListWidgetsEnumAndUnionParam(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("status"); got != "sold-out" {
			t.Fatalf("expected wire value sold-out, got %q", got)
		}
		if got := r.URL.Query().Get("id"); got != "42" {
			t.Fatalf("expected id=42, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
	})
	c := newTestClient(t, handler)
	status := models.WidgetsClientListWidgetsStatusSoldOut
	id := "42"
	_, err := c.Widgets.ListWidgets(context.Background(), &status, &id, nil)
	if err != nil {
		t.Fatal(err)
	}
}

func TestShapeDiscriminatedUnion(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"shapeType":"circle","radius":2.5}`))
	})
	c := newTestClient(t, handler)
	shape, err := c.Widgets.GetShape(context.Background(), "s1")
	if err != nil {
		t.Fatal(err)
	}
	circle, ok := shape.AsCircle()
	if !ok {
		t.Fatalf("expected a circle variant, got discriminant %q", shape.Discriminant())
	}
	if circle.Radius != 2.5 {
		t.Fatalf("unexpected radius: %v", circle.Radius)
	}

	encoded, err := json.Marshal(shape)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"shapeType":"circle"`) {
		t.Fatalf("expected discriminator in encoded output, got %s", encoded)
	}
}

func TestWidgetVariantUndiscriminatedUnion(t *testing.T) {
	var a models.WidgetVariant
	if err := json.Unmarshal([]byte(`{"kind":"x","value":1}`), &a); err != nil {
		t.Fatal(err)
	}
	if v, ok := a.AsWidgetVariantA(); !ok || v.Value != 1 {
		t.Fatalf("expected WidgetVariantA, got %+v (ok=%v)", v, ok)
	}

	var b models.WidgetVariant
	if err := json.Unmarshal([]byte(`"just a string"`), &b); err != nil {
		t.Fatal(err)
	}
	if v, ok := b.AsVariant3(); !ok || v != "just a string" {
		t.Fatalf("expected the string variant, got %q (ok=%v)", v, ok)
	}

	var c2 models.WidgetVariant
	if err := json.Unmarshal([]byte(`{"note":"fallback"}`), &c2); err != nil {
		t.Fatal(err)
	}
	if v, ok := c2.AsWidgetVariantC(); !ok || v.Note == nil || *v.Note != "fallback" {
		t.Fatalf("expected WidgetVariantC, got %+v (ok=%v)", v, ok)
	}
}

func TestPetStatusEnumRejectsUnknownValue(t *testing.T) {
	var s models.PetStatus
	if err := json.Unmarshal([]byte(`"unknown-status"`), &s); err == nil {
		t.Fatal("expected an error for an unrecognized enum value")
	}
	if err := json.Unmarshal([]byte(`"available"`), &s); err != nil {
		t.Fatal(err)
	}
	if s != models.PetStatusAvailable {
		t.Fatalf("unexpected value: %v", s)
	}
}

func TestPetDateTimeField(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pet := models.Pet{Id: 1, Name: "Rex", CreatedAt: &now}
	encoded, err := json.Marshal(pet)
	if err != nil {
		t.Fatal(err)
	}
	var decoded models.Pet
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.CreatedAt == nil || !decoded.CreatedAt.Equal(now) {
		t.Fatalf("expected round-tripped createdAt %v, got %v", now, decoded.CreatedAt)
	}
}
